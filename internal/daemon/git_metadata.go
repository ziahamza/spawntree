package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type GitPathInfo struct {
	Branch               string `json:"branch"`
	HeadRef              string `json:"headRef"`
	ActivityAt           string `json:"activityAt"`
	Insertions           int    `json:"insertions"`
	Deletions            int    `json:"deletions"`
	HasUncommittedChange bool   `json:"hasUncommittedChanges"`
	IsMergedIntoBase     bool   `json:"isMergedIntoBase"`
	IsBaseOutOfDate      bool   `json:"isBaseOutOfDate"`
	IsBaseBranch         bool   `json:"isBaseBranch"`
	CanArchive           bool   `json:"canArchive"`
	BaseRefName          string `json:"baseRefName,omitempty"`
}

func inspectGitPath(path, defaultBranch string, hasPathEnvs bool) (GitPathInfo, error) {
	if _, err := ValidateGitRepo(path); err != nil {
		return GitPathInfo{}, err
	}

	branch := CurrentBranch(path)
	headRef, err := gitOutput(path, "rev-parse", "HEAD")
	if err != nil {
		return GitPathInfo{}, err
	}

	baseRefName, baseRefResolved, err := resolveBaseRef(path, defaultBranch)
	if err != nil {
		return GitPathInfo{}, err
	}

	mergeBase := ""
	insertions := 0
	deletions := 0
	isMergedIntoBase := false
	isBaseOutOfDate := false
	isBaseBranch := branch == baseRefName

	if baseRefResolved != "" {
		mergeBase, _ = gitOutput(path, "merge-base", "HEAD", baseRefResolved)
		insertions, deletions, _ = diffStatAgainstBase(path, mergeBase)

		baseHead, _ := gitOutput(path, "rev-parse", baseRefResolved)
		if isBaseBranch {
			isBaseOutOfDate = headRef != "" && baseHead != "" && headRef != baseHead
		} else {
			isBaseOutOfDate = mergeBase != "" && baseHead != "" && mergeBase != baseHead
			isMergedIntoBase = gitIsAncestor(path, "HEAD", baseRefResolved)
		}
	}

	statusOutput, _ := gitOutputAllowEmpty(path, "status", "--porcelain", "--untracked-files=all")
	hasUncommittedChange := strings.TrimSpace(statusOutput) != ""
	activityAt := estimateGitActivityAt(path, headRef, statusOutput)

	return GitPathInfo{
		Branch:               branch,
		HeadRef:              headRef,
		ActivityAt:           activityAt,
		Insertions:           insertions,
		Deletions:            deletions,
		HasUncommittedChange: hasUncommittedChange,
		IsMergedIntoBase:     isMergedIntoBase,
		IsBaseOutOfDate:      isBaseOutOfDate,
		IsBaseBranch:         isBaseBranch,
		CanArchive:           !isPrimaryWorktreePath(path) && !hasPathEnvs && isMergedIntoBase && !hasUncommittedChange,
		BaseRefName:          displayBaseRefName(baseRefResolved, baseRefName),
	}, nil
}

func resolveBaseRef(path, defaultBranch string) (branchName, resolvedRef string, err error) {
	candidates := []struct {
		branch string
		ref    string
	}{}

	addCandidates := func(branch string) {
		if branch == "" {
			return
		}
		candidates = append(candidates,
			struct {
				branch string
				ref    string
			}{branch: branch, ref: "refs/remotes/upstream/" + branch},
			struct {
				branch string
				ref    string
			}{branch: branch, ref: "refs/remotes/origin/" + branch},
			struct {
				branch string
				ref    string
			}{branch: branch, ref: "refs/heads/" + branch},
		)
	}

	addCandidates(defaultBranch)
	addCandidates("main")
	addCandidates("master")

	seen := map[string]bool{}
	for _, candidate := range candidates {
		if seen[candidate.ref] {
			continue
		}
		seen[candidate.ref] = true
		if gitRefExists(path, candidate.ref) {
			return candidate.branch, candidate.ref, nil
		}
	}
	return "", "", nil
}

func gitRefExists(path, ref string) bool {
	cmd := exec.Command("git", "rev-parse", "--verify", "--quiet", ref)
	cmd.Dir = path
	return cmd.Run() == nil
}

func gitIsAncestor(path, fromRef, toRef string) bool {
	cmd := exec.Command("git", "merge-base", "--is-ancestor", fromRef, toRef)
	cmd.Dir = path
	return cmd.Run() == nil
}

