package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync/atomic"
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
		r.Post("/web/repos/{repoSlug}/worktrees/archive", a.handleWebArchiveWorktree)
		r.Post("/web/repos/probe", a.handleWebProbePath)
		r.Post("/web/repos/add", a.handleWebAddFolder)
		r.Post("/web/config/test", a.handleWebTestConfig)
		r.Post("/web/config/save", a.handleWebSaveConfig)
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
	envs, err := a.listRepoEnvsForRef(repoID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, ListEnvsResponse{Envs: envs})
}

func (a *App) handleGetEnv(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	envID := chi.URLParam(r, "envID")
	repoPath := r.URL.Query().Get("repoPath")
	env, _, err := a.resolveRepoEnv(repoID, envID, repoPath)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, GetEnvResponse{Env: env})
}

func (a *App) handleDeleteEnv(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	envID := chi.URLParam(r, "envID")
	repoPath := r.URL.Query().Get("repoPath")
	_, resolvedRepoID, err := a.resolveRepoEnv(repoID, envID, repoPath)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", err.Error(), nil)
		return
	}
	if err := a.envManager.DeleteEnv(r.Context(), resolvedRepoID, envID); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, DeleteEnvResponse{OK: true})
}

func (a *App) handleDownEnv(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	envID := chi.URLParam(r, "envID")
	repoPath := r.URL.Query().Get("repoPath")
	_, resolvedRepoID, err := a.resolveRepoEnv(repoID, envID, repoPath)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", err.Error(), nil)
		return
	}
	if err := a.envManager.DownEnv(r.Context(), resolvedRepoID, envID); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, DownEnvResponse{OK: true})
}

