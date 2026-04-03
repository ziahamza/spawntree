package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type App struct {
	envManager      *EnvManager
	logStreamer     *LogStreamer
	infraManager    *InfraManager
	registryManager *RegistryManager
	db              *DB
	startedAt       time.Time
	version         string
	router          chi.Router
}

func NewApp(envManager *EnvManager, logStreamer *LogStreamer, infraManager *InfraManager, registryManager *RegistryManager, db *DB, version string) *App {
	a := &App{
		envManager:      envManager,
		logStreamer:     logStreamer,
		infraManager:    infraManager,
		registryManager: registryManager,
		db:              db,
		startedAt:       time.Now().UTC(),
		version:         version,
	}
	a.router = a.buildRouter()
	return a
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.router.ServeHTTP(w, r)
}

func (a *App) buildRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	// Health check (must stay before SPA fallback for CLI compatibility)
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// API routes
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/daemon", a.handleDaemonInfo)
		r.Get("/envs", a.handleListEnvs)
		r.Post("/envs", a.handleCreateEnv)
		r.Get("/infra", a.handleInfraStatus)
		r.Post("/infra/stop", a.handleInfraStop)
		r.Get("/db/templates", a.handleListTemplates)
		r.Post("/db/dump", a.handleDumpDB)
		r.Post("/db/restore", a.handleRestoreDB)
		r.Get("/registry/repos", a.handleListRegistryRepos)
		r.Post("/registry/repos", a.handleRegisterRepo)
		r.Get("/tunnels", a.handleListTunnels)
		r.Post("/tunnels", a.handleUpsertTunnel)
		r.Put("/tunnels", a.handleUpsertTunnel)
		r.Get("/tunnels/status", a.handleListTunnelStatuses)

		// Repo-scoped endpoints
		r.Get("/repos/{repoID}/envs", a.handleListRepoEnvs)
		r.Get("/repos/{repoID}/envs/{envID}", a.handleGetEnv)
		r.Delete("/repos/{repoID}/envs/{envID}", a.handleDeleteEnv)
		r.Post("/repos/{repoID}/envs/{envID}/down", a.handleDownEnv)
		r.Get("/repos/{repoID}/envs/{envID}/logs", a.handleLogStream)

		// New web UI endpoints
		r.Post("/discover", a.handleDiscover)
		r.Get("/web/repos", a.handleWebListRepos)
		r.Get("/web/repos/{repoSlug}", a.handleWebGetRepo)
		r.Get("/web/repos/{repoSlug}/clones", a.handleWebListClones)
		r.Patch("/web/repos/{repoSlug}/clones/{cloneID}", a.handleWebRelinkClone)
		r.Delete("/web/repos/{repoSlug}/clones/{cloneID}", a.handleWebDeleteClone)
		r.Post("/web/repos/add", a.handleWebAddFolder)
	})

	// OpenAPI spec
	r.Get("/openapi.yaml", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/yaml")
		_, _ = w.Write(OpenAPIYAML())
	})

	// SPA fallback: serve embedded frontend for non-API routes
	r.Get("/*", a.handleSPA)

	return r
}

// --- Existing API handlers (migrated from switch/case) ---

func (a *App) handleDaemonInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, RuntimeInfo{
		Version:    a.version,
		PID:        os.Getpid(),
		Uptime:     int64(time.Since(a.startedAt).Seconds()),
		Repos:      a.registryManager.RepoCount(),
		ActiveEnvs: len(a.envManager.ListEnvs("")),
	})
}

func (a *App) handleListEnvs(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, ListEnvsResponse{Envs: a.envManager.ListEnvs("")})
}

func (a *App) handleCreateEnv(w http.ResponseWriter, r *http.Request) {
	var req CreateEnvRequest
	if err := decodeJSON(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body", nil)
		return
	}
	env, err := a.envManager.CreateEnv(r.Context(), req)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusCreated, CreateEnvResponse{Env: env})
}

