package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type ManagedEnv struct {
	EnvID             EnvID
	RepoID            RepoID
	RepoPath          string
	Branch            BranchName
	BasePort          Port
	CreatedAt         string
	Config            SpawntreeConfig
	Services          map[string]Service
	ServiceOrder      []string
	WorktreePath      string
	RedisDBIndices    map[string]int
	PostgresDatabases map[string]string
}

type EnvManager struct {
	state        *StateStore
	portRegistry *PortRegistry
	logStreamer  *LogStreamer
	infraManager *InfraManager
	proxy        *ProxyServer
}

func NewEnvManager(state *StateStore, portRegistry *PortRegistry, logStreamer *LogStreamer, infraManager *InfraManager, proxy *ProxyServer) *EnvManager {
	return &EnvManager{
		state:        state,
		portRegistry: portRegistry,
		logStreamer:  logStreamer,
		infraManager: infraManager,
		proxy:        proxy,
	}
}

func (m *EnvManager) CreateEnv(ctx context.Context, req CreateEnvRequest) (EnvInfo, error) {
	configPath := req.ConfigFile
	if configPath == "" {
		configPath = "spawntree.yaml"
	}
	if !filepath.IsAbs(configPath) {
		configPath = filepath.Join(req.RepoPath, configPath)
	}
	configDir := filepath.Dir(configPath)

	gitRoot, err := ValidateGitRepo(configDir)
	if err != nil {
		return EnvInfo{}, err
	}
	branch := BranchName(CurrentBranch(gitRoot))
	repoID := DeriveRepoID(gitRoot)
	safeBranch := EnvID(strings.ReplaceAll(string(branch), "/", "-"))
	envID := req.EnvID
	if envID == "" {
		if req.Prefix != "" {
			envID = EnvID(string(safeBranch) + "-" + req.Prefix)
		} else {
			envID = safeBranch
		}
	}
	envKey := NewEnvKey(repoID, envID)

	existing, err := m.state.GetManagedEnv(repoID, envID)
	if err == nil {
		return m.toEnvInfo(existing), nil
	}

	content, err := os.ReadFile(configPath)
	if err != nil {
		return EnvInfo{}, err
	}
	envVars, err := LoadEnv(string(envID), configDir, req.EnvOverrides)
	if err != nil {
		return EnvInfo{}, err
	}
	config, err := ParseConfig(content, envVars)
	if err != nil {
		return EnvInfo{}, err
	}
	if errs := ValidateConfig(config); len(errs) > 0 {
		lines := []string{"Config validation failed:"}
		for _, item := range errs {
			lines = append(lines, fmt.Sprintf("  %s: %s", item.Path, item.Message))
		}
		return EnvInfo{}, errors.New(strings.Join(lines, "\n"))
	}

	basePort, err := m.portRegistry.Allocate(envKey)
	if err != nil {
		return EnvInfo{}, err
	}

	serviceCwd := configDir
	worktreePath := gitRoot
	if envID != safeBranch || req.Prefix != "" {
		wm := NewWorktreeManager(gitRoot)
		if err := wm.EnsureGitignore(); err != nil {
			return EnvInfo{}, err
		}
		worktreePath, err = wm.Create(string(envID))
		if err != nil {
			return EnvInfo{}, err
		}
		if strings.HasPrefix(configDir, gitRoot) {
			relative := strings.TrimPrefix(configDir, gitRoot)
			relative = strings.TrimPrefix(relative, string(os.PathSeparator))
			if relative != "" {
				serviceCwd = filepath.Join(worktreePath, relative)
			} else {
				serviceCwd = worktreePath
			}
		}
	}

	for _, name := range config.ServiceOrder {
		if err := m.logStreamer.InitService(repoID, envID, name); err != nil {
			return EnvInfo{}, err
		}
	}

	_ = m.proxy.Start()

	infraEnvVars := map[string]string{}
	redisDBIndices := map[string]int{}
	postgresDatabases := map[string]string{}
	firstPostgres := true
	for _, name := range config.ServiceOrder {
		serviceConfig := config.Services[name]
		switch serviceConfig.Type {
		case ServiceTypePostgres:
			if envVars["DATABASE_URL"] != "" {
				continue
			}
			version := "17"
			if serviceConfig.Toolchain != nil && serviceConfig.Toolchain["version"] != "" {
				version = serviceConfig.Toolchain["version"]
			}
			pgRunner, err := m.infraManager.EnsurePostgres(ctx, version)
			if err != nil {
				return EnvInfo{}, err
			}
			dbName := strings.ToLower(fmt.Sprintf("spawntree_%s_%s_%s", repoID, envID, name))
			dbName = sanitizeDBName(dbName)
			if err := pgRunner.CreateDatabase(dbName); err != nil {
				return EnvInfo{}, err
			}
			postgresDatabases[name] = dbName
			resolvedForkFrom := ""
			if serviceConfig.ForkFrom != "" {
				resolvedForkFrom = substituteVars(serviceConfig.ForkFrom, mergeStringMaps(envVars, infraEnvVars), nil)
			}
			if resolvedForkFrom != "" {
				if err := pgRunner.ForkFrom(ctx, dbName, resolvedForkFrom); err != nil {
					return EnvInfo{}, err
				}
			}
			pgURL := fmt.Sprintf("postgresql://postgres@localhost:%d/%s", pgRunner.Port, dbName)
			upper := strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
			if firstPostgres {
				infraEnvVars["DATABASE_URL"] = pgURL
				infraEnvVars["DB_HOST"] = "127.0.0.1"
				infraEnvVars["DB_PORT"] = fmt.Sprintf("%d", pgRunner.Port)
				infraEnvVars["DB_NAME"] = dbName
				firstPostgres = false
			}
			infraEnvVars[upper+"_DATABASE_URL"] = pgURL
			infraEnvVars[upper+"_HOST"] = "127.0.0.1"
			infraEnvVars[upper+"_PORT"] = fmt.Sprintf("%d", pgRunner.Port)
			infraEnvVars[upper+"_NAME"] = dbName
		case ServiceTypeRedis:
			if envVars["REDIS_URL"] != "" {
				continue
			}
			redisRunner, err := m.infraManager.EnsureRedis(ctx)
			if err != nil {
				return EnvInfo{}, err
			}
			dbIndex := redisRunner.AllocateDBIndex(envKey)
			redisDBIndices[name] = dbIndex
			infraEnvVars["REDIS_URL"] = fmt.Sprintf("redis://localhost:%d/%d", redisRunner.Port, dbIndex)
			infraEnvVars["REDIS_HOST"] = "127.0.0.1"
			infraEnvVars["REDIS_PORT"] = fmt.Sprintf("%d", redisRunner.Port)
			infraEnvVars["REDIS_DB"] = fmt.Sprintf("%d", dbIndex)
		}
	}

	serviceOrder, err := topologicalSort(config)
	if err != nil {
		return EnvInfo{}, err
	}
	services := map[string]Service{}
	for _, name := range serviceOrder {
		serviceConfig := config.Services[name]
		if serviceConfig.Type == ServiceTypePostgres || serviceConfig.Type == ServiceTypeRedis {
			continue
		}
		port, err := m.portRegistry.GetPhysicalPort(basePort, indexOf(config.ServiceOrder, name))
		if err != nil {
			return EnvInfo{}, err
		}
		serviceEnv := m.buildServiceEnvVars(name, serviceConfig, mergeStringMaps(envVars, infraEnvVars), envID, serviceCwd, basePort, config)
		resolved := ResolveServiceConfig(serviceConfig, serviceEnv)
		service, err := m.createService(name, resolved, serviceEnv, serviceCwd, repoID, envID, port)
		if err != nil {
			return EnvInfo{}, err
		}
		services[name] = service
		if err := service.Start(ctx); err != nil {
			_ = m.stopServices(ctx, services, reverse(serviceOrder[:indexOf(serviceOrder, name)+1]))
			return EnvInfo{}, err
		}
		if resolved.Healthcheck != nil {
			timeout := 30
			if resolved.Healthcheck.Timeout > 0 {
				timeout = resolved.Healthcheck.Timeout
			}
			if !waitForHealthy(ctx, service, time.Duration(timeout)*time.Second) {
				_ = m.stopServices(ctx, services, reverse(serviceOrder[:indexOf(serviceOrder, name)+1]))
				return EnvInfo{}, fmt.Errorf("healthcheck failed for %q after %ds", name, timeout)
			}
		}
		if m.proxy.IsRunning() {
			_ = m.proxy.Register(fmt.Sprintf("%s-%s.localhost", name, envID), port.Int())
		}
	}

	managed := &ManagedEnv{
		EnvID:             envID,
		RepoID:            repoID,
		RepoPath:          gitRoot,
		Branch:            branch,
		BasePort:          basePort,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
		Config:            config,
		Services:          services,
		ServiceOrder:      serviceOrder,
		WorktreePath:      worktreePath,
		RedisDBIndices:    redisDBIndices,
		PostgresDatabases: postgresDatabases,
	}

	m.state.PutManagedEnv(managed)
	if err := m.persistRepoState(repoID); err != nil {
		return EnvInfo{}, err
	}
	return m.toEnvInfo(managed), nil
}

