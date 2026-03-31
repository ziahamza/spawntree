package daemon

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"gopkg.in/yaml.v3"
)

var globalConfigMu sync.Mutex

func SpawntreeHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".spawntree"
	}
	return filepath.Join(home, ".spawntree")
}

func EnsureBaseDirs() error {
	dirs := []string{
		SpawntreeHome(),
		filepath.Join(SpawntreeHome(), "runtime"),
		filepath.Join(SpawntreeHome(), "repos"),
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func RuntimeDir() string {
	return filepath.Join(SpawntreeHome(), "runtime")
}

func RuntimeMetadataPath() string {
	return filepath.Join(RuntimeDir(), "daemon.json")
}

func GlobalConfigPath() string {
	return filepath.Join(SpawntreeHome(), "config.yaml")
}

func SocketPath() string {
	return filepath.Join(SpawntreeHome(), "spawntree.sock")
}

func RepoDir(repoID string) string {
	return filepath.Join(SpawntreeHome(), "repos", repoID)
}

func RepoLogDir(repoID, envID string) string {
	return filepath.Join(RepoDir(repoID), "logs", envID)
}

func RepoStatePath(repoID string) string {
	return filepath.Join(RepoDir(repoID), "state.json")
}

func PortRegistryPath() string {
	return filepath.Join(RuntimeDir(), "port-registry.json")
}

func EnsureRepoDirs(repoID, envID string) error {
	if err := os.MkdirAll(RepoDir(repoID), 0o755); err != nil {
		return err
	}
	return os.MkdirAll(RepoLogDir(repoID, envID), 0o755)
}

func LoadGlobalConfig() (GlobalConfig, error) {
	globalConfigMu.Lock()
	defer globalConfigMu.Unlock()

	if err := EnsureBaseDirs(); err != nil {
		return GlobalConfig{}, err
	}

	file := GlobalConfigPath()
	content, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return GlobalConfig{
			Repos:   map[string]RegisteredRepo{},
			Tunnels: map[string]TunnelDefinition{},
		}, nil
	}
	if err != nil {
		return GlobalConfig{}, err
	}

	var cfg GlobalConfig
	if err := yaml.Unmarshal(content, &cfg); err != nil {
		return GlobalConfig{}, err
	}
	if cfg.Repos == nil {
		cfg.Repos = map[string]RegisteredRepo{}
	}
	if cfg.Tunnels == nil {
		cfg.Tunnels = map[string]TunnelDefinition{}
	}
	return cfg, nil
}

func SaveGlobalConfig(cfg GlobalConfig) error {
	globalConfigMu.Lock()
	defer globalConfigMu.Unlock()

	if err := EnsureBaseDirs(); err != nil {
		return err
	}
	if cfg.Repos == nil {
		cfg.Repos = map[string]RegisteredRepo{}
	}
	if cfg.Tunnels == nil {
		cfg.Tunnels = map[string]TunnelDefinition{}
	}
	out, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(GlobalConfigPath(), out, 0o644)
}

func LoadRuntimeMetadata() (RuntimeMetadata, error) {
	var meta RuntimeMetadata
	content, err := os.ReadFile(RuntimeMetadataPath())
	if err != nil {
		return meta, err
	}
	err = json.Unmarshal(content, &meta)
	return meta, err
}

func SaveRuntimeMetadata(meta RuntimeMetadata) error {
	if err := EnsureBaseDirs(); err != nil {
		return err
	}
	out, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(RuntimeMetadataPath(), out, 0o644)
}

func LoadPortRegistry() (PortRegistryState, error) {
	var state PortRegistryState
	content, err := os.ReadFile(PortRegistryPath())
	if errors.Is(err, os.ErrNotExist) {
		return PortRegistryState{Slots: []PortSlot{}}, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(content, &state); err != nil {
		return state, err
	}
	if state.Slots == nil {
		state.Slots = []PortSlot{}
	}
	return state, nil
}

func SavePortRegistry(state PortRegistryState) error {
	if err := EnsureBaseDirs(); err != nil {
		return err
	}
	out, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(PortRegistryPath(), out, 0o644)
}

func LoadRepoState(repoID string) (RepoState, error) {
	var state RepoState
	content, err := os.ReadFile(RepoStatePath(repoID))
	if err != nil {
		return state, err
	}
	err = json.Unmarshal(content, &state)
	return state, err
}

func SaveRepoState(repoID string, state RepoState) error {
	if err := os.MkdirAll(RepoDir(repoID), 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(RepoStatePath(repoID), out, 0o644)
}