func diffStatAgainstBase(path, mergeBase string) (int, int, error) {
	if mergeBase == "" {
		return 0, 0, nil
	}
	out, err := gitOutputAllowEmpty(path, "diff", "--numstat", mergeBase, "HEAD")
	if err != nil {
		return 0, 0, err
	}

	insertions := 0
	deletions := 0
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[0] != "-" {
			if n, err := strconv.Atoi(fields[0]); err == nil {
				insertions += n
			}
		}
		if fields[1] != "-" {
			if n, err := strconv.Atoi(fields[1]); err == nil {
				deletions += n
			}
		}
	}

	return insertions, deletions, nil
}

func estimateGitActivityAt(path, headRef, statusOutput string) string {
	latest := time.Time{}

	if headRef != "" {
		if unixRaw, err := gitOutput(path, "log", "-1", "--format=%ct", "HEAD"); err == nil {
			if unix, err := strconv.ParseInt(strings.TrimSpace(unixRaw), 10, 64); err == nil {
				latest = maxTime(latest, time.Unix(unix, 0).UTC())
			}
		}
	}

	if gitDir, err := gitOutput(path, "rev-parse", "--git-dir"); err == nil {
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(path, gitDir)
		}
		latest = maxTime(latest, fileModTime(filepath.Join(gitDir, "index")))
		latest = maxTime(latest, fileModTime(filepath.Join(gitDir, "logs", "HEAD")))
	}

	for _, candidate := range changedFilesFromPorcelain(path, statusOutput) {
		latest = maxTime(latest, fileModTime(candidate))
	}

	if latest.IsZero() {
		latest = time.Now().UTC()
	}
	return latest.Format(time.RFC3339)
}

func changedFilesFromPorcelain(root, statusOutput string) []string {
	seen := map[string]bool{}
	paths := []string{}

	for _, line := range strings.Split(strings.TrimSpace(statusOutput), "\n") {
		line = strings.TrimSpace(line)
		if len(line) < 4 {
			continue
		}
		pathPart := strings.TrimSpace(line[3:])
		if idx := strings.LastIndex(pathPart, " -> "); idx >= 0 {
			pathPart = pathPart[idx+4:]
		}
		pathPart = strings.Trim(pathPart, "\"")
		if pathPart == "" {
			continue
		}
		abs := filepath.Join(root, filepath.Clean(pathPart))
		if seen[abs] {
			continue
		}
		seen[abs] = true
		paths = append(paths, abs)
	}

	return paths
}

func fileModTime(path string) time.Time {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime().UTC()
}

func maxTime(a, b time.Time) time.Time {
	if a.IsZero() {
		return b
	}
	if b.After(a) {
		return b
	}
	return a
}

func displayBaseRefName(resolvedRef, branch string) string {
	if resolvedRef == "" {
		return branch
	}
	for _, prefix := range []string{"refs/remotes/", "refs/heads/"} {
		if strings.HasPrefix(resolvedRef, prefix) {
			return strings.TrimPrefix(resolvedRef, prefix)
		}
	}
	return resolvedRef
}

func gitOutputAllowEmpty(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		trimmed := strings.TrimSpace(string(output))
		if trimmed == "" {
			return "", fmt.Errorf("git %s failed", strings.Join(args, " "))
		}
		return "", fmt.Errorf("%s", trimmed)
	}
	return strings.TrimSpace(string(output)), nil
}

func removeGitWorktree(path string) error {
	if isPrimaryWorktreePath(path) {
		return fmt.Errorf("cannot archive the primary clone")
	}

	worktrees, err := listGitWorktrees(path)
	if err != nil {
		return err
	}
	execDir := ""
	for _, wt := range worktrees {
		if isPrimaryWorktreePath(wt.Path) {
			execDir = wt.Path
			break
		}
	}
	if execDir == "" {
		for _, wt := range worktrees {
			if filepath.Clean(wt.Path) != filepath.Clean(path) {
				execDir = wt.Path
				break
			}
		}
	}
	if execDir == "" {
		if repoRoot, err := ValidateGitRepo(path); err == nil {
			execDir = repoRoot
		}
	}
	if execDir == "" {
		return fmt.Errorf("could not locate a git worktree to run archive from")
	}

	cmd := exec.Command("git", "worktree", "remove", path)
	cmd.Dir = execDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to archive worktree: %s", strings.TrimSpace(string(output)))
	}

	prune := exec.Command("git", "worktree", "prune")
	prune.Dir = execDir
	_, _ = prune.CombinedOutput()
	return nil
}

func isPrimaryWorktreePath(path string) bool {
	info, err := os.Stat(filepath.Join(path, ".git"))
	return err == nil && info.IsDir()
}
