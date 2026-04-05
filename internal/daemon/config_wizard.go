package daemon

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type ConfigTestRequest struct {
	RepoPath string `json:"repoPath"`
	Content  string `json:"content"`
}

type ConfigTestResponse struct {
	OK           bool                      `json:"ok"`
	ServiceNames []string                  `json:"serviceNames"`
	Services     []ConfigTestServiceResult `json:"services"`
}

type ConfigSaveRequest struct {
	RepoPath string `json:"repoPath"`
	Content  string `json:"content"`
	SaveMode string `json:"saveMode"` // "repo" | "global"
}

type ConfigSaveResponse struct {
	OK         bool   `json:"ok"`
	ConfigPath string `json:"configPath"`
	SaveMode   string `json:"saveMode"`
}

type ConfigTestServiceResult struct {
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	Status           string   `json:"status"`
	URL              string   `json:"url,omitempty"`
	PreviewURL       string   `json:"previewUrl,omitempty"`
	ProbeOK          bool     `json:"probeOk"`
	ProbeStatusCode  int      `json:"probeStatusCode,omitempty"`
	ProbeBodyPreview string   `json:"probeBodyPreview,omitempty"`
	ProbeError       string   `json:"probeError,omitempty"`
	Logs             []string `json:"logs"`
}

func defaultBranchName(path string) string {
	if branch, _, err := resolveBaseRef(path, ""); err == nil && branch != "" {
		return branch
	}
	return "main"
}

func findWorktreeForBranch(path, branch string) (string, error) {
	worktrees, err := listGitWorktrees(path)
	if err != nil {
		return "", err
	}
	for _, wt := range worktrees {
		if wt.Branch == branch {
			return wt.Path, nil
		}
	}
	return "", fmt.Errorf("no checked-out worktree found for default branch %q", branch)
}

func globalRepoConfigPath(repoPath string) (string, error) {
	gitRoot, err := ValidateGitRepo(repoPath)
	if err != nil {
		return "", err
	}
	info, _, err := DetectRepoInfo(gitRoot)
	if err != nil {
		info = RemoteInfo{Provider: "local", Repo: sanitizeID(filepath.Base(gitRoot))}
	}
	name := sanitizeID(strings.ReplaceAll(info.CanonicalID(), "/", "-"))
	if name == "" {
		name = DeriveCloneID(gitRoot)
	}
	dir := filepath.Join(SpawntreeHome(), "configs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, name+".yaml"), nil
}

func writeConfigFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o600)
}

func validateConfigForWizard(repoPath, content string) error {
	envVars, err := LoadEnv("config-test", repoPath, nil)
	if err != nil {
		return err
	}
	config, err := ParseConfig([]byte(content), envVars)
	if err != nil {
		return err
	}
	if errs := ValidateConfig(config); len(errs) > 0 {
		lines := []string{"Config validation failed:"}
		for _, item := range errs {
			lines = append(lines, fmt.Sprintf("  %s: %s", item.Path, item.Message))
		}
		return fmt.Errorf("%s", strings.Join(lines, "\n"))
	}
	missing := []string{}
	for _, name := range config.OrderedServiceNames() {
		service := config.Services[string(name)]
		switch service.Type {
		case ServiceTypeProcess, ServiceTypeContainer, ServiceTypeExternal:
			if service.Healthcheck == nil || strings.TrimSpace(service.Healthcheck.URL) == "" {
				missing = append(missing, string(name))
			}
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("Add healthchecks before testing or saving. Missing: %s", strings.Join(missing, ", "))
	}
	return nil
}

func previewURLForConfigTest(service ServiceInfo) string {
	if service.Type == ServiceTypePostgres || service.Type == ServiceTypeRedis {
		return ""
	}
	if strings.HasPrefix(service.URL, "http://") || strings.HasPrefix(service.URL, "https://") {
		return service.URL
	}
	return ""
}

func probeServiceURL(url string) (ok bool, statusCode int, bodyPreview string, probeErr string) {
	if url == "" {
		return false, 0, "", ""
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return false, 0, "", err.Error()
	}
	defer func() { _ = resp.Body.Close() }()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	body = bytes.TrimSpace(body)
	return resp.StatusCode < 500, resp.StatusCode, string(body), ""
}

func collectServiceLogs(streamer *LogStreamer, repoID RepoID, envID EnvID, service string) []string {
	history, err := streamer.ReadHistory(repoID, envID, LogReadOptions{
		Service: service,
		Lines:   20,
	})
	if err != nil {
		return nil
	}
	lines := make([]string, 0, len(history))
	for _, line := range history {
		lines = append(lines, line.Line)
	}
	return lines
}

func (a *App) runConfigTest(repoPath, content string) (ConfigTestResponse, error) {
	if err := validateConfigForWizard(repoPath, content); err != nil {
		return ConfigTestResponse{}, err
	}

	tempFile, err := os.CreateTemp("", "spawntree-config-*.yaml")
	if err != nil {
		return ConfigTestResponse{}, err
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer os.Remove(tempPath)

	if err := writeConfigFile(tempPath, content); err != nil {
		return ConfigTestResponse{}, err
	}

	testEnvID := fmt.Sprintf("config-test-%d", time.Now().UnixNano())
	env, err := a.envManager.CreateEnv(
		context.Background(),
		CreateEnvRequest{
			RepoPath:   repoPath,
			EnvID:      EnvID(testEnvID),
			ConfigFile: tempPath,
		},
	)
	if err != nil {
		return ConfigTestResponse{}, err
	}
	defer func() {
		_ = a.envManager.DeleteEnv(context.Background(), string(env.RepoID), string(env.EnvID))
	}()

	time.Sleep(500 * time.Millisecond)

	serviceNames := make([]string, 0, len(env.Services))
	services := make([]ConfigTestServiceResult, 0, len(env.Services))
	for _, svc := range env.Services {
		serviceNames = append(serviceNames, string(svc.Name))
		previewURL := previewURLForConfigTest(svc)
		probeOK, statusCode, bodyPreview, probeError := probeServiceURL(previewURL)
		services = append(services, ConfigTestServiceResult{
			Name:             string(svc.Name),
			Type:             string(svc.Type),
			Status:           string(svc.Status),
			URL:              svc.URL,
			PreviewURL:       previewURL,
			ProbeOK:          probeOK,
			ProbeStatusCode:  statusCode,
			ProbeBodyPreview: bodyPreview,
			ProbeError:       probeError,
			Logs:             collectServiceLogs(a.logStreamer, env.RepoID, env.EnvID, string(svc.Name)),
		})
	}

	return ConfigTestResponse{
		OK:           true,
		ServiceNames: serviceNames,
		Services:     services,
	}, nil
}