func (m *EnvManager) DownEnv(ctx context.Context, repoID, envID string) error {
	managed, err := m.getManaged(RepoID(repoID), EnvID(envID))
	if err != nil {
		return err
	}
	if err := m.stopServices(ctx, managed.Services, reverse(managed.ServiceOrder)); err != nil {
		return err
	}
	for _, hostname := range m.proxy.RegisteredHostnames() {
		if strings.Contains(hostname, "-"+envID+".localhost") {
			m.proxy.Unregister(hostname)
		}
	}
	return m.persistRepoState(RepoID(repoID))
}

func (m *EnvManager) DeleteEnv(ctx context.Context, repoID, envID string) error {
	managed, err := m.getManaged(RepoID(repoID), EnvID(envID))
	if err != nil {
		return err
	}
	envKey := NewEnvKey(RepoID(repoID), EnvID(envID))
	if err := m.stopServices(ctx, managed.Services, reverse(managed.ServiceOrder)); err != nil {
		return err
	}
	for _, hostname := range m.proxy.RegisteredHostnames() {
		if strings.Contains(hostname, "-"+envID+".localhost") {
			m.proxy.Unregister(hostname)
		}
	}
	if len(managed.RedisDBIndices) > 0 {
		if runner, err := m.infraManager.EnsureRedis(ctx); err == nil {
			for _, dbIndex := range managed.RedisDBIndices {
				_ = runner.FlushDB(dbIndex)
			}
			runner.FreeDBIndex(envKey)
		}
	}
	for serviceName, dbName := range managed.PostgresDatabases {
		if runner, err := m.infraManager.EnsurePostgres(ctx, "17"); err == nil {
			_ = runner.DropDatabase(dbName)
		}
		_ = serviceName
	}
	wm := NewWorktreeManager(managed.RepoPath)
	_ = wm.Remove(string(envID))
	m.logStreamer.CloseEnv(RepoID(repoID), EnvID(envID))
	_ = m.portRegistry.Free(envKey)

	m.state.DeleteManagedEnv(RepoID(repoID), EnvID(envID))
	return m.persistRepoState(RepoID(repoID))
}

