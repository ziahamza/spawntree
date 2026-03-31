package daemon

type ServiceStatus string

const (
	ServiceStatusStarting ServiceStatus = "starting"
	ServiceStatusRunning  ServiceStatus = "running"
	ServiceStatusFailed   ServiceStatus = "failed"
	ServiceStatusStopped  ServiceStatus = "stopped"
)

type ServiceType string

const (
	ServiceTypeProcess   ServiceType = "process"
	ServiceTypeContainer ServiceType = "container"
	ServiceTypePostgres  ServiceType = "postgres"
	ServiceTypeRedis     ServiceType = "redis"
	ServiceTypeExternal  ServiceType = "external"
)

type InfraStatus string

const (
	InfraStatusRunning  InfraStatus = "running"
	InfraStatusStopped  InfraStatus = "stopped"
	InfraStatusStarting InfraStatus = "starting"
	InfraStatusError    InfraStatus = "error"
)

type ServiceInfo struct {
	Name        string        `json:"name" yaml:"name"`
	Type        ServiceType   `json:"type" yaml:"type"`
	Status      ServiceStatus `json:"status" yaml:"status"`
	Port        int           `json:"port" yaml:"port"`
	PID         *int          `json:"pid,omitempty" yaml:"pid,omitempty"`
	URL         string        `json:"url,omitempty" yaml:"url,omitempty"`
	ContainerID string        `json:"containerId,omitempty" yaml:"containerId,omitempty"`
}

type EnvInfo struct {
	EnvID     string        `json:"envId" yaml:"envId"`
	RepoID    string        `json:"repoId" yaml:"repoId"`
	RepoPath  string        `json:"repoPath" yaml:"repoPath"`
	Branch    string        `json:"branch" yaml:"branch"`
	BasePort  int           `json:"basePort" yaml:"basePort"`
	CreatedAt string        `json:"createdAt" yaml:"createdAt"`
	Services  []ServiceInfo `json:"services" yaml:"services"`
}

type DaemonInfo struct {
	Version    string `json:"version" yaml:"version"`
	PID        int    `json:"pid" yaml:"pid"`
	Uptime     int64  `json:"uptime" yaml:"uptime"`
	Repos      int    `json:"repos" yaml:"repos"`
	ActiveEnvs int    `json:"activeEnvs" yaml:"activeEnvs"`
}

type PostgresInstanceInfo struct {
	Version     string      `json:"version" yaml:"version"`
	Status      InfraStatus `json:"status" yaml:"status"`
	ContainerID string      `json:"containerId,omitempty" yaml:"containerId,omitempty"`
	Port        int         `json:"port" yaml:"port"`
	DataDir     string      `json:"dataDir" yaml:"dataDir"`
	Databases   []string    `json:"databases" yaml:"databases"`
}

type RedisInstanceInfo struct {
	Status             InfraStatus `json:"status" yaml:"status"`
	ContainerID        string      `json:"containerId,omitempty" yaml:"containerId,omitempty"`
	Port               int         `json:"port" yaml:"port"`
	AllocatedDbIndices int         `json:"allocatedDbIndices" yaml:"allocatedDbIndices"`
}

type InfraStatusResponse struct {
	Postgres []PostgresInstanceInfo `json:"postgres" yaml:"postgres"`
	Redis    *RedisInstanceInfo     `json:"redis" yaml:"redis"`
}

type CreateEnvRequest struct {
	RepoPath     string            `json:"repoPath"`
	EnvID        string            `json:"envId,omitempty"`
	Prefix       string            `json:"prefix,omitempty"`
	EnvOverrides map[string]string `json:"envOverrides,omitempty"`
	ConfigFile   string            `json:"configFile,omitempty"`
}

type CreateEnvResponse struct {
	Env EnvInfo `json:"env"`
}

type GetEnvResponse struct {
	Env EnvInfo `json:"env"`
}

type ListEnvsResponse struct {
	Envs []EnvInfo `json:"envs"`
}

type DeleteEnvResponse struct {
	OK bool `json:"ok"`
}

type DownEnvResponse struct {
	OK bool `json:"ok"`
}

