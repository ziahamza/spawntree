package daemon

import (
	"context"
	"fmt"
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
	OK           bool     `json:"ok"`
	ServiceNames []string `json:"serviceNames"`
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

func (a *App) runConfigTest(repoPath, content string) (ConfigTestResponse, error) {
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

	serviceNames := make([]string, 0, len(env.Services))
	for _, svc := range env.Services {
		serviceNames = append(serviceNames, string(svc.Name))
	}

	return ConfigTestResponse{
		OK:           true,
		ServiceNames: serviceNames,
	}, nil
}
