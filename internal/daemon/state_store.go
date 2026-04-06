package daemon

import (
	"fmt"
	"time"
)

type daemonState struct {
	config       GlobalConfig
	envs         map[RepoID]map[EnvID]*ManagedEnv
	portSlots    map[EnvKey]PortSlot
	tunnelStatus map[TunnelID]TunnelStatusInfo
}

type stateCommand func(*daemonState)

type stateResult[T any] struct {
	value T
	err   error
}

type StateStore struct {
	commands chan stateCommand
}

func NewStateStore() (*StateStore, error) {
	config, err := LoadGlobalConfig()
	if err != nil {
		return nil, err
	}
	if config.Repos == nil {
		config.Repos = map[RepoID]RegisteredRepo{}
	}
	if config.Tunnels == nil {
		config.Tunnels = map[TunnelID]TunnelDefinition{}
	}

	portRegistry, err := LoadPortRegistry()
	if err != nil {
		return nil, err
	}

	state := &daemonState{
		config:       config,
		envs:         map[RepoID]map[EnvID]*ManagedEnv{},
		portSlots:    map[EnvKey]PortSlot{},
		tunnelStatus: map[TunnelID]TunnelStatusInfo{},
	}
	for _, slot := range portRegistry.Slots {
		state.portSlots[slot.EnvKey] = slot
	}

	store := &StateStore{
		commands: make(chan stateCommand),
	}
	go func() {
		for command := range store.commands {
			command(state)
		}
	}()
	return store, nil
}

func execState[T any](store *StateStore, run func(*daemonState) (T, error)) (T, error) {
	resultCh := make(chan stateResult[T], 1)
	store.commands <- func(state *daemonState) {
		value, err := run(state)
		resultCh <- stateResult[T]{
			value: value,
			err:   err,
		}
	}
	result := <-resultCh
	return result.value, result.err
}

func (store *StateStore) RuntimeConfig() RuntimeConfig {
	config, _ := execState(store, func(state *daemonState) (RuntimeConfig, error) {
		return state.config.Daemon, nil
	})
	return config
}

func (store *StateStore) RepoCount() int {
	count, _ := execState(store, func(state *daemonState) (int, error) {
		return len(state.config.Repos), nil
	})
	return count
}

func (store *StateStore) RegisterRepo(repoPath, configPath string) (RegisteredRepo, error) {
	return execState(store, func(state *daemonState) (RegisteredRepo, error) {
		repoID := DeriveRepoID(repoPath)
		repo := RegisteredRepo{
			RepoID:     repoID,
			RepoPath:   repoPath,
			ConfigPath: configPath,
			LastSeenAt: time.Now().UTC().Format(time.RFC3339),
		}
		state.config.Repos[repoID] = repo
		return repo, SaveGlobalConfig(state.config)
	})
}

func (store *StateStore) ListRepos() []RegisteredRepo {
	repos, _ := execState(store, func(state *daemonState) ([]RegisteredRepo, error) {
		return sortedMapValues(state.config.Repos), nil
	})
	return repos
}

func (store *StateStore) GetRegisteredRepo(repoPath string) *RegisteredRepo {
	repo, _ := execState(store, func(state *daemonState) (*RegisteredRepo, error) {
		repoID := DeriveRepoID(repoPath)
		registered, ok := state.config.Repos[repoID]
		if !ok {
			return nil, nil
		}
		copy := registered
		return &copy, nil
	})
	return repo
}

func (store *StateStore) ListTunnels() []TunnelDefinition {
	tunnels, _ := execState(store, func(state *daemonState) ([]TunnelDefinition, error) {
		return sortedMapValues(state.config.Tunnels), nil
	})
	return tunnels
}

func (store *StateStore) UpsertTunnel(req UpsertTunnelRequest) (TunnelDefinition, error) {
	return execState(store, func(state *daemonState) (TunnelDefinition, error) {
		tunnel := TunnelDefinition(req)
		if tunnel.ID == "" {
			tunnel.ID = TunnelID(sanitizeID(fmt.Sprintf("%s-%s-%s-%s", req.Provider, req.Target.RepoID, req.Target.EnvID, req.Target.ServiceName)))
		}
		state.config.Tunnels[tunnel.ID] = tunnel
		state.tunnelStatus[tunnel.ID] = TunnelStatusInfo{
			ID:       tunnel.ID,
			Provider: tunnel.Provider,
			State:    "configured",
		}
		return tunnel, SaveGlobalConfig(state.config)
	})
}

