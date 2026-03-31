package daemon

import (
	"sync"
	"time"
)

type RegistryManager struct {
	mu           sync.RWMutex
	config       GlobalConfig
	tunnelStatus map[string]TunnelStatusInfo
}

func NewRegistryManager() (*RegistryManager, error) {
	cfg, err := LoadGlobalConfig()
	if err != nil {
		return nil, err
	}
	if cfg.Repos == nil {
		cfg.Repos = map[string]RegisteredRepo{}
	}
	if cfg.Tunnels == nil {
		cfg.Tunnels = map[string]TunnelDefinition{}
	}
	return &RegistryManager{
		config:       cfg,
		tunnelStatus: map[string]TunnelStatusInfo{},
	}, nil
}

func (r *RegistryManager) RepoCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.config.Repos)
}

func (r *RegistryManager) DaemonConfig() RuntimeConfig {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.config.Daemon
}

func (r *RegistryManager) RegisterRepo(repoPath, configPath string) (RegisteredRepo, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	repoID := DeriveRepoID(repoPath)
	repo := RegisteredRepo{
		RepoID:     repoID,
		RepoPath:   repoPath,
		ConfigPath: configPath,
		LastSeenAt: time.Now().UTC().Format(time.RFC3339),
	}
	r.config.Repos[repoID] = repo
	if err := SaveGlobalConfig(r.config); err != nil {
		return RegisteredRepo{}, err
	}
	return repo, nil
}

func (r *RegistryManager) ListRepos() []RegisteredRepo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return sortedMapValues(r.config.Repos)
}

func (r *RegistryManager) ListTunnels() []TunnelDefinition {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return sortedMapValues(r.config.Tunnels)
}

func (r *RegistryManager) UpsertTunnel(req UpsertTunnelRequest) (TunnelDefinition, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	tunnel := TunnelDefinition(req)
	if tunnel.ID == "" {
		tunnel.ID = sanitizeID(req.Provider + "-" + req.Target.RepoID + "-" + req.Target.EnvID + "-" + req.Target.ServiceName)
	}
	r.config.Tunnels[tunnel.ID] = tunnel
	status := TunnelStatusInfo{
		ID:       tunnel.ID,
		Provider: tunnel.Provider,
		State:    "configured",
	}
	r.tunnelStatus[tunnel.ID] = status
	if err := SaveGlobalConfig(r.config); err != nil {
		return TunnelDefinition{}, err
	}
	return tunnel, nil
}

func (r *RegistryManager) ListTunnelStatuses() []TunnelStatusInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return sortedMapValues(r.tunnelStatus)
}
