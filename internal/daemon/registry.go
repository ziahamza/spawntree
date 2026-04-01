package daemon

type RegistryManager struct {
	store *StateStore
}

func NewRegistryManager(store *StateStore) *RegistryManager {
	return &RegistryManager{store: store}
}

func (r *RegistryManager) RepoCount() int {
	return r.store.RepoCount()
}

func (r *RegistryManager) DaemonConfig() RuntimeConfig {
	return r.store.RuntimeConfig()
}

func (r *RegistryManager) RegisterRepo(repoPath, configPath string) (RegisteredRepo, error) {
	return r.store.RegisterRepo(repoPath, configPath)
}

func (r *RegistryManager) ListRepos() []RegisteredRepo {
	return r.store.ListRepos()
}

func (r *RegistryManager) ListTunnels() []TunnelDefinition {
	return r.store.ListTunnels()
}

func (r *RegistryManager) UpsertTunnel(req UpsertTunnelRequest) (TunnelDefinition, error) {
	return r.store.UpsertTunnel(req)
}

func (r *RegistryManager) ListTunnelStatuses() []TunnelStatusInfo {
	return r.store.ListTunnelStatuses()
}
