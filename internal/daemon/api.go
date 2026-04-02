package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type App struct {
	envManager      *EnvManager
	logStreamer     *LogStreamer
	infraManager    *InfraManager
	registryManager *RegistryManager
	startedAt       time.Time
	version         string
}

func NewApp(envManager *EnvManager, logStreamer *LogStreamer, infraManager *InfraManager, registryManager *RegistryManager, version string) *App {
	return &App{
		envManager:      envManager,
		logStreamer:     logStreamer,
		infraManager:    infraManager,
		registryManager: registryManager,
		startedAt:       time.Now().UTC(),
		version:         version,
	}
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	case r.URL.Path == "/openapi.yaml" && r.Method == http.MethodGet:
		w.Header().Set("Content-Type", "application/yaml")
		_, _ = w.Write(OpenAPIYAML())
		return
	case r.URL.Path == "/api/v1/daemon" && r.Method == http.MethodGet:
		a.handleDaemonInfo(w)
		return
	case r.URL.Path == "/api/v1/envs":
		a.handleEnvs(w, r)
		return
	case r.URL.Path == "/api/v1/infra" && r.Method == http.MethodGet:
		a.handleInfraStatus(w, r)
		return
	case r.URL.Path == "/api/v1/infra/stop" && r.Method == http.MethodPost:
		a.handleInfraStop(w, r)
		return
	case r.URL.Path == "/api/v1/db/templates" && r.Method == http.MethodGet:
		a.handleListTemplates(w)
		return
	case r.URL.Path == "/api/v1/db/dump" && r.Method == http.MethodPost:
		a.handleDumpDB(w, r)
		return
	case r.URL.Path == "/api/v1/db/restore" && r.Method == http.MethodPost:
		a.handleRestoreDB(w, r)
		return
	case r.URL.Path == "/api/v1/registry/repos":
		a.handleRegistryRepos(w, r)
		return
	case r.URL.Path == "/api/v1/tunnels":
		a.handleTunnels(w, r)
		return
	case r.URL.Path == "/api/v1/tunnels/status" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, ListTunnelStatusesResponse{Statuses: a.registryManager.ListTunnelStatuses()})
		return
	case strings.HasPrefix(r.URL.Path, "/api/v1/repos/"):
		a.handleRepoScoped(w, r)
		return
	default:
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Route not found", nil)
	}
}

func (a *App) handleDaemonInfo(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, RuntimeInfo{
		Version:    a.version,
		PID:        os.Getpid(),
		Uptime:     int64(time.Since(a.startedAt).Seconds()),
		Repos:      a.registryManager.RepoCount(),
		ActiveEnvs: len(a.envManager.ListEnvs("")),
	})
}

func (a *App) handleEnvs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, ListEnvsResponse{Envs: a.envManager.ListEnvs("")})
	case http.MethodPost:
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
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", nil)
	}
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

func (a *App) handleListTemplates(w http.ResponseWriter) {
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

func (a *App) handleRegistryRepos(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, ListRegisteredReposResponse{Repos: a.registryManager.ListRepos()})
	case http.MethodPost:
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
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", nil)
	}
}

func (a *App) handleTunnels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, ListTunnelsResponse{Tunnels: a.registryManager.ListTunnels()})
	case http.MethodPost, http.MethodPut:
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
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", nil)
	}
}

func (a *App) handleRepoScoped(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 5 || parts[0] != "api" || parts[1] != "v1" || parts[2] != "repos" {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Route not found", nil)
		return
	}
	repoID := parts[3]
	if parts[4] != "envs" {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Route not found", nil)
		return
	}
	if len(parts) == 5 && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, ListEnvsResponse{Envs: a.envManager.ListEnvs(repoID)})
		return
	}
	if len(parts) < 6 {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Route not found", nil)
		return
	}
	envID := parts[5]
	if len(parts) == 6 {
		switch r.Method {
		case http.MethodGet:
			env, err := a.envManager.GetEnv(repoID, envID)
			if err != nil {
				writeAPIError(w, http.StatusNotFound, "NOT_FOUND", err.Error(), nil)
				return
			}
			writeJSON(w, http.StatusOK, GetEnvResponse{Env: env})
		case http.MethodDelete:
			if err := a.envManager.DeleteEnv(r.Context(), repoID, envID); err != nil {
				writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
				return
			}
			writeJSON(w, http.StatusOK, DeleteEnvResponse{OK: true})
		default:
			writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", nil)
		}
		return
	}
	switch parts[6] {
	case "down":
		if r.Method != http.MethodPost {
			writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", nil)
			return
		}
		if err := a.envManager.DownEnv(r.Context(), repoID, envID); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, DownEnvResponse{OK: true})
	case "logs":
		if r.Method != http.MethodGet {
			writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", nil)
			return
		}
		a.handleLogStream(w, r, repoID, envID)
	default:
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Route not found", nil)
	}
}

func (a *App) handleLogStream(w http.ResponseWriter, r *http.Request, repoID, envID string) {
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
