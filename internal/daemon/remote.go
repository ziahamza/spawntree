package daemon

import (
	"fmt"
	"net/url"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// RemoteInfo holds parsed remote URL information.
type RemoteInfo struct {
	Provider string // "github" | "gitlab" | "bitbucket" | "local"
	Owner    string // org/user name
	Repo     string // repo name
	URL      string // full remote URL
}

// CanonicalID returns the canonical repo identifier (e.g., "github/org/repo").
func (r RemoteInfo) CanonicalID() string {
	if r.Provider == "local" {
		return fmt.Sprintf("local/%s", r.Repo)
	}
	return fmt.Sprintf("%s/%s/%s", r.Provider, r.Owner, r.Repo)
}

// Slug returns a URL-safe slug (e.g., "github-org-repo").
func (r RemoteInfo) Slug() string {
	return sanitizeID(strings.ReplaceAll(r.CanonicalID(), "/", "-"))
}

var sshRemotePattern = regexp.MustCompile(`^[\w.-]+@([\w.-]+):([\w./-]+?)(?:\.git)?$`)

// ParseRemoteURL parses a git remote URL into provider, owner, and repo.
// Supports HTTPS and SSH formats for GitHub, GitLab, and Bitbucket.
func ParseRemoteURL(rawURL string) RemoteInfo {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return RemoteInfo{Provider: "local"}
	}

	var host, path string

	// Try SSH format: git@github.com:org/repo.git
	if matches := sshRemotePattern.FindStringSubmatch(rawURL); matches != nil {
		host = matches[1]
		path = matches[2]
	} else {
		// Try HTTPS format
		parsed, err := url.Parse(rawURL)
		if err != nil || parsed.Host == "" {
			return RemoteInfo{Provider: "local", URL: rawURL}
		}
		host = parsed.Hostname()
		path = strings.TrimPrefix(parsed.Path, "/")
		path = strings.TrimSuffix(path, ".git")
	}

	provider := hostToProvider(host)
	parts := strings.SplitN(path, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return RemoteInfo{Provider: provider, Repo: filepath.Base(path), URL: rawURL}
	}

	return RemoteInfo{
		Provider: provider,
		Owner:    parts[0],
		Repo:     parts[1],
		URL:      rawURL,
	}
}

func hostToProvider(host string) string {
	host = strings.ToLower(host)
	switch {
	case strings.Contains(host, "github"):
		return "github"
	case strings.Contains(host, "gitlab"):
		return "gitlab"
	case strings.Contains(host, "bitbucket"):
		return "bitbucket"
	default:
		return "git"
	}
}

// GitRemote represents a named git remote.
type GitRemote struct {
	Name string
	URL  string
}

// DetectRemotes runs `git remote -v` in the given directory and returns fetch remotes.
func DetectRemotes(dir string) ([]GitRemote, error) {
	cmd := exec.Command("git", "remote", "-v")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git remote -v: %w", err)
	}

	seen := map[string]bool{}
	var remotes []GitRemote
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		// Format: "origin\thttps://github.com/org/repo.git (fetch)"
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		name := parts[0]
		remoteURL := parts[1]
		// Only take fetch URLs, deduplicate
		if len(parts) >= 3 && strings.Contains(parts[2], "push") {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		remotes = append(remotes, GitRemote{Name: name, URL: remoteURL})
	}
	return remotes, nil
}

// DetectRepoInfo detects the canonical repo info for a local directory.
// If a single remote exists, uses it automatically. If multiple remotes exist,
// returns all of them so the caller can ask the user to pick.
// If no remotes exist, falls back to "local/<dirname>".
func DetectRepoInfo(dir string) (RemoteInfo, []GitRemote, error) {
	remotes, _ := DetectRemotes(dir)
	if len(remotes) == 0 {
		// No remotes (or git error), use local identity
		name := filepath.Base(dir)
		return RemoteInfo{
			Provider: "local",
			Repo:     sanitizeID(strings.ToLower(name)),
		}, nil, nil
	}

	if len(remotes) == 1 {
		info := ParseRemoteURL(remotes[0].URL)
		return info, remotes, nil
	}

	// Multiple remotes: prefer "origin", but return all for user choice
	for _, r := range remotes {
		if r.Name == "origin" {
			info := ParseRemoteURL(r.URL)
			return info, remotes, nil
		}
	}

	// No "origin", use first remote
	info := ParseRemoteURL(remotes[0].URL)
	return info, remotes, nil
}

// TryGHMetadata attempts to enrich repo info using the gh CLI.
// Returns the default branch and description if successful.
// This is optional enrichment; errors are silently ignored.
var safeGHName = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

func TryGHMetadata(owner, repo string) (defaultBranch, description string) {
	if !safeGHName.MatchString(owner) || !safeGHName.MatchString(repo) {
		return "", ""
	}
	if _, err := exec.LookPath("gh"); err != nil {
		return "", ""
	}

	apiPath := fmt.Sprintf("repos/%s/%s", owner, repo)
	cmd := exec.Command("gh", "api", apiPath, //nolint:gosec // owner and repo validated by safeGHName regex above
		"--jq", ".default_branch + \"\\n\" + (.description // \"\")")
	out, err := cmd.Output()
	if err != nil {
		return "", ""
	}

	lines := strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)
	if len(lines) >= 1 {
		defaultBranch = lines[0]
	}
	if len(lines) >= 2 {
		description = lines[1]
	}
	return defaultBranch, description
}