func (store *StateStore) ListTunnelStatuses() []TunnelStatusInfo {
	statuses, _ := execState(store, func(state *daemonState) ([]TunnelStatusInfo, error) {
		return sortedMapValues(state.tunnelStatus), nil
	})
	return statuses
}

func (store *StateStore) AllocatePort(envKey EnvKey) (Port, error) {
	return execState(store, func(state *daemonState) (Port, error) {
		if slot, ok := state.portSlots[envKey]; ok {
			return slot.BasePort, nil
		}

		used := map[int]bool{}
		for _, slot := range state.portSlots {
			used[(slot.BasePort.Int()-portRangeStart)/portRangeSize] = true
		}
		for i := 0; i < maxPortSlots; i++ {
			if used[i] {
				continue
			}
			basePort := Port(portRangeStart + i*portRangeSize)
			state.portSlots[envKey] = PortSlot{
				EnvKey:      envKey,
				BasePort:    basePort,
				AllocatedAt: time.Now().UTC().Format(time.RFC3339),
			}
			return basePort, SavePortRegistry(store.toPortRegistryState(state))
		}
		return 0, fmt.Errorf("all %d port slots are in use", maxPortSlots)
	})
}

func (store *StateStore) FreePort(envKey EnvKey) error {
	_, err := execState(store, func(state *daemonState) (struct{}, error) {
		delete(state.portSlots, envKey)
		return struct{}{}, SavePortRegistry(store.toPortRegistryState(state))
	})
	return err
}

func (store *StateStore) GetBasePort(envKey EnvKey) *Port {
	basePort, _ := execState(store, func(state *daemonState) (*Port, error) {
		slot, ok := state.portSlots[envKey]
		if !ok {
			return nil, nil
		}
		port := slot.BasePort
		return &port, nil
	})
	return basePort
}

func (store *StateStore) ListPortSlots() []PortSlot {
	slots, _ := execState(store, func(state *daemonState) ([]PortSlot, error) {
		slots := make([]PortSlot, 0, len(state.portSlots))
		for _, slot := range state.portSlots {
			slots = append(slots, slot)
		}
		return slots, nil
	})
	return slots
}

func (store *StateStore) PutManagedEnv(env *ManagedEnv) {
	_, _ = execState(store, func(state *daemonState) (struct{}, error) {
		if state.envs[env.RepoID] == nil {
			state.envs[env.RepoID] = map[EnvID]*ManagedEnv{}
		}
		state.envs[env.RepoID][env.EnvID] = env
		return struct{}{}, nil
	})
}

func (store *StateStore) GetManagedEnv(repoID RepoID, envID EnvID) (*ManagedEnv, error) {
	return execState(store, func(state *daemonState) (*ManagedEnv, error) {
		repoEnvs := state.envs[repoID]
		if repoEnvs == nil || repoEnvs[envID] == nil {
			return nil, fmt.Errorf("environment %q not found for repo %q", envID, repoID)
		}
		return repoEnvs[envID], nil
	})
}

func (store *StateStore) DeleteManagedEnv(repoID RepoID, envID EnvID) {
	_, _ = execState(store, func(state *daemonState) (struct{}, error) {
		repoEnvs := state.envs[repoID]
		if repoEnvs == nil {
			return struct{}{}, nil
		}
		delete(repoEnvs, envID)
		if len(repoEnvs) == 0 {
			delete(state.envs, repoID)
		}
		return struct{}{}, nil
	})
}

func (store *StateStore) ListManagedEnvs(repoID RepoID) []*ManagedEnv {
	envs, _ := execState(store, func(state *daemonState) ([]*ManagedEnv, error) {
		if repoID != "" {
			return sortedManagedEnvs(state.envs[repoID]), nil
		}
		all := []*ManagedEnv{}
		for _, repoEnvs := range state.envs {
			all = append(all, sortedManagedEnvs(repoEnvs)...)
		}
		return all, nil
	})
	return envs
}

func (store *StateStore) toPortRegistryState(state *daemonState) PortRegistryState {
	return PortRegistryState{
		Slots: store.ListPortSlotsForState(state),
	}
}

func (store *StateStore) ListPortSlotsForState(state *daemonState) []PortSlot {
	slots := make([]PortSlot, 0, len(state.portSlots))
	for _, slot := range state.portSlots {
		slots = append(slots, slot)
	}
	return slots
}

func sortedManagedEnvs(repoEnvs map[EnvID]*ManagedEnv) []*ManagedEnv {
	if len(repoEnvs) == 0 {
		return nil
	}
	keys := sortedMapKeys(repoEnvs)
	envs := make([]*ManagedEnv, 0, len(keys))
	for _, key := range keys {
		envs = append(envs, repoEnvs[key])
	}
	return envs
}
