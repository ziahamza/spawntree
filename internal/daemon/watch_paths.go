package daemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const watchedPathScanInterval = 30 * time.Second

type PathProbeResult struct {
	Path            string `json:"path"`
	Exists          bool   `json:"exists"`
	IsGitRepo       bool   `json:"isGitRepo"`
	CanScanChildren bool   `json:"canScanChildren"`
	ChildRepoCount  int    `json:"childRepoCount"`
}

func normalizeInputPath(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("path is required")
	}
	abs, err := filepath.Abs(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}
	return abs, nil
}

func probePath(raw string) (PathProbeResult, error) {
	path, err := normalizeInputPath(raw)
	if err != nil {
		return PathProbeResult{}, err
	}

	result := PathProbeResult{Path: path}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
		return result, err
	}
	if !info.IsDir() {
		return result, fmt.Errorf("path is not a directory")
	}
	result.Exists = true

	if gitRoot, err := ValidateGitRepo(path); err == nil {
		result.IsGitRepo = true
		result.Path = filepath.Clean(gitRoot)
		return result, nil
	}

	result.CanScanChildren = true
	children, err := findImmediateGitRepos(path)
	if err == nil {
		result.ChildRepoCount = len(children)
	}
	return result, nil
}

func findImmediateGitRepos(parent string) ([]string, error) {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	repos := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		child := filepath.Join(parent, entry.Name())
		normalizedChild, err := normalizeInputPath(child)
		if err != nil {
			continue
		}
		gitRoot, err := ValidateGitRepo(child)
		if err != nil {
			continue
		}
		gitRoot, err = normalizeInputPath(gitRoot)
		if err != nil {
			continue
		}
		if gitRoot != normalizedChild || seen[gitRoot] {
			continue
		}
		seen[gitRoot] = true
		repos = append(repos, gitRoot)
	}
	sort.Strings(repos)
	return repos, nil
}

func (a *App) syncWatchedPaths(force bool) error {
	if a.db == nil {
		return nil
	}

	watchedPaths, err := a.db.ListWatchedPaths()
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	for _, watched := range watchedPaths {
		if !force && watched.LastScannedAt != "" {
			if last, err := time.Parse(time.RFC3339, watched.LastScannedAt); err == nil && now.Sub(last) < watchedPathScanInterval {
				continue
			}
		}

		scanErr := ""
		if _, err := a.syncWatchedPath(watched); err != nil {
			scanErr = err.Error()
		}
		_ = a.db.UpdateWatchedPathScan(watched.Path, now.Format(time.RFC3339), scanErr)
	}

	return nil
}

func (a *App) syncWatchedPath(watched WatchedPath) (int, error) {
	probe, err := probePath(watched.Path)
	if err != nil {
		return 0, err
	}
	if !probe.Exists {
		return 0, fmt.Errorf("path not found")
	}

	imported := 0
	if probe.IsGitRepo {
		if _, _, _, err := a.importGitRepoPath(probe.Path, "", false); err != nil {
			return imported, err
		}
		imported++
	}
	if !probe.IsGitRepo && watched.ScanChildren {
		repos, err := findImmediateGitRepos(watched.Path)
		if err != nil {
			return imported, err
		}
		for _, repoPath := range repos {
			if _, _, _, err := a.importGitRepoPath(repoPath, "", false); err == nil {
				imported++
			}
		}
	}

	return imported, nil
}

func (a *App) importGitRepoPath(gitRoot, remoteName string, requireRemotePick bool) (*Repo, *Clone, []GitRemote, error) {
	info, remotes, err := DetectRepoInfo(gitRoot)
	if err != nil {
		info = RemoteInfo{Provider: "local", Repo: sanitizeID(filepath.Base(gitRoot))}
	}

	if requireRemotePick && len(remotes) > 1 && remoteName == "" {
		return nil, nil, remotes, nil
	}

	if len(remotes) > 1 && remoteName != "" {
		found := false
		for _, rm := range remotes {
			if rm.Name == remoteName {
				info = ParseRemoteURL(rm.URL)
				found = true
				break
			}
		}
		if !found {
			return nil, nil, nil, fmt.Errorf("remote %q not found", remoteName)
		}
	}

	repo := Repo{
		ID:        info.CanonicalID(),
		Slug:      info.Slug(),
		Name:      info.Repo,
		Provider:  info.Provider,
		Owner:     info.Owner,
		RemoteURL: info.URL,
	}
	if info.Provider == "github" && info.Owner != "" && info.Repo != "" {
		repo.DefaultBranch, repo.Description = TryGHMetadata(info.Owner, info.Repo)
	}
	if err := a.db.UpsertRepo(repo); err != nil {
		return nil, nil, nil, err
	}

	clone := Clone{
		ID:     DeriveCloneID(gitRoot),
		RepoID: repo.ID,
		Path:   gitRoot,
		Status: "active",
	}
	if err := a.db.UpsertClone(clone); err != nil {
		return nil, nil, nil, err
	}
	if _, _, err := a.syncCloneWorktrees(clone); err != nil {
		return nil, nil, nil, err
	}
	_, _ = a.registryManager.RegisterRepo(gitRoot, "spawntree.yaml")

	return &repo, &clone, nil, nil
}