type LogLine struct {
	TS      string `json:"ts" yaml:"ts"`
	Service string `json:"service" yaml:"service"`
	Stream  string `json:"stream" yaml:"stream"`
	Line    string `json:"line" yaml:"line"`
}

type StopInfraRequest struct {
	Target  string `json:"target"`
	Version string `json:"version,omitempty"`
}

type StopInfraResponse struct {
	OK bool `json:"ok"`
}

type DbTemplate struct {
	Name              string `json:"name"`
	Size              int64  `json:"size"`
	CreatedAt         string `json:"createdAt"`
	SourceDatabaseURL string `json:"sourceDatabaseUrl,omitempty"`
}

type ListDBTemplatesResponse struct {
	Templates []DbTemplate `json:"templates"`
}

type DumpDBRequest struct {
	RepoPath     string `json:"repoPath"`
	EnvID        string `json:"envId"`
	DBName       string `json:"dbName"`
	TemplateName string `json:"templateName"`
}

type DumpDBResponse struct {
	Template DbTemplate `json:"template"`
}

type RestoreDBRequest struct {
	RepoPath     string `json:"repoPath"`
	EnvID        string `json:"envId"`
	DBName       string `json:"dbName"`
	TemplateName string `json:"templateName"`
}

type RestoreDBResponse struct {
	OK bool `json:"ok"`
}

type APIError struct {
	Error   string `json:"error"`
	Code    string `json:"code"`
	Details any    `json:"details,omitempty"`
}

type HTTPListenerConfig struct {
	Port int `json:"port,omitempty" yaml:"port,omitempty"`
}

type ProxySettings struct {
	Port int `json:"port,omitempty" yaml:"port,omitempty"`
}

type DaemonConfig struct {
	HTTP  HTTPListenerConfig `json:"http,omitempty" yaml:"http,omitempty"`
	Proxy ProxySettings      `json:"proxy,omitempty" yaml:"proxy,omitempty"`
}

type RegisteredRepo struct {
	RepoID     string `json:"repoId" yaml:"repoId"`
	RepoPath   string `json:"repoPath" yaml:"repoPath"`
	ConfigPath string `json:"configPath" yaml:"configPath"`
	LastSeenAt string `json:"lastSeenAt" yaml:"lastSeenAt"`
}

type TunnelDefinition struct {
	ID       string            `json:"id" yaml:"id"`
	Provider string            `json:"provider" yaml:"provider"`
	Target   TunnelTarget      `json:"target" yaml:"target"`
	Enabled  bool              `json:"enabled" yaml:"enabled"`
	Config   map[string]string `json:"config,omitempty" yaml:"config,omitempty"`
}

type TunnelTarget struct {
	RepoID      string `json:"repoId,omitempty" yaml:"repoId,omitempty"`
	EnvID       string `json:"envId,omitempty" yaml:"envId,omitempty"`
	ServiceName string `json:"serviceName,omitempty" yaml:"serviceName,omitempty"`
}

type TunnelStatusInfo struct {
	ID        string `json:"id" yaml:"id"`
	Provider  string `json:"provider" yaml:"provider"`
	State     string `json:"state" yaml:"state"`
	PublicURL string `json:"publicUrl,omitempty" yaml:"publicUrl,omitempty"`
	LastError string `json:"lastError,omitempty" yaml:"lastError,omitempty"`
}

type GlobalConfig struct {
	Daemon  DaemonConfig                `json:"daemon,omitempty" yaml:"daemon,omitempty"`
	Repos   map[string]RegisteredRepo   `json:"repos,omitempty" yaml:"repos,omitempty"`
	Tunnels map[string]TunnelDefinition `json:"tunnels,omitempty" yaml:"tunnels,omitempty"`
}

type RegisterRepoRequest struct {
	RepoPath   string `json:"repoPath"`
	ConfigPath string `json:"configPath"`
}

type RegisterRepoResponse struct {
	Repo RegisteredRepo `json:"repo"`
}

type ListRegisteredReposResponse struct {
	Repos []RegisteredRepo `json:"repos"`
}

type ListTunnelsResponse struct {
	Tunnels []TunnelDefinition `json:"tunnels"`
}

