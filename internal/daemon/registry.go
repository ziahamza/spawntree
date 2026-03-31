package daemon

import (
	"sync"
	"time"
)

type RegistryManager struct {
	mu           sync.Mutex
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
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.config.Repos)
}

func (r *RegistryManager) DaemonConfig() DaemonConfig {
	r.mu.Lock()
	defer r.mu.Unlock()
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
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]RegisteredRepo, 0, len(r.config.Repos))
	for _, repo := range r.config.Repos {
		result = append(result, repo)
	}
	sortRepos(result)
	return result
}

func (r *RegistryManager) ListTunnels() []TunnelDefinition {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]TunnelDefinition, 0, len(r.config.Tunnels))
	for _, tunnel := range r.config.Tunnels {
		result = append(result, tunnel)
	}
	sortTunnels(result)
	return result
}

func (r *RegistryManager) UpsertTunnel(req UpsertTunnelRequest) (TunnelDefinition, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	tunnel := TunnelDefinition{
		ID:       req.ID,
		Provider: req.Provider,
		Target:   req.Target,
		Enabled:  req.Enabled,
		Config:   req.Config,
	}
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
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]TunnelStatusInfo, 0, len(r.tunnelStatus))
	for _, status := range r.tunnelStatus {
		result = append(result, status)
	}
	sortTunnelStatuses(result)
	return result
}

func sortRepos(repos []RegisteredRepo) {
	for i := 0; i < len(repos); i++ {
		for j := i + 1; j < len(repos); j++ {
			if repos[j].RepoID < repos[i].RepoID {
				repos[i], repos[j] = repos[j], repos[i]
			}
		}
	}
}

func sortTunnels(tunnels []TunnelDefinition) {
	for i := 0; i < len(tunnels); i++ {
		for j := i + 1; j < len(tunnels); j++ {
			if tunnels[j].ID < tunnels[i].ID {
				tunnels[i], tunnels[j] = tunnels[j], tunnels[i]
			}
		}
	}
}

func sortTunnelStatuses(statuses []TunnelStatusInfo) {
	for i := 0; i < len(statuses); i++ {
		for j := i + 1; j < len(statuses); j++ {
			if statuses[j].ID < statuses[i].ID {
				statuses[i], statuses[j] = statuses[j], statuses[i]
			}
		}
	}
}