func (m *EnvManager) GetEnv(repoID, envID string) (EnvInfo, error) {
	managed, err := m.getManaged(RepoID(repoID), EnvID(envID))
	if err != nil {
		return EnvInfo{}, err
	}
	return m.toEnvInfo(managed), nil
}

func (m *EnvManager) ListEnvs(repoID string) []EnvInfo {
	repoKey := RepoID(repoID)
	result := []EnvInfo{}
	for _, managed := range m.state.ListManagedEnvs(repoKey) {
		result = append(result, m.toEnvInfo(managed))
	}
	return result
}

func (m *EnvManager) getManaged(repoID RepoID, envID EnvID) (*ManagedEnv, error) {
	return m.state.GetManagedEnv(repoID, envID)
}

func (m *EnvManager) buildServiceEnvVars(name string, serviceConfig ServiceConfig, baseEnvVars map[string]string, envID EnvID, worktreePath string, basePort Port, config SpawntreeConfig) map[string]string {
	port, _ := m.portRegistry.GetPhysicalPort(basePort, indexOf(config.ServiceOrder, name))
	vars := mergeStringMaps(baseEnvVars, map[string]string{
		"PORT":      fmt.Sprintf("%d", port),
		"HOST":      "127.0.0.1",
		"ENV_NAME":  string(envID),
		"STATE_DIR": filepath.Join(worktreePath, ".spawntree", "state", string(envID)),
		"PORTLESS":  "0",
	})
	for _, otherName := range config.ServiceOrder {
		otherConfig := config.Services[otherName]
		if otherConfig.Type == ServiceTypePostgres || otherConfig.Type == ServiceTypeRedis {
			continue
		}
		otherPort, _ := m.portRegistry.GetPhysicalPort(basePort, indexOf(config.ServiceOrder, otherName))
		upper := strings.ToUpper(strings.ReplaceAll(otherName, "-", "_"))
		vars[upper+"_HOST"] = "127.0.0.1"
		vars[upper+"_PORT"] = fmt.Sprintf("%d", otherPort)
		if m.proxy.IsRunning() {
			vars[upper+"_URL"] = fmt.Sprintf("http://%s-%s.localhost:%d", otherName, envID, m.proxy.Port())
		} else {
			vars[upper+"_URL"] = fmt.Sprintf("http://127.0.0.1:%d", otherPort)
		}
	}
	if len(serviceConfig.Environment) > 0 {
		env := map[string]string{}
		for key, value := range serviceConfig.Environment {
			env[key] = substituteVars(value, vars, nil)
		}
		for key, value := range env {
			vars[key] = value
		}
	}
	return vars
}