func (a *App) handleInfraStatus(w http.ResponseWriter, r *http.Request) {
	status, err := a.infraManager.GetStatus(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (a *App) handleInfraStop(w http.ResponseWriter, r *http.Request) {
	var req StopInfraRequest
	if err := decodeJSON(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body", nil)
		return
	}
	var err error
	switch req.Target {
	case "postgres":
		err = a.infraManager.StopPostgres(r.Context(), req.Version)
	case "redis":
		err = a.infraManager.StopRedis(r.Context())
	case "all":
		err = a.infraManager.StopAll(r.Context())
	default:
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Unknown target", map[string]any{"target": req.Target})
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, StopInfraResponse{OK: true})
}

func (a *App) handleListTemplates(w http.ResponseWriter, _ *http.Request) {
	pg, err := a.infraManager.EnsurePostgres(context.Background(), "17")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, ListDBTemplatesResponse{Templates: pg.ListTemplates()})
}

func (a *App) handleDumpDB(w http.ResponseWriter, r *http.Request) {
	var req DumpDBRequest
	if err := decodeJSON(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body", nil)
		return
	}
	pg, err := a.infraManager.EnsurePostgres(r.Context(), "17")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	if err := pg.DumpToTemplate(r.Context(), req.DBName, req.TemplateName); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	for _, template := range pg.ListTemplates() {
		if template.Name == req.TemplateName {
			writeJSON(w, http.StatusOK, DumpDBResponse{Template: template})
			return
		}
	}
	writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Dump succeeded but template not found", nil)
}

func (a *App) handleRestoreDB(w http.ResponseWriter, r *http.Request) {
	var req RestoreDBRequest
	if err := decodeJSON(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body", nil)
		return
	}
	pg, err := a.infraManager.EnsurePostgres(r.Context(), "17")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	if err := pg.RestoreFromTemplate(r.Context(), req.DBName, req.TemplateName); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, RestoreDBResponse{OK: true})
}

func (a *App) handleListRegistryRepos(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, ListRegisteredReposResponse{Repos: a.registryManager.ListRepos()})
}

func (a *App) handleRegisterRepo(w http.ResponseWriter, r *http.Request) {
	var req RegisterRepoRequest
	if err := decodeJSON(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body", nil)
		return
	}
	repo, err := a.registryManager.RegisterRepo(req.RepoPath, req.ConfigPath)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusCreated, RegisterRepoResponse{Repo: repo})
}

func (a *App) handleListTunnels(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, ListTunnelsResponse{Tunnels: a.registryManager.ListTunnels()})
}

func (a *App) handleUpsertTunnel(w http.ResponseWriter, r *http.Request) {
	var req UpsertTunnelRequest
	if err := decodeJSON(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body", nil)
		return
	}
	tunnel, err := a.registryManager.UpsertTunnel(req)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, UpsertTunnelResponse{Tunnel: tunnel})
}

func (a *App) handleListTunnelStatuses(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, ListTunnelStatusesResponse{Statuses: a.registryManager.ListTunnelStatuses()})
}

func (a *App) handleListRepoEnvs(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	writeJSON(w, http.StatusOK, ListEnvsResponse{Envs: a.envManager.ListEnvs(repoID)})
}

func (a *App) handleGetEnv(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	envID := chi.URLParam(r, "envID")
	env, err := a.envManager.GetEnv(repoID, envID)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, GetEnvResponse{Env: env})
}

func (a *App) handleDeleteEnv(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	envID := chi.URLParam(r, "envID")
	if err := a.envManager.DeleteEnv(r.Context(), repoID, envID); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, DeleteEnvResponse{OK: true})
}

func (a *App) handleDownEnv(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	envID := chi.URLParam(r, "envID")
	if err := a.envManager.DownEnv(r.Context(), repoID, envID); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, DownEnvResponse{OK: true})
}

func (a *App) handleLogStream(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	envID := chi.URLParam(r, "envID")
	if _, err := a.envManager.GetEnv(repoID, envID); err != nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", err.Error(), nil)
		return
	}
	service := r.URL.Query().Get("service")
	follow := r.URL.Query().Get("follow") != "false"
	lines := 50
	if raw := r.URL.Query().Get("lines"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			lines = parsed
		}
	}
	history, err := a.logStreamer.ReadHistory(RepoID(repoID), EnvID(envID), LogReadOptions{
		Service: service,
		Lines:   lines,
	})
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Streaming unsupported", nil)
		return
	}
	for _, line := range history {
		writeSSELine(w, line)
	}
	flusher.Flush()
	if !follow {
		return
	}
	ch, cleanup, err := a.logStreamer.Subscribe(RepoID(repoID), EnvID(envID), service)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	defer cleanup()
	notify := r.Context().Done()
	for {
		select {
		case line, ok := <-ch:
			if !ok {
				return
			}
			writeSSELine(w, line)
			flusher.Flush()
		case <-notify:
			return
		}
	}
}

// --- New web UI endpoints ---

func (a *App) handleDiscover(w http.ResponseWriter, _ *http.Request) {
	if a.db == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "DB_NOT_AVAILABLE", "Database not initialized", nil)
		return
	}

	start := time.Now()
	clones, err := a.db.ListAllClones()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	var warnings []DiscoverWarning
	discoveredCount := 0

	for _, clone := range clones {
		if !dirExists(clone.Path) {
			_ = a.db.UpdateCloneStatus(clone.ID, "missing")
			warnings = append(warnings, DiscoverWarning{
				Type:    "missing_clone",
				RepoID:  clone.RepoID,
				CloneID: clone.ID,
				Path:    clone.Path,
				Message: "Clone not found at path",
			})
			continue
		}

		_ = a.db.UpdateCloneStatus(clone.ID, "active")

		worktrees, err := discoverWorktrees(clone.Path, clone.ID)
		if err != nil {
			continue
		}
		_ = a.db.ReplaceWorktrees(clone.ID, worktrees)
		discoveredCount += len(worktrees)
	}

	writeJSON(w, http.StatusOK, DiscoverResult{
		Warnings:            warnings,
		DiscoveredWorktrees: discoveredCount,
		ValidatedClones:     len(clones),
		DurationMs:          time.Since(start).Milliseconds(),
	})
}

