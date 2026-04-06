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

	"gopkg.in/yaml.v3"
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

type ConfigPreviewRequest struct {
	RepoPath    string `json:"repoPath"`
	Content     string `json:"content"`
	ServiceName string `json:"serviceName,omitempty"`
}

type ConfigPreviewResponse struct {
	OK        bool    `json:"ok"`
	PreviewID string  `json:"previewId"`
	Env       EnvInfo `json:"env"`
}

type ConfigPreviewStopRequest struct {
	PreviewID string `json:"previewId"`
}

type ConfigPreviewSession struct {
	ID          string
	RepoID      string
	EnvID       string
	RepoPath    string
	ConfigPath  string
	ServiceName string
	Env         EnvInfo
	Cancel      context.CancelFunc
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
		return fmt.Errorf("add healthchecks before testing or saving. missing: %s", strings.Join(missing, ", "))
	}
	return nil
}

func previewSessionID() string {
	return fmt.Sprintf("config-preview-%d", time.Now().UnixNano())
}

func previewConfigContent(repoPath, content, serviceName string) (string, error) {
	if strings.TrimSpace(serviceName) == "" {
		return content, nil
	}

	envVars, err := LoadEnv("config-preview", repoPath, nil)
	if err != nil {
		return "", err
	}
	config, err := ParseConfig([]byte(content), envVars)
	if err != nil {
		return "", err
	}
	if _, ok := config.Services[serviceName]; !ok {
		return "", fmt.Errorf("service %q not found", serviceName)
	}

	selected := map[string]bool{}
	var visit func(string)
	visit = func(name string) {
		if selected[name] {
			return
		}
		selected[name] = true
		for _, dep := range config.Services[name].DependsOn {
			if _, ok := config.Services[dep]; ok {
				visit(dep)
			}
		}
	}
	visit(serviceName)

	filtered := struct {
		Proxy    *ProxySettings           `yaml:"proxy,omitempty"`
		Services map[string]ServiceConfig `yaml:"services"`
	}{
		Proxy:    config.Proxy,
		Services: map[string]ServiceConfig{},
	}
	for _, name := range config.OrderedServiceNames() {
		if selected[string(name)] {
			filtered.Services[string(name)] = config.Services[string(name)]
		}
	}

	out, err := yaml.Marshal(filtered)
	if err != nil {
		return "", err
	}
	return string(out), nil
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

func buildProvisionalPreviewEnv(a *App, repoPath, content, serviceName string) (EnvInfo, error) {
	repoPath, err := normalizeInputPath(repoPath)
	if err != nil {
		return EnvInfo{}, err
	}
	gitRoot, err := ValidateGitRepo(repoPath)
	if err != nil {
		return EnvInfo{}, err
	}
	branch := BranchName(CurrentBranch(repoPath))
	repoID := DeriveRepoID(gitRoot)
	envID := EnvID(previewSessionID())

	envVars, err := LoadEnv(string(envID), repoPath, nil)
	if err != nil {
		return EnvInfo{}, err
	}
	config, err := ParseConfig([]byte(content), envVars)
	if err != nil {
		return EnvInfo{}, err
	}
	basePort, err := a.envManager.portRegistry.Allocate(NewEnvKey(repoID, envID))
	if err != nil {
		return EnvInfo{}, err
	}

	services := make([]ServiceInfo, 0)
	for _, name := range config.OrderedServiceNames() {
		serviceConfig := config.Services[string(name)]
		if serviceConfig.Type == ServiceTypePostgres || serviceConfig.Type == ServiceTypeRedis {
			continue
		}
		port, err := a.envManager.portRegistry.GetPhysicalPort(basePort, indexOfService(config.OrderedServiceNames(), name))
		if err != nil {
			return EnvInfo{}, err
		}
		url := fmt.Sprintf("http://127.0.0.1:%d", port)
		if serviceConfig.Type == ServiceTypeExternal {
			url = serviceConfig.URL
		} else if a.envManager.proxy.IsRunning() {
			url = fmt.Sprintf("http://%s:%d", serviceRouteHost(name, envID), a.envManager.proxy.Port())
		}
		_ = a.logStreamer.InitService(repoID, envID, string(name))
		a.logStreamer.AddLine(repoID, envID, string(name), "system", "[spawntree] Starting preview...")
		services = append(services, ServiceInfo{
			Name:   name,
			Type:   serviceConfig.Type,
			Status: ServiceStatusStarting,
			Port:   port,
			URL:    url,
		})
	}

	return EnvInfo{
		EnvID:     envID,
		RepoID:    repoID,
		RepoPath:  repoPath,
		Branch:    branch,
		BasePort:  basePort,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Services:  services,
	}, nil
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
			RepoPath:           repoPath,
			EnvID:              EnvID(testEnvID),
			ConfigFile:         tempPath,
			UseCurrentCheckout: true,
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

func (a *App) stopPreviewSession(id string) error {
	a.previewMu.Lock()
	session, ok := a.previewSessions[id]
	if ok {
		delete(a.previewSessions, id)
	}
	a.previewMu.Unlock()
	if !ok {
		return nil
	}
	if session.Cancel != nil {
		session.Cancel()
	}
	_ = a.envManager.DeleteEnv(context.Background(), session.RepoID, session.EnvID)
	_ = a.envManager.portRegistry.Free(NewEnvKey(RepoID(session.RepoID), EnvID(session.EnvID)))
	a.logStreamer.CloseEnv(RepoID(session.RepoID), EnvID(session.EnvID))
	return nil
}

func (a *App) startPreviewSession(repoPath, content, serviceName string) (ConfigPreviewResponse, error) {
	if err := validateConfigForWizard(repoPath, content); err != nil {
		return ConfigPreviewResponse{}, err
	}

	a.previewMu.Lock()
	idsToStop := make([]string, 0)
	for id, session := range a.previewSessions {
		if session.RepoPath == repoPath && session.ServiceName == serviceName {
			idsToStop = append(idsToStop, id)
		}
	}
	a.previewMu.Unlock()
	for _, id := range idsToStop {
		_ = a.stopPreviewSession(id)
	}

	tempFile, err := os.CreateTemp("", "spawntree-config-preview-*.yaml")
	if err != nil {
		return ConfigPreviewResponse{}, err
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	previewContent, err := previewConfigContent(repoPath, content, serviceName)
	if err != nil {
		_ = os.Remove(tempPath)
		return ConfigPreviewResponse{}, err
	}
	if err := writeConfigFile(tempPath, previewContent); err != nil {
		_ = os.Remove(tempPath)
		return ConfigPreviewResponse{}, err
	}

	env, err := buildProvisionalPreviewEnv(a, repoPath, previewContent, serviceName)
	if err != nil {
		_ = os.Remove(tempPath)
		return ConfigPreviewResponse{}, err
	}

	session := ConfigPreviewSession{
		ID:          string(env.EnvID),
		RepoID:      string(env.RepoID),
		EnvID:       string(env.EnvID),
		RepoPath:    env.RepoPath,
		ConfigPath:  tempPath,
		ServiceName: serviceName,
		Env:         env,
	}
	previewCtx, cancel := context.WithCancel(context.Background())
	session.Cancel = cancel
	a.previewMu.Lock()
	a.previewSessions[session.ID] = session
	a.previewMu.Unlock()

	go func(previewEnv EnvInfo, configPath string, ctx context.Context) {
		defer func() {
			_ = os.Remove(configPath)
		}()
		realEnv, err := a.envManager.CreateEnv(
			ctx,
			CreateEnvRequest{
				RepoPath:           previewEnv.RepoPath,
				EnvID:              previewEnv.EnvID,
				ConfigFile:         configPath,
				UseCurrentCheckout: true,
			},
		)
		if err != nil {
			for _, service := range previewEnv.Services {
				a.logStreamer.AddLine(previewEnv.RepoID, previewEnv.EnvID, string(service.Name), "system", fmt.Sprintf("[spawntree] Preview failed: %s", err.Error()))
			}
			return
		}
		a.previewMu.Lock()
		current, ok := a.previewSessions[string(previewEnv.EnvID)]
		if ok {
			current.Env = realEnv
			a.previewSessions[string(previewEnv.EnvID)] = current
			a.previewMu.Unlock()
			return
		}
		a.previewMu.Unlock()
		_ = a.envManager.DeleteEnv(context.Background(), string(realEnv.RepoID), string(realEnv.EnvID))
	}(env, tempPath, previewCtx)

	return ConfigPreviewResponse{
		OK:        true,
		PreviewID: session.ID,
		Env:       session.Env,
	}, nil
}