type UpsertTunnelRequest struct {
	ID       string            `json:"id"`
	Provider string            `json:"provider"`
	Target   TunnelTarget      `json:"target"`
	Enabled  bool              `json:"enabled"`
	Config   map[string]string `json:"config,omitempty"`
}

type UpsertTunnelResponse struct {
	Tunnel TunnelDefinition `json:"tunnel"`
}

type ListTunnelStatusesResponse struct {
	Statuses []TunnelStatusInfo `json:"statuses"`
}

type RuntimeMetadata struct {
	PID        int    `json:"pid"`
	StartedAt  string `json:"startedAt"`
	SocketPath string `json:"socketPath"`
	HTTPPort   int    `json:"httpPort"`
}

type PortSlot struct {
	EnvKey      string `json:"envKey"`
	BasePort    int    `json:"basePort"`
	AllocatedAt string `json:"allocatedAt"`
}

type PortRegistryState struct {
	Slots []PortSlot `json:"slots"`
}

type RepoEnvRecord struct {
	EnvID     string        `json:"envId"`
	RepoID    string        `json:"repoId"`
	RepoPath  string        `json:"repoPath"`
	Branch    string        `json:"branch"`
	BasePort  int           `json:"basePort"`
	CreatedAt string        `json:"createdAt"`
	Services  []ServiceInfo `json:"services"`
}

type RepoState struct {
	RepoID   string          `json:"repoId"`
	RepoPath string          `json:"repoPath"`
	Envs     []RepoEnvRecord `json:"envs"`
}

type HealthcheckConfig struct {
	URL      string `json:"url" yaml:"url"`
	Timeout  int    `json:"timeout,omitempty" yaml:"timeout,omitempty"`
	Interval int    `json:"interval,omitempty" yaml:"interval,omitempty"`
}

type VolumeConfig struct {
	Host      string `json:"host" yaml:"host"`
	Container string `json:"container" yaml:"container"`
	Mode      string `json:"mode,omitempty" yaml:"mode,omitempty"`
}

type ServiceConfig struct {
	Type        ServiceType        `json:"type" yaml:"type"`
	Command     string             `json:"command,omitempty" yaml:"command,omitempty"`
	Port        int                `json:"port,omitempty" yaml:"port,omitempty"`
	Image       string             `json:"image,omitempty" yaml:"image,omitempty"`
	URL         string             `json:"url,omitempty" yaml:"url,omitempty"`
	Toolchain   map[string]string  `json:"toolchain,omitempty" yaml:"toolchain,omitempty"`
	Healthcheck *HealthcheckConfig `json:"healthcheck,omitempty" yaml:"healthcheck,omitempty"`
	DependsOn   []string           `json:"depends_on,omitempty" yaml:"depends_on,omitempty"`
	Environment map[string]string  `json:"environment,omitempty" yaml:"environment,omitempty"`
	ForkFrom    string             `json:"fork_from,omitempty" yaml:"fork_from,omitempty"`
	Volumes     []VolumeConfig     `json:"volumes,omitempty" yaml:"volumes,omitempty"`
}

type SpawntreeConfig struct {
	Proxy        *ProxySettings           `json:"proxy,omitempty" yaml:"proxy,omitempty"`
	Services     map[string]ServiceConfig `json:"services" yaml:"services"`
	ServiceOrder []string                 `json:"-" yaml:"-"`
}

func DeriveRepoID(repoPath string) string {
	last := ""
	for _, ch := range repoPath {
		if ch == '/' {
			continue
		}
		last += string(ch)
	}
	parts := splitPath(repoPath)
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			return sanitizeID(parts[i])
		}
	}
	return sanitizeID(last)
}

func splitPath(path string) []string {
	var parts []string
	current := ""
	for _, r := range path {
		if r == '/' {
			parts = append(parts, current)
			current = ""
			continue
		}
		current += string(r)
	}
	parts = append(parts, current)
	return parts
}

func sanitizeID(value string) string {
	out := make([]rune, 0, len(value))
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
			out = append(out, r+32)
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-':
			out = append(out, r)
		default:
			out = append(out, '-')
		}
	}
	if len(out) == 0 {
		return "unknown"
	}
	return string(out)
}