// WebRepoEnriched is a Repo with computed fields for the frontend.
type WebRepoEnriched struct {
	Repo
	CloneCount     int    `json:"cloneCount"`
	ActiveEnvCount int    `json:"activeEnvCount"`
	OverallStatus  string `json:"overallStatus"`
}

func (a *App) handleWebListRepos(w http.ResponseWriter, _ *http.Request) {
	if a.db == nil {
		writeJSON(w, http.StatusOK, map[string]any{"repos": []any{}})
		return
	}
	repos, err := a.db.ListRepos()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	enriched := make([]WebRepoEnriched, 0, len(repos))
	for _, repo := range repos {
		clones, _ := a.db.ListClones(repo.ID)
		runningEnvs := 0
		status := "offline"
		for _, clone := range clones {
			envs := a.envManager.ListEnvs(string(DeriveRepoID(clone.Path)))
			for _, env := range envs {
				hasRunning := false
				for _, svc := range env.Services {
					switch svc.Status {
					case ServiceStatusRunning:
						status = "running"
						hasRunning = true
					case ServiceStatusStarting:
						if status != "running" && status != "crashed" {
							status = "starting"
						}
					case ServiceStatusFailed:
						if status != "running" {
							status = "crashed"
						}
					case ServiceStatusStopped:
						if status == "offline" {
							status = "stopped"
						}
					}
				}
				if hasRunning {
					runningEnvs++
				}
			}
		}
		enriched = append(enriched, WebRepoEnriched{
			Repo:           repo,
			CloneCount:     len(clones),
			ActiveEnvCount: runningEnvs,
			OverallStatus:  status,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": enriched})
}

func (a *App) handleWebGetRepo(w http.ResponseWriter, r *http.Request) {
	if a.db == nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Database not initialized", nil)
		return
	}
	slug := chi.URLParam(r, "repoSlug")
	repo, err := a.db.GetRepoBySlug(slug)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	if repo == nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Repo not found", nil)
		return
	}
	clones, _ := a.db.ListClones(repo.ID)
	if clones == nil {
		clones = []Clone{}
	}
	allWorktrees := map[string][]Worktree{}
	for _, c := range clones {
		wts, _ := a.db.ListWorktrees(c.ID)
		if wts == nil {
			wts = []Worktree{}
		}
		allWorktrees[c.ID] = wts
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"repo":      repo,
		"clones":    clones,
		"worktrees": allWorktrees,
	})
}

func (a *App) handleWebListClones(w http.ResponseWriter, r *http.Request) {
	if a.db == nil {
		writeJSON(w, http.StatusOK, map[string]any{"clones": []any{}})
		return
	}
	slug := chi.URLParam(r, "repoSlug")
	repo, err := a.db.GetRepoBySlug(slug)
	if err != nil || repo == nil {
		writeJSON(w, http.StatusOK, map[string]any{"clones": []Clone{}})
		return
	}
	clones, _ := a.db.ListClones(repo.ID)
	if clones == nil {
		clones = []Clone{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"clones": clones})
}

