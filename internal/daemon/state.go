package daemon

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

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
	if err := EnsureBaseDirs(); err != nil {
		return GlobalConfig{}, err
	}

	cfg, err := readStructuredFile(GlobalConfigPath(), func(data []byte, target *GlobalConfig) error {
		return yaml.Unmarshal(data, target)
	})
	if errors.Is(err, os.ErrNotExist) {
		return GlobalConfig{
			Repos:   map[string]RegisteredRepo{},
			Tunnels: map[string]TunnelDefinition{},
		}, nil
	}
	if err != nil {
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
	if err := EnsureBaseDirs(); err != nil {
		return err
	}
	if cfg.Repos == nil {
		cfg.Repos = map[string]RegisteredRepo{}
	}
	if cfg.Tunnels == nil {
		cfg.Tunnels = map[string]TunnelDefinition{}
	}
	return writeStructuredFile(GlobalConfigPath(), cfg, func(value GlobalConfig) ([]byte, error) {
		return yaml.Marshal(value)
	})
}

func LoadRuntimeMetadata() (RuntimeMetadata, error) {
	return readStructuredFile(RuntimeMetadataPath(), func(data []byte, target *RuntimeMetadata) error {
		return json.Unmarshal(data, target)
	})
}

func SaveRuntimeMetadata(meta RuntimeMetadata) error {
	if err := EnsureBaseDirs(); err != nil {
		return err
	}
	return writeStructuredFile(RuntimeMetadataPath(), meta, func(value RuntimeMetadata) ([]byte, error) {
		return json.MarshalIndent(value, "", "  ")
	})
}

func LoadPortRegistry() (PortRegistryState, error) {
	state, err := readStructuredFile(PortRegistryPath(), func(data []byte, target *PortRegistryState) error {
		return json.Unmarshal(data, target)
	})
	if errors.Is(err, os.ErrNotExist) {
		return PortRegistryState{Slots: []PortSlot{}}, nil
	}
	if err != nil {
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
	return writeStructuredFile(PortRegistryPath(), state, func(value PortRegistryState) ([]byte, error) {
		return json.MarshalIndent(value, "", "  ")
	})
}

func LoadRepoState(repoID string) (RepoState, error) {
	return readStructuredFile(RepoStatePath(repoID), func(data []byte, target *RepoState) error {
		return json.Unmarshal(data, target)
	})
}

func SaveRepoState(repoID string, state RepoState) error {
	if err := os.MkdirAll(RepoDir(repoID), 0o755); err != nil {
		return err
	}
	return writeStructuredFile(RepoStatePath(repoID), state, func(value RepoState) ([]byte, error) {
		return json.MarshalIndent(value, "", "  ")
	})
}

func readStructuredFile[T any](path string, unmarshal func([]byte, *T) error) (T, error) {
	var value T
	content, err := os.ReadFile(path)
	if err != nil {
		return value, err
	}
	if err := unmarshal(content, &value); err != nil {
		return value, err
	}
	return value, nil
}

func writeStructuredFile[T any](path string, value T, marshal func(T) ([]byte, error)) error {
	out, err := marshal(value)
	if err != nil {
		return err
	}
	if len(out) == 0 || out[len(out)-1] != '\n' {
		out = append(out, '\n')
	}
	return os.WriteFile(path, out, 0o600)
}
