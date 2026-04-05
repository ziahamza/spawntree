package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type ConfigSuggestRequest struct {
	RepoPath string `json:"repoPath"`
}

type ConfigSignal struct {
	Kind   string `json:"kind"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
}

type ConfigServiceSuggestion struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Type      string   `json:"type"`
	Command   string   `json:"command,omitempty"`
	Image     string   `json:"image,omitempty"`
	Port      int      `json:"port,omitempty"`
	DependsOn []string `json:"dependsOn,omitempty"`
	Source    string   `json:"source,omitempty"`
	Reason    string   `json:"reason,omitempty"`
	Selected  bool     `json:"selected"`
}

type ConfigSuggestResponse struct {
	Signals  []ConfigSignal            `json:"signals"`
	Services []ConfigServiceSuggestion `json:"services"`
}

type packageJSONFile struct {
	Name           string            `json:"name"`
	PackageManager string            `json:"packageManager"`
	Scripts        map[string]string `json:"scripts"`
	Workspaces     any               `json:"workspaces"`
}

type packageCandidate struct {
	Dir     string
	RelDir  string
	Name    string
	Scripts map[string]string
	IsRoot  bool
}

type composeFile struct {
	Path     string
	RelPath  string
	Services map[string]composeService
}

type composeService struct {
	Image     string
	Ports     []string
	HasHealth bool
}

var explicitPortPatterns = []*regexp.Regexp{
	regexp.MustCompile(`--port(?:=|\s+)(\d{2,5})`),
	regexp.MustCompile(`--ui-port(?:=|\s+)(\d{2,5})`),
	regexp.MustCompile(`(?:^|\s)-p\s*(\d{2,5})(?:\s|$)`),
	regexp.MustCompile(`(?:^|\s)-p(\d{2,5})(?:\s|$)`),
	regexp.MustCompile(`PORT=(\d{2,5})`),
}

func (a *App) handleWebSuggestConfig(w http.ResponseWriter, r *http.Request) {
	var req ConfigSuggestRequest
	if err := decodeJSON(r, &req); err != nil || req.RepoPath == "" {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "repoPath is required", nil)
		return
	}
	resp, err := suggestConfig(req.RepoPath)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func suggestConfig(repoPath string) (ConfigSuggestResponse, error) {
	root, err := normalizeInputPath(repoPath)
	if err != nil {
		return ConfigSuggestResponse{}, err
	}
	info, err := os.Stat(root)
	if err != nil {
		return ConfigSuggestResponse{}, err
	}
	if !info.IsDir() {
		return ConfigSuggestResponse{}, fmt.Errorf("path is not a directory")
	}

	signals := collectConfigSignals(root)
	manager := detectPackageManager(root)
	rootPkg, packageCandidates := discoverPackageCandidates(root)
	composeFiles := discoverComposeFiles(root)

	suggestions := []ConfigServiceSuggestion{}
	seen := map[string]bool{}

	composeSuggestions := suggestComposeServices(root, composeFiles)
	for _, suggestion := range composeSuggestions {
		key := suggestionKey(suggestion)
		if seen[key] {
			continue
		}
		seen[key] = true
		suggestions = append(suggestions, suggestion)
	}

	packageSuggestions := suggestPackageServices(root, manager, rootPkg, packageCandidates, composeFiles)
	for _, suggestion := range packageSuggestions {
		key := suggestionKey(suggestion)
		if seen[key] {
			continue
		}
		seen[key] = true
		suggestions = append(suggestions, suggestion)
	}

	wireSuggestionDependencies(suggestions)
	selectDefaultSuggestions(suggestions)
	sortSuggestions(root, suggestions)

	return ConfigSuggestResponse{
		Signals:  signals,
		Services: suggestions,
	}, nil
}

func collectConfigSignals(root string) []ConfigSignal {
	signals := []ConfigSignal{}

	if manager := detectPackageManager(root); manager != "" {
		signals = append(signals, ConfigSignal{Kind: "package-manager", Label: manager, Detail: "detected package manager"})
	}
	for _, file := range []struct {
		name  string
		label string
	}{
		{name: ".mise.toml", label: "mise"},
		{name: "mise.toml", label: "mise"},
	} {
		path := filepath.Join(root, file.name)
		if _, err := os.Stat(path); err == nil {
			if tools := parseMiseTools(path); len(tools) > 0 {
				signals = append(signals, ConfigSignal{Kind: "toolchain", Label: file.label, Detail: strings.Join(tools, ", ")})
			} else {
				signals = append(signals, ConfigSignal{Kind: "toolchain", Label: file.label, Detail: "detected tool versions"})
			}
			break
		}
	}
	for _, file := range []struct {
		name  string
		label string
	}{
		{name: ".nvmrc", label: ".nvmrc"},
		{name: ".node-version", label: ".node-version"},
	} {
		path := filepath.Join(root, file.name)
		if content, err := os.ReadFile(path); err == nil {
			signals = append(signals, ConfigSignal{
				Kind:   "toolchain",
				Label:  file.label,
				Detail: strings.TrimSpace(string(content)),
			})
		}
	}
	for _, name := range []string{"pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"} {
		path := filepath.Join(root, name)
		if _, err := os.Stat(path); err == nil {
			signals = append(signals, ConfigSignal{Kind: "workspace", Label: name, Detail: "monorepo/workspace signal"})
		}
	}
	for _, name := range []string{"docker-compose.yml", "docker-compose.yaml"} {
		path := filepath.Join(root, name)
		if _, err := os.Stat(path); err == nil {
			signals = append(signals, ConfigSignal{Kind: "compose", Label: name, Detail: "docker compose config"})
		}
	}

	return signals
}

func parseMiseTools(path string) []string {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	lines := strings.Split(string(content), "\n")
	inTools := false
	tools := []string{}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			inTools = trimmed == "[tools]"
			continue
		}
		if !inTools {
			continue
		}
		parts := strings.SplitN(trimmed, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.Trim(strings.TrimSpace(parts[1]), "\"'")
		if key != "" && value != "" {
			tools = append(tools, fmt.Sprintf("%s %s", key, value))
		}
	}
	sort.Strings(tools)
	return tools
}

func detectPackageManager(root string) string {
	if pkgPath := filepath.Join(root, "package.json"); fileExists(pkgPath) {
		var pkg packageJSONFile
		if content, err := os.ReadFile(pkgPath); err == nil && json.Unmarshal(content, &pkg) == nil {
			if pkg.PackageManager != "" {
				if idx := strings.Index(pkg.PackageManager, "@"); idx > 0 {
					return pkg.PackageManager[:idx]
				}
				return pkg.PackageManager
			}
		}
	}

	switch {
	case fileExists(filepath.Join(root, "pnpm-lock.yaml")):
		return "pnpm"
	case fileExists(filepath.Join(root, "bun.lockb")) || fileExists(filepath.Join(root, "bun.lock")):
		return "bun"
	case fileExists(filepath.Join(root, "yarn.lock")):
		return "yarn"
	case fileExists(filepath.Join(root, "package-lock.json")):
		return "npm"
	default:
		return ""
	}
}

func discoverPackageCandidates(root string) (*packageCandidate, []packageCandidate) {
	candidates := []packageCandidate{}
	var rootCandidate *packageCandidate

	filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			name := entry.Name()
			if name == "node_modules" || name == ".git" || name == ".spawntree" || strings.HasPrefix(name, ".") && path != root {
				return filepath.SkipDir
			}
			if rel, err := filepath.Rel(root, path); err == nil && rel != "." && strings.Count(rel, string(os.PathSeparator)) > 3 {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() != "package.json" {
			return nil
		}
		if strings.Contains(path, string(filepath.Separator)+"node_modules"+string(filepath.Separator)) {
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr == nil {
			var pkg packageJSONFile
			if unmarshalErr := json.Unmarshal(content, &pkg); unmarshalErr == nil {
				dir := filepath.Dir(path)
				rel, _ := filepath.Rel(root, dir)
				if rel == "." {
					rel = ""
				}
				candidate := packageCandidate{
					Dir:     dir,
					RelDir:  rel,
					Name:    pkg.Name,
					Scripts: pkg.Scripts,
					IsRoot:  rel == "",
				}
				if candidate.IsRoot {
					copy := candidate
					rootCandidate = &copy
				} else {
					candidates = append(candidates, candidate)
				}
			}
		}
		return nil
	})

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].RelDir < candidates[j].RelDir
	})
	return rootCandidate, candidates
}

func discoverComposeFiles(root string) []composeFile {
	out := []composeFile{}
	filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			name := entry.Name()
			if name == "node_modules" || name == ".git" || name == ".spawntree" {
				return filepath.SkipDir
			}
			if rel, err := filepath.Rel(root, path); err == nil && rel != "." && strings.Count(rel, string(os.PathSeparator)) > 2 {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() != "docker-compose.yml" && entry.Name() != "docker-compose.yaml" {
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr == nil {
			var raw struct {
				Services map[string]struct {
					Image       string   `yaml:"image"`
					Ports       []string `yaml:"ports"`
					Healthcheck any      `yaml:"healthcheck"`
				} `yaml:"services"`
			}
			if unmarshalErr := yaml.Unmarshal(content, &raw); unmarshalErr == nil {
				rel, _ := filepath.Rel(root, path)
				item := composeFile{
					Path:     filepath.Dir(path),
					RelPath:  rel,
					Services: map[string]composeService{},
				}
				for name, svc := range raw.Services {
					item.Services[name] = composeService{
						Image:     svc.Image,
						Ports:     svc.Ports,
						HasHealth: svc.Healthcheck != nil,
					}
				}
				out = append(out, item)
			}
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].RelPath < out[j].RelPath })
	return out
}

func suggestComposeServices(root string, files []composeFile) []ConfigServiceSuggestion {
	suggestions := []ConfigServiceSuggestion{}
	for _, file := range files {
		for name, svc := range file.Services {
			s := ConfigServiceSuggestion{
				ID:       fmt.Sprintf("compose:%s:%s", file.RelPath, name),
				Name:     sanitizeSuggestedName(name),
				Source:   relativeSource(root, file.Path),
				Reason:   "compose service",
				Selected: file.Path == root,
			}
			lowerImage := strings.ToLower(svc.Image)
			switch {
			case strings.Contains(lowerImage, "postgres"):
				s.Type = "postgres"
				if s.Name == "" || s.Name == "postgres" {
					s.Name = "db"
				}
				s.Selected = true
			case strings.Contains(lowerImage, "redis"):
				s.Type = "redis"
				s.Name = "redis"
				s.Selected = true
			default:
				s.Type = "container"
				s.Image = svc.Image
				s.Port = detectComposePort(svc.Ports)
			}
			if s.Name == "" {
				s.Name = "service"
			}
			suggestions = append(suggestions, s)
		}
	}
	return suggestions
}

func detectComposePort(ports []string) int {
	for _, port := range ports {
		segments := strings.Split(strings.Trim(port, "\"'"), ":")
		last := strings.TrimSpace(segments[len(segments)-1])
		last = strings.Split(last, "/")[0]
		if value, err := strconv.Atoi(last); err == nil {
			return value
		}
	}
	return 0
}

func suggestPackageServices(root, manager string, rootPkg *packageCandidate, packages []packageCandidate, composeFiles []composeFile) []ConfigServiceSuggestion {
	suggestions := []ConfigServiceSuggestion{}
	hasNonRoot := len(packages) > 0
	composeByDir := map[string]bool{}
	for _, file := range composeFiles {
		composeByDir[file.Path] = true
	}

	for _, pkg := range packages {
		scriptName, command, reason := chooseScript(pkg, manager)
		if scriptName == "" || command == "" {
			continue
		}
		if composeByDir[pkg.Dir] && strings.Contains(pkg.Scripts[scriptName], "docker compose") {
			continue
		}
		name := deriveServiceName(pkg)
		s := ConfigServiceSuggestion{
			ID:       fmt.Sprintf("pkg:%s:%s", pkg.RelDir, scriptName),
			Name:     name,
			Type:     "process",
			Command:  command,
			Port:     detectSuggestedPort(name, pkg.Scripts[scriptName]),
			Source:   relativeSource(root, pkg.Dir),
			Reason:   reason,
			Selected: false,
		}
		suggestions = append(suggestions, s)
	}

	if rootPkg != nil {
		scriptName, command, reason := chooseScript(*rootPkg, manager)
		if scriptName != "" && command != "" && (!hasNonRoot || rootScriptWorthShowing(rootPkg.Scripts[scriptName])) {
			suggestions = append(suggestions, ConfigServiceSuggestion{
				ID:       fmt.Sprintf("pkg:root:%s", scriptName),
				Name:     deriveServiceName(*rootPkg),
				Type:     "process",
				Command:  command,
				Port:     detectSuggestedPort("app", rootPkg.Scripts[scriptName]),
				Source:   ".",
				Reason:   reason,
				Selected: !hasNonRoot,
			})
		}
	}

	return suggestions
}

func chooseScript(pkg packageCandidate, manager string) (string, string, string) {
	preferred := []string{"dev", "start", "serve"}
	for _, script := range preferred {
		command, ok := pkg.Scripts[script]
		if !ok || strings.TrimSpace(command) == "" {
			continue
		}
		return script, buildRunCommand(pkg.RelDir, manager, script), "package script"
	}
	return "", "", ""
}

func buildRunCommand(relDir, manager, script string) string {
	run := ""
	switch manager {
	case "pnpm":
		run = fmt.Sprintf("pnpm run %s", script)
	case "yarn":
		run = fmt.Sprintf("yarn %s", script)
	case "bun":
		run = fmt.Sprintf("bun run %s", script)
	default:
		run = fmt.Sprintf("npm run %s", script)
	}
	if relDir == "" {
		return run
	}
	return fmt.Sprintf("cd %s && %s", shellQuote(relDir), run)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func deriveServiceName(pkg packageCandidate) string {
	rel := pkg.RelDir
	base := filepath.Base(rel)
	if base == "." || base == "" {
		base = lastNameSegment(pkg.Name)
	}
	if base == "" {
		base = "app"
	}
	base = sanitizeSuggestedName(base)
	if base == "" {
		base = "app"
	}
	return base
}

func lastNameSegment(name string) string {
	if name == "" {
		return ""
	}
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		return name[idx+1:]
	}
	return name
}

func sanitizeSuggestedName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.ReplaceAll(name, "@", "")
	name = strings.ReplaceAll(name, "_", "-")
	name = strings.ReplaceAll(name, " ", "-")
	filtered := make([]rune, 0, len(name))
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			filtered = append(filtered, r)
		}
	}
	return strings.Trim(string(filtered), "-")
}

func detectSuggestedPort(name, rawCommand string) int {
	for _, pattern := range explicitPortPatterns {
		if match := pattern.FindStringSubmatch(rawCommand); len(match) == 2 {
			if value, err := strconv.Atoi(match[1]); err == nil {
				return value
			}
		}
	}

	command := strings.ToLower(rawCommand)
	switch {
	case strings.Contains(command, "vite dev"):
		return 5173
	case strings.Contains(command, "wrangler dev"):
		return 8787
	case strings.Contains(command, "sanity dev"):
		return 3333
	case strings.Contains(command, "storybook"):
		return 6006
	case strings.Contains(command, "next dev"):
		switch name {
		case "site":
			return 3001
		case "ops":
			return 3030
		default:
			return 3000
		}
	case strings.Contains(command, "hasura"):
		return 8080
	case name == "studio":
		return 5173
	case name == "host":
		return 8787
	case name == "api":
		return 3001
	case name == "app", name == "web", name == "site":
		return 3000
	default:
		return 0
	}
}

func suggestionKey(s ConfigServiceSuggestion) string {
	return fmt.Sprintf("%s:%s:%s:%s", s.Name, s.Type, s.Command, s.Image)
}

func selectDefaultSuggestions(suggestions []ConfigServiceSuggestion) {
	processes := []int{}
	for i, suggestion := range suggestions {
		if suggestion.Type == "process" {
			processes = append(processes, i)
		}
	}
	selectedCount := 0
	for _, index := range processes {
		if suggestions[index].Selected {
			selectedCount++
		}
	}
	for _, index := range processes {
		if selectedCount >= 4 {
			break
		}
		if suggestions[index].Selected {
			continue
		}
		suggestions[index].Selected = true
		selectedCount++
	}
}

func sortSuggestions(root string, suggestions []ConfigServiceSuggestion) {
	score := func(s ConfigServiceSuggestion) int {
		total := 0
		source := strings.ToLower(s.Source)
		name := strings.ToLower(s.Name)
		command := strings.ToLower(s.Command)

		if s.Type != "process" {
			total += 8
		}
		if s.Selected {
			total += 10
		}
		if source == "." {
			total += 1
		}
		if strings.HasPrefix(source, "apps/") {
			total += 6
		}
		if strings.HasPrefix(source, "packages/") {
			total += 3
		}
		if strings.Contains(source, "examples/") || strings.Contains(source, "scripts/") || strings.Contains(source, "registry/") || strings.Contains(source, "tooling/") {
			total -= 8
		}
		for _, token := range []string{"api", "host", "server", "gateway", "web", "site", "app", "studio", "worker", "cms", "ops", "graphql", "hasura", "temporal"} {
			if strings.Contains(name, token) {
				total += 2
			}
		}
		if strings.Contains(command, "turbo run dev") || strings.Contains(command, "turbo watch build") {
			total -= 4
		}
		return total
	}

	sort.SliceStable(suggestions, func(i, j int) bool {
		si := score(suggestions[i])
		sj := score(suggestions[j])
		if si != sj {
			return si > sj
		}
		return suggestions[i].Source < suggestions[j].Source
	})
}

func wireSuggestionDependencies(suggestions []ConfigServiceSuggestion) {
	var backend string
	for _, suggestion := range suggestions {
		if suggestion.Type != "process" {
			continue
		}
		switch suggestion.Name {
		case "api", "host", "server", "gateway":
			backend = suggestion.Name
			goto found
		}
	}
found:
	if backend == "" {
		return
	}
	for i := range suggestions {
		switch suggestions[i].Name {
		case "studio", "web", "site", "app", "ops", "cms":
			if suggestions[i].Type == "process" && suggestions[i].Name != backend {
				suggestions[i].DependsOn = appendUnique(suggestions[i].DependsOn, backend)
			}
		}
	}
}

func appendUnique(values []string, candidate string) []string {
	for _, value := range values {
		if value == candidate {
			return values
		}
	}
	return append(values, candidate)
}

func rootScriptWorthShowing(command string) bool {
	lower := strings.ToLower(command)
	return !strings.Contains(lower, "turbo run dev") &&
		!strings.Contains(lower, "turbo watch build") &&
		!strings.Contains(lower, "pnpm -r")
}

func relativeSource(root, dir string) string {
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == "." {
		return "."
	}
	return rel
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