func (a *App) handleWebRelinkClone(w http.ResponseWriter, r *http.Request) {
	if a.db == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "DB_NOT_AVAILABLE", "Database not initialized", nil)
		return
	}
	cloneID := chi.URLParam(r, "cloneID")

	// Verify clone exists
	existing, err := a.db.GetClone(cloneID)
	if err != nil || existing == nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Clone not found", nil)
		return
	}

	var body struct {
		Path string `json:"path"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Path == "" {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing path field", nil)
		return
	}

	gitRoot, err := ValidateGitRepo(body.Path)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Not a Git repository", nil)
		return
	}

	if err := a.db.UpdateClonePath(cloneID, gitRoot); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": gitRoot})
}

func (a *App) handleWebDeleteClone(w http.ResponseWriter, r *http.Request) {
	if a.db == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "DB_NOT_AVAILABLE", "Database not initialized", nil)
		return
	}
	cloneID := chi.URLParam(r, "cloneID")

	// Look up the clone's actual filesystem path to derive the correct repo ID
	clone, err := a.db.GetClone(cloneID)
	if err != nil || clone == nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Clone not found", nil)
		return
	}
	// Only block deletion if there are actually-running environments (not stopped ones)
	envRepoID := DeriveRepoID(clone.Path)
	envs := a.envManager.ListEnvs(string(envRepoID))
	for _, env := range envs {
		for _, svc := range env.Services {
			if svc.Status == ServiceStatusRunning || svc.Status == ServiceStatusStarting {
				writeAPIError(w, http.StatusConflict, "CONFLICT", "Cannot delete clone with running environments. Stop them first.", nil)
				return
			}
		}
	}

	if err := a.db.DeleteClone(cloneID); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AddFolderRequest is the request body for POST /api/v1/web/repos/add.
type AddFolderRequest struct {
	Path       string `json:"path"`
	RemoteName string `json:"remoteName,omitempty"` // optional, for multi-remote repos
}

// AddFolderResponse is returned from POST /api/v1/web/repos/add.
type AddFolderResponse struct {
	Repo    Repo        `json:"repo"`
	Clone   Clone       `json:"clone"`
	Remotes []GitRemote `json:"remotes,omitempty"` // populated if multiple remotes detected
}

func (a *App) handleWebAddFolder(w http.ResponseWriter, r *http.Request) {
	if a.db == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "DB_NOT_AVAILABLE", "Database not initialized", nil)
		return
	}

	var req AddFolderRequest
	if err := decodeJSON(r, &req); err != nil || req.Path == "" {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing path field", nil)
		return
	}

	gitRoot, err := ValidateGitRepo(req.Path)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "NOT_GIT_REPO", "Not a Git repository", nil)
		return
	}

	info, remotes, err := DetectRepoInfo(gitRoot)
	if err != nil {
		info = RemoteInfo{Provider: "local", Repo: sanitizeID(filepath.Base(gitRoot))}
	}

	// Multi-remote: if no preference specified, return remotes list without creating repo/clone
	if len(remotes) > 1 && req.RemoteName == "" {
		writeJSON(w, http.StatusOK, AddFolderResponse{Remotes: remotes})
		return
	}

	// If the user specified a preferred remote, use it instead of the default
	if len(remotes) > 1 && req.RemoteName != "" {
		for _, rm := range remotes {
			if rm.Name == req.RemoteName {
				info = ParseRemoteURL(rm.URL)
				break
			}
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

	// Enrich with gh metadata (optional, single call)
	if info.Provider == "github" && info.Owner != "" && info.Repo != "" {
		repo.DefaultBranch, repo.Description = TryGHMetadata(info.Owner, info.Repo)
	}

	if err := a.db.UpsertRepo(repo); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	clone := Clone{
		ID:     DeriveCloneID(gitRoot),
		RepoID: repo.ID,
		Path:   gitRoot,
		Status: "active",
	}
	if err := a.db.UpsertClone(clone); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	// Also register in the daemon's config-based registry for env management
	_, _ = a.registryManager.RegisterRepo(gitRoot, "spawntree.yaml")

	resp := AddFolderResponse{
		Repo:  repo,
		Clone: clone,
	}
	if len(remotes) > 1 {
		resp.Remotes = remotes
	}

	writeJSON(w, http.StatusCreated, resp)
}

// handleSPA serves the embedded SPA for non-API routes.
// This is a placeholder — the actual embed is in cmd/spawntreed/spa.go.
func (a *App) handleSPA(w http.ResponseWriter, r *http.Request) {
	// The actual SPA serving is handled by SPAHandler set during init.
	// If no SPA is embedded (noui build), return a JSON message.
	if spaHandler != nil {
		spaHandler.ServeHTTP(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"error":   "Web UI not built",
		"message": "Run pnpm build in packages/web/ first, then rebuild the daemon.",
	})
}

// spaHandler is set by the spa_embed.go file when the UI is compiled in.
var spaHandler http.Handler

// SetSPAHandler sets the handler for serving the embedded SPA assets.
func SetSPAHandler(h http.Handler) {
	spaHandler = h
}

// --- Helpers ---

func writeSSELine(w http.ResponseWriter, line LogLine) {
	payload, _ := json.Marshal(line)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", payload)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeAPIError(w http.ResponseWriter, status int, code, message string, details any) {
	writeJSON(w, status, APIError{
		Error:   message,
		Code:    code,
		Details: details,
	})
}

func decodeJSON(r *http.Request, value any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(value)
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func discoverWorktrees(clonePath, cloneID string) ([]Worktree, error) {
	wts, err := listGitWorktrees(clonePath)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	worktrees := make([]Worktree, 0, len(wts))
	for _, wt := range wts {
		worktrees = append(worktrees, Worktree{
			Path:         wt.Path,
			CloneID:      cloneID,
			Branch:       wt.Branch,
			HeadRef:      wt.HeadRef,
			DiscoveredAt: now,
		})
	}
	return worktrees, nil
}