func (m *EnvManager) createService(name string, config ServiceConfig, envVars map[string]string, cwd string, repoID RepoID, envID EnvID, port Port) (Service, error) {
	switch config.Type {
	case ServiceTypeProcess:
		return NewProcessRunner(name, config, envVars, cwd, string(repoID), string(envID), m.logStreamer), nil
	case ServiceTypeContainer:
		return NewContainerRunner(name, config, envVars, port.Int(), string(repoID), string(envID), m.logStreamer), nil
	case ServiceTypeExternal:
		return NewExternalRunner(name, config, port.Int())
	default:
		return nil, fmt.Errorf("unknown or unsupported service type: %s", config.Type)
	}
}

func (m *EnvManager) stopServices(ctx context.Context, services map[string]Service, order []string) error {
	for _, name := range order {
		service := services[name]
		if service == nil || service.Status() == ServiceStatusStopped {
			continue
		}
		if err := service.Stop(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (m *EnvManager) toEnvInfo(managed *ManagedEnv) EnvInfo {
	services := []ServiceInfo{}
	for _, name := range managed.Config.ServiceOrder {
		service := managed.Services[name]
		serviceConfig := managed.Config.Services[name]
		port, _ := m.portRegistry.GetPhysicalPort(managed.BasePort, indexOf(managed.Config.ServiceOrder, name))
		status := ServiceStatusStopped
		pid := (*int)(nil)
		containerID := ""
		if service != nil {
			status = service.Status()
			pid = service.PID()
			containerID = service.ContainerID()
		}
		url := fmt.Sprintf("http://127.0.0.1:%d", port)
		if serviceConfig.Type == ServiceTypeExternal {
			url = serviceConfig.URL
		} else if m.proxy.IsRunning() && serviceConfig.Type != ServiceTypePostgres && serviceConfig.Type != ServiceTypeRedis {
			url = fmt.Sprintf("http://%s-%s.localhost:%d", name, managed.EnvID, m.proxy.Port())
		}
		services = append(services, ServiceInfo{
			Name:        ServiceName(name),
			Type:        serviceConfig.Type,
			Status:      status,
			Port:        port,
			PID:         pid,
			URL:         url,
			ContainerID: containerID,
		})
	}
	return EnvInfo{
		EnvID:     managed.EnvID,
		RepoID:    managed.RepoID,
		RepoPath:  managed.RepoPath,
		Branch:    managed.Branch,
		BasePort:  managed.BasePort,
		CreatedAt: managed.CreatedAt,
		Services:  services,
	}
}

func (m *EnvManager) persistRepoState(repoID RepoID) error {
	repoEnvs := m.state.ListManagedEnvs(repoID)
	state := RepoState{
		RepoID: repoID,
	}
	if len(repoEnvs) > 0 {
		for _, managed := range repoEnvs {
			state.RepoPath = managed.RepoPath
			envRecord := RepoEnvRecord{
				EnvID:     managed.EnvID,
				RepoID:    managed.RepoID,
				RepoPath:  managed.RepoPath,
				Branch:    managed.Branch,
				BasePort:  managed.BasePort,
				CreatedAt: managed.CreatedAt,
				Services:  m.toEnvInfo(managed).Services,
			}
			state.Envs = append(state.Envs, envRecord)
		}
	} else if previous, err := LoadRepoState(repoID); err == nil {
		state.RepoPath = previous.RepoPath
	}
	return SaveRepoState(repoID, state)
}

func topologicalSort(config SpawntreeConfig) ([]string, error) {
	result := []string{}
	visited := map[string]bool{}
	visiting := map[string]bool{}
	var visit func(string) error
	visit = func(name string) error {
		if visited[name] {
			return nil
		}
		if visiting[name] {
			return fmt.Errorf("circular dependency detected involving %q", name)
		}
		visiting[name] = true
		for _, dep := range config.Services[name].DependsOn {
			if err := visit(dep); err != nil {
				return err
			}
		}
		delete(visiting, name)
		visited[name] = true
		result = append(result, name)
		return nil
	}
	for _, name := range config.ServiceOrder {
		if err := visit(name); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func waitForHealthy(ctx context.Context, service Service, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if service.Healthcheck(ctx) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(time.Second):
		}
	}
	return false
}

func reverse(values []string) []string {
	out := make([]string, len(values))
	copy(out, values)
	for i := 0; i < len(out)/2; i++ {
		j := len(out) - 1 - i
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func indexOf(values []string, target string) int {
	for i, value := range values {
		if value == target {
			return i
		}
	}
	return -1
}

func mergeStringMaps(base map[string]string, extra map[string]string) map[string]string {
	result := map[string]string{}
	for key, value := range base {
		result[key] = value
	}
	for key, value := range extra {
		result[key] = value
	}
	return result
}

func sanitizeDBName(name string) string {
	replacer := strings.NewReplacer("-", "_", "/", "_", ".", "_")
	name = replacer.Replace(name)
	if len(name) > 63 {
		name = name[:63]
	}
	return name
}
