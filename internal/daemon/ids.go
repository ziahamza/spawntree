package daemon

import (
	"encoding/json"
	"fmt"
	"strings"
)

type RepoID string
type EnvID string
type BranchName string
type ServiceName string
type TunnelID string
type Port int

type EnvKey struct {
	Repo RepoID
	Env  EnvID
}

func NewEnvKey(repoID RepoID, envID EnvID) EnvKey {
	return EnvKey{
		Repo: repoID,
		Env:  envID,
	}
}

func (key EnvKey) String() string {
	return fmt.Sprintf("%s:%s", key.Repo, key.Env)
}

func (key EnvKey) MarshalJSON() ([]byte, error) {
	return json.Marshal(key.String())
}

func (key *EnvKey) UnmarshalJSON(data []byte) error {
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	parsed, err := ParseEnvKey(raw)
	if err != nil {
		return err
	}
	*key = parsed
	return nil
}

func ParseEnvKey(value string) (EnvKey, error) {
	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 {
		return EnvKey{}, fmt.Errorf("invalid env key %q", value)
	}
	return EnvKey{
		Repo: RepoID(parts[0]),
		Env:  EnvID(parts[1]),
	}, nil
}

func (port Port) Int() int {
	return int(port)
}
