package daemon

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type WorktreeManager struct {
	RepoRoot string
}

func NewWorktreeManager(repoRoot string) *WorktreeManager {
	return &WorktreeManager{RepoRoot: repoRoot}
}

func ValidateGitRepo(dir string) (string, error) {
	return gitOutput(dir, "rev-parse", "--show-toplevel")
}

func CurrentBranch(dir string) string {
	out, err := gitOutput(dir, "branch", "--show-current")
	if err != nil || out == "" {
		return "detached"
	}
	return out
}

func (w *WorktreeManager) EnsureGitignore() error {
	gitignorePath := filepath.Join(w.RepoRoot, ".gitignore")
	excludePath := filepath.Join(w.RepoRoot, ".git", "info", "exclude")
	target := gitignorePath
	if _, err := os.Stat(gitignorePath); err != nil {
		target = excludePath
	}
	content, _ := os.ReadFile(target)
	if bytes.Contains(content, []byte(".spawntree/")) {
		return nil
	}
	f, err := os.OpenFile(target, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString("\n.spawntree/\n")
	return err
}

func (w *WorktreeManager) Create(envName string) (string, error) {
	path := filepath.Join(w.RepoRoot, ".spawntree", "envs", envName)
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	cmd := exec.Command("git", "worktree", "add", path, "HEAD", "--detach")
	cmd.Dir = w.RepoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to create worktree for %q: %s", envName, strings.TrimSpace(string(output)))
	}
	return path, nil
}

func (w *WorktreeManager) Remove(envName string) error {
	path := filepath.Join(w.RepoRoot, ".spawntree", "envs", envName)
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	cmd := exec.Command("git", "worktree", "remove", path, "--force")
	cmd.Dir = w.RepoRoot
	if output, err := cmd.CombinedOutput(); err != nil {
		_ = os.RemoveAll(path)
		prune := exec.Command("git", "worktree", "prune")
		prune.Dir = w.RepoRoot
		_, _ = prune.CombinedOutput()
		if len(output) > 0 {
			return errors.New(strings.TrimSpace(string(output)))
		}
	}
	return nil
}

// GitWorktreeInfo holds parsed output from `git worktree list --porcelain`.
type GitWorktreeInfo struct {
	Path    string
	Branch  string
	HeadRef string
}

// listGitWorktrees runs `git worktree list --porcelain` and parses the output.
func listGitWorktrees(dir string) ([]GitWorktreeInfo, error) {
	out, err := gitOutput(dir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	if out == "" {
		return nil, nil
	}

	var worktrees []GitWorktreeInfo
	var current GitWorktreeInfo

	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			if current.Path != "" {
				worktrees = append(worktrees, current)
			}
			current = GitWorktreeInfo{Path: strings.TrimPrefix(line, "worktree ")}
		case strings.HasPrefix(line, "HEAD "):
			current.HeadRef = strings.TrimPrefix(line, "HEAD ")
		case strings.HasPrefix(line, "branch "):
			ref := strings.TrimPrefix(line, "branch ")
			// Strip refs/heads/ prefix
			current.Branch = strings.TrimPrefix(ref, "refs/heads/")
		case line == "detached":
			current.Branch = ""
		}
	}
	if current.Path != "" {
		worktrees = append(worktrees, current)
	}

	return worktrees, nil
}

func gitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", errors.New(strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}