func (a *App) handleLogStream(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	envID := chi.URLParam(r, "envID")
	repoPath := r.URL.Query().Get("repoPath")
	_, resolvedRepoID, err := a.resolveRepoEnv(repoID, envID, repoPath)
	if err != nil {
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
	history, err := a.logStreamer.ReadHistory(RepoID(resolvedRepoID), EnvID(envID), LogReadOptions{
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
	ch, cleanup, err := a.logStreamer.Subscribe(RepoID(resolvedRepoID), EnvID(envID), service)
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
	_ = a.syncWatchedPaths(true)

	start := time.Now()
	clones, err := a.db.ListAllClones()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	var warnings []DiscoverWarning
	discoveredCount := 0

	for _, clone := range clones {
		discovered, missing, err := a.syncCloneWorktrees(clone)
		if err != nil {
			continue
		}
		if missing {
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
		discoveredCount += discovered
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
	_ = a.syncWatchedPaths(false)
	repos, err := a.db.ListRepos()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	enriched := make([]WebRepoEnriched, 0, len(repos))
	for _, repo := range repos {
		clones, _ := a.db.ListClones(repo.ID)
		envs, _ := a.listRepoEnvsForRepo(&repo)
		runningEnvs := 0
		status := "offline"
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
	clones, err := a.db.ListClones(repo.ID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	if clones == nil {
		clones = []Clone{}
	}
	for _, clone := range clones {
		_, _, _ = a.syncCloneWorktrees(clone)
	}
	clones, err = a.db.ListClones(repo.ID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	allWorktrees := map[string][]Worktree{}
	for _, c := range clones {
		wts, err := a.db.ListWorktrees(c.ID)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
			return
		}
		if wts == nil {
			wts = []Worktree{}
		}
		allWorktrees[c.ID] = wts
	}
	envs, err := a.listRepoEnvsForRepo(repo)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	gitPaths, err := a.buildGitPathInfoMap(repo, clones, allWorktrees, envs)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"repo":      repo,
		"clones":    clones,
		"worktrees": allWorktrees,
		"envs":      envs,
		"gitPaths":  gitPaths,
	})
}

func (a *App) handleWebListClones(w http.ResponseWriter, r *http.Request) {
	if a.db == nil {
		writeJSON(w, http.StatusOK, map[string]any{"clones": []any{}})
		return
	}
	slug := chi.URLParam(r, "repoSlug")
	repo, err := a.db.GetRepoBySlug(slug)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	if repo == nil {
		writeJSON(w, http.StatusOK, map[string]any{"clones": []Clone{}})
		return
	}
	clones, err := a.db.ListClones(repo.ID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
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
	updatedClone, err := a.db.GetClone(cloneID)
	if err != nil || updatedClone == nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Clone updated but could not be reloaded", nil)
		return
	}
	if _, _, err := a.syncCloneWorktrees(*updatedClone); err != nil {
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
	repo, err := a.db.GetRepo(clone.RepoID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	envs, err := a.listRepoEnvsForRepo(repo)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
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

func (a *App) handleWebArchiveWorktree(w http.ResponseWriter, r *http.Request) {
	if a.db == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "DB_NOT_AVAILABLE", "Database not initialized", nil)
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

	var body struct {
		Path string `json:"path"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Path == "" {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing path field", nil)
		return
	}

	clones, err := a.db.ListClones(repo.ID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	var ownerClone *Clone
	found := false
	for i := range clones {
		if clones[i].Path == body.Path {
			writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Cannot archive the primary clone from the sidebar", nil)
			return
		}
		worktrees, err := a.db.ListWorktrees(clones[i].ID)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
			return
		}
		for _, wt := range worktrees {
			if wt.Path == body.Path {
				ownerClone = &clones[i]
				found = true
				break
			}
		}
		if found {
			break
		}
	}
	if !found || ownerClone == nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Worktree not found", nil)
		return
	}

	envs, err := a.listRepoEnvsForRepo(repo)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	for _, env := range envs {
		if env.RepoPath == body.Path {
			writeAPIError(w, http.StatusConflict, "CONFLICT", "Remove environments for this worktree before archiving it.", nil)
			return
		}
	}

	info, err := inspectGitPath(body.Path, repo.DefaultBranch, false)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	if !info.CanArchive {
		writeAPIError(w, http.StatusConflict, "CONFLICT", "Only clean worktrees already merged into main can be archived.", nil)
		return
	}

	if err := removeGitWorktree(body.Path); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}
	if _, _, err := a.syncCloneWorktrees(*ownerClone); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AddFolderRequest is the request body for POST /api/v1/web/repos/add.
type AddFolderRequest struct {
	Path         string `json:"path"`
	RemoteName   string `json:"remoteName,omitempty"` // optional, for multi-remote repos
	ScanChildren bool   `json:"scanChildren,omitempty"`
}

// AddFolderResponse is returned from POST /api/v1/web/repos/add.
type AddFolderResponse struct {
	Repo          *Repo        `json:"repo,omitempty"`
	Clone         *Clone       `json:"clone,omitempty"`
	Remotes       []GitRemote  `json:"remotes,omitempty"` // populated if multiple remotes detected
	WatchedPath   *WatchedPath `json:"watchedPath,omitempty"`
	ImportedCount int          `json:"importedCount,omitempty"`
}

type ProbePathRequest struct {
	Path string `json:"path"`
}

func (a *App) handleWebProbePath(w http.ResponseWriter, r *http.Request) {
	var req ProbePathRequest
	if err := decodeJSON(r, &req); err != nil || req.Path == "" {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing path field", nil)
		return
	}
	result, err := probePath(req.Path)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, result)
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

	probe, err := probePath(req.Path)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error(), nil)
		return
	}
	if !probe.Exists {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Path not found", nil)
		return
	}
	if probe.IsGitRepo && req.RemoteName == "" {
		if remotes, err := DetectRemotes(probe.Path); err == nil && len(remotes) > 1 {
			writeJSON(w, http.StatusOK, AddFolderResponse{Remotes: remotes})
			return
		}
	}

	watched := WatchedPath{
		Path:         probe.Path,
		ScanChildren: !probe.IsGitRepo && req.ScanChildren,
	}
	if err := a.db.UpsertWatchedPath(watched); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	if probe.IsGitRepo {
		repo, clone, remotes, err := a.importGitRepoPath(probe.Path, req.RemoteName, true)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
			return
		}
		if len(remotes) > 0 {
			writeJSON(w, http.StatusOK, AddFolderResponse{Remotes: remotes})
			return
		}
		writeJSON(w, http.StatusCreated, AddFolderResponse{
			Repo:          repo,
			Clone:         clone,
			WatchedPath:   &watched,
			ImportedCount: 1,
		})
		return
	}

	imported := 0
	if watched.ScanChildren {
		var err error
		imported, err = a.syncWatchedPath(watched)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
			return
		}
	}

	writeJSON(w, http.StatusCreated, AddFolderResponse{
		WatchedPath:   &watched,
		ImportedCount: imported,
	})
}

func (a *App) handleWebTestConfig(w http.ResponseWriter, r *http.Request) {
	var req ConfigTestRequest
	if err := decodeJSON(r, &req); err != nil || req.RepoPath == "" || req.Content == "" {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "repoPath and content are required", nil)
		return
	}
	result, err := a.runConfigTest(req.RepoPath, req.Content)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "TEST_FAILED", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) handleWebSaveConfig(w http.ResponseWriter, r *http.Request) {
	var req ConfigSaveRequest
	if err := decodeJSON(r, &req); err != nil || req.RepoPath == "" || req.Content == "" {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "repoPath and content are required", nil)
		return
	}

	repoPath, err := normalizeInputPath(req.RepoPath)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error(), nil)
		return
	}
	gitRoot, err := ValidateGitRepo(repoPath)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "Not a Git repository", nil)
		return
	}

	saveMode := req.SaveMode
	if saveMode == "" {
		saveMode = "repo"
	}

	configPath := ""
	switch saveMode {
	case "repo":
		targetBranch := defaultBranchName(repoPath)
		targetPath, err := findWorktreeForBranch(gitRoot, targetBranch)
		if err != nil {
			writeAPIError(w, http.StatusConflict, "NO_DEFAULT_BRANCH_WORKTREE", err.Error()+". Save globally instead.", nil)
			return
		}
		configPath = filepath.Join(targetPath, "spawntree.yaml")
	case "global":
		configPath, err = globalRepoConfigPath(repoPath)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
			return
		}
	default:
		writeAPIError(w, http.StatusBadRequest, "BAD_REQUEST", "saveMode must be repo or global", nil)
		return
	}

	if err := writeConfigFile(configPath, req.Content); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
		return
	}

	_, _ = a.registryManager.RegisterRepo(gitRoot, configPath)
	writeJSON(w, http.StatusOK, ConfigSaveResponse{
		OK:         true,
		ConfigPath: configPath,
		SaveMode:   saveMode,
	})
}

func (a *App) listRepoEnvsForRef(repoRef string) ([]EnvInfo, error) {
	direct := a.envManager.ListEnvs(repoRef)
	if len(direct) > 0 || a.db == nil {
		return direct, nil
	}

	repo, err := a.resolveRepoRef(repoRef)
	if err != nil || repo == nil {
		return direct, err
	}
	return a.listRepoEnvsForRepo(repo)
}

func (a *App) listRepoEnvsForRepo(repo *Repo) ([]EnvInfo, error) {
	if a.db == nil || repo == nil {
		return []EnvInfo{}, nil
	}

	clones, err := a.db.ListClones(repo.ID)
	if err != nil {
		return nil, err
	}

	paths := map[string]struct{}{}
	for _, clone := range clones {
		paths[clone.Path] = struct{}{}
		worktrees, err := a.db.ListWorktrees(clone.ID)
		if err != nil {
			return nil, err
		}
		for _, wt := range worktrees {
			paths[wt.Path] = struct{}{}
		}
	}

	envs := make([]EnvInfo, 0)
	for _, env := range a.envManager.ListEnvs("") {
		if _, ok := paths[env.RepoPath]; ok {
			envs = append(envs, env)
		}
	}

	sort.Slice(envs, func(i, j int) bool {
		if envs[i].RepoPath == envs[j].RepoPath {
			return envs[i].EnvID < envs[j].EnvID
		}
		return envs[i].RepoPath < envs[j].RepoPath
	})

	return envs, nil
}

func (a *App) resolveRepoRef(repoRef string) (*Repo, error) {
	if a.db == nil {
		return nil, nil
	}
	repo, err := a.db.GetRepoBySlug(repoRef)
	if err != nil {
		return nil, err
	}
	if repo != nil {
		return repo, nil
	}
	return a.db.GetRepo(repoRef)
}

func (a *App) resolveRepoEnv(repoRef, envID, repoPath string) (EnvInfo, string, error) {
	env, err := a.envManager.GetEnv(repoRef, envID)
	if err == nil {
		if repoPath == "" || env.RepoPath == repoPath {
			return env, repoRef, nil
		}
	}

	envs, err := a.listRepoEnvsForRef(repoRef)
	if err != nil {
		return EnvInfo{}, "", err
	}

	for _, candidate := range envs {
		if candidate.EnvID != EnvID(envID) {
			continue
		}
		if repoPath != "" && candidate.RepoPath != repoPath {
			continue
		}
		return candidate, string(candidate.RepoID), nil
	}

	return EnvInfo{}, "", fmt.Errorf("environment %q not found for repo %q", envID, repoRef)
}

func (a *App) syncCloneWorktrees(clone Clone) (int, bool, error) {
	if a.db == nil {
		return 0, false, nil
	}
	if !dirExists(clone.Path) {
		if err := a.db.UpdateCloneStatus(clone.ID, "missing"); err != nil {
			return 0, true, err
		}
		if err := a.db.ReplaceWorktrees(clone.ID, nil); err != nil {
			return 0, true, err
		}
		return 0, true, nil
	}

	if err := a.db.UpdateCloneStatus(clone.ID, "active"); err != nil {
		return 0, false, err
	}

	worktrees, err := discoverWorktrees(clone.Path, clone.ID)
	if err != nil {
		return 0, false, err
	}
	if err := a.db.ReplaceWorktrees(clone.ID, worktrees); err != nil {
		return 0, false, err
	}
	return len(worktrees), false, nil
}

func (a *App) buildGitPathInfoMap(repo *Repo, clones []Clone, allWorktrees map[string][]Worktree, envs []EnvInfo) (map[string]GitPathInfo, error) {
	gitPaths := map[string]GitPathInfo{}
	envCounts := map[string]int{}
	for _, env := range envs {
		envCounts[env.RepoPath]++
	}

	for _, clone := range clones {
		if info, err := inspectGitPath(clone.Path, repo.DefaultBranch, envCounts[clone.Path] > 0); err == nil {
			gitPaths[clone.Path] = info
		}
		for _, wt := range allWorktrees[clone.ID] {
			if wt.Path == clone.Path {
				continue
			}
			if info, err := inspectGitPath(wt.Path, repo.DefaultBranch, envCounts[wt.Path] > 0); err == nil {
				gitPaths[wt.Path] = info
			}
		}
	}

	return gitPaths, nil
}

// handleSPA serves the embedded SPA for non-API routes.
// This is a placeholder — the actual embed is in cmd/spawntreed/spa.go.
func (a *App) handleSPA(w http.ResponseWriter, r *http.Request) {
	if h, ok := spaHandlerValue.Load().(http.Handler); ok && h != nil {
		h.ServeHTTP(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"error":   "Web UI not built",
		"message": "Run pnpm build in packages/web/ first, then rebuild the daemon.",
	})
}

// spaHandlerValue stores the embedded SPA handler, set by spa_embed.go init().
// Uses atomic.Value for safe concurrent access between init() and HTTP handlers.
var spaHandlerValue atomic.Value

// SetSPAHandler sets the handler for serving the embedded SPA assets.
func SetSPAHandler(h http.Handler) {
	spaHandlerValue.Store(h)
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
