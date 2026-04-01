package daemon

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	postgresBasePort = 15432
	redisPort        = 16379
	redisImage       = "redis:7-alpine"
	redisContainer   = "spawntree-redis"
)

func postgresPort(version string) int {
	major, err := strconv.Atoi(version)
	if err != nil {
		return postgresBasePort + 3
	}
	return postgresBasePort + (major - 14)
}

func postgresDataDir(version string) string {
	dir := filepath.Join(SpawntreeHome(), "postgres", version, "data")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func postgresTemplateDir() string {
	dir := filepath.Join(SpawntreeHome(), "postgres", "templates")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func redisDataDir() string {
	dir := filepath.Join(SpawntreeHome(), "redis", "data")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

type PostgresRunner struct {
	Version     string
	Port        int
	containerID string
	status      InfraStatus
}

func NewPostgresRunner(version string) *PostgresRunner {
	return &PostgresRunner{
		Version: version,
		Port:    postgresPort(version),
		status:  InfraStatusStopped,
	}
}

func (p *PostgresRunner) Status() InfraStatus {
	return p.status
}

func (p *PostgresRunner) EnsureRunning(ctx context.Context) error {
	p.status = InfraStatusStarting
	id, state, err := findDockerContainer([]string{
		"spawntree.managed=true",
		"spawntree.type=postgres",
		"spawntree.version=" + p.Version,
	})
	if err == nil && id != "" {
		p.containerID = id
		if state != "running" {
			if _, err := runCommandOutput("docker", "start", id); err != nil {
				p.status = InfraStatusError
				return err
			}
		}
		if err := p.waitForReady(ctx, 60*time.Second); err != nil {
			p.status = InfraStatusError
			return err
		}
		p.status = InfraStatusRunning
		return nil
	}

	tag := fmt.Sprintf("spawntree-postgres:%s", p.Version)
	if _, err := runCommandOutput("docker", "image", "inspect", tag); err != nil {
		if err := p.buildImage(ctx, tag); err != nil {
			p.status = InfraStatusError
			return err
		}
	}

	containerName := fmt.Sprintf("spawntree-postgres-%s", p.Version)
	args := []string{
		"run", "-d",
		"--name", containerName,
		"--label", "spawntree.managed=true",
		"--label", "spawntree.type=postgres",
		"--label", "spawntree.version=" + p.Version,
		"-e", "POSTGRES_HOST_AUTH_METHOD=trust",
		"--restart", "unless-stopped",
		"-p", fmt.Sprintf("127.0.0.1:%d:5432", p.Port),
		"-v", fmt.Sprintf("%s:/var/lib/postgresql/data", postgresDataDir(p.Version)),
		tag,
	}
	output, err := runCommandOutput("docker", args...)
	if err != nil {
		p.status = InfraStatusError
		return err
	}
	p.containerID = strings.TrimSpace(output)
	if err := p.waitForReady(ctx, 60*time.Second); err != nil {
		p.status = InfraStatusError
		return err
	}
	p.status = InfraStatusRunning
	return nil
}

func (p *PostgresRunner) Stop(context.Context) error {
	if p.containerID == "" {
		return nil
	}
	_, _ = runCommandOutput("docker", "stop", p.containerID)
	p.status = InfraStatusStopped
	return nil
}

func (p *PostgresRunner) DatabaseExists(dbName string) bool {
	out, err := runCommandOutput("docker", "exec", p.containerRef(), "psql", "-U", "postgres", "-tAc", fmt.Sprintf("SELECT 1 FROM pg_database WHERE datname='%s'", strings.ReplaceAll(dbName, "'", "''")))
	return err == nil && strings.TrimSpace(out) == "1"
}

func (p *PostgresRunner) CreateDatabase(dbName string) error {
	if p.DatabaseExists(dbName) {
		return nil
	}
	_, err := runCommandOutput("docker", "exec", p.containerRef(), "psql", "-U", "postgres", "-c", fmt.Sprintf(`CREATE DATABASE "%s"`, strings.ReplaceAll(dbName, `"`, `\"`)))
	return err
}

func (p *PostgresRunner) DropDatabase(dbName string) error {
	if !p.DatabaseExists(dbName) {
		return nil
	}
	_, err := runCommandOutput("docker", "exec", p.containerRef(), "psql", "-U", "postgres", "-c", fmt.Sprintf(`DROP DATABASE "%s"`, strings.ReplaceAll(dbName, `"`, `\"`)))
	return err
}

func (p *PostgresRunner) ListDatabases() ([]string, error) {
	out, err := runCommandOutput("docker", "exec", p.containerRef(), "psql", "-U", "postgres", "-tAc", "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(out, "\n")
	result := []string{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			result = append(result, line)
		}
	}
	return result, nil
}

func (p *PostgresRunner) ForkFrom(ctx context.Context, dbName, sourceURL string) error {
	dump := exec.CommandContext(ctx, "pg_dump", "--format=custom", "--no-owner", "--no-acl", sourceURL)
	// #nosec G204 -- command shape is fixed and arguments are passed directly without shell interpolation.
	restore := exec.CommandContext(ctx, "docker", "exec", "-i", p.containerRef(), "pg_restore", "-U", "postgres", "-d", dbName, "--no-owner", "--no-acl", "-v")
	dumpStdout, err := dump.StdoutPipe()
	if err != nil {
		return err
	}
	restore.Stdin = dumpStdout
	restore.Stderr = os.Stderr
	if err := restore.Start(); err != nil {
		return err
	}
	if err := dump.Start(); err != nil {
		return err
	}
	if err := dump.Wait(); err != nil {
		return err
	}
	return restore.Wait()
}

func (p *PostgresRunner) DumpToTemplate(ctx context.Context, dbName, templateName string) error {
	file, err := os.Create(filepath.Join(postgresTemplateDir(), templateName+".dump"))
	if err != nil {
		return err
	}
	defer file.Close()
	// #nosec G204 -- command shape is fixed and arguments are passed directly without shell interpolation.
	cmd := exec.CommandContext(ctx, "docker", "exec", p.containerRef(), "pg_dump", "-U", "postgres", "--format=custom", "--no-owner", "--no-acl", dbName)
	cmd.Stdout = file
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func (p *PostgresRunner) RestoreFromTemplate(ctx context.Context, dbName, templateName string) error {
	path := filepath.Join(postgresTemplateDir(), templateName+".dump")
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := p.CreateDatabase(dbName); err != nil {
		return err
	}
	// #nosec G204 -- command shape is fixed and arguments are passed directly without shell interpolation.
	cmd := exec.CommandContext(ctx, "docker", "exec", "-i", p.containerRef(), "pg_restore", "-U", "postgres", "-d", dbName, "--no-owner", "--no-acl")
	cmd.Stdin = file
	cmd.Stdout = io.Discard
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func (p *PostgresRunner) ListTemplates() []DbTemplate {
	entries, err := os.ReadDir(postgresTemplateDir())
	if err != nil {
		return nil
	}
	result := []DbTemplate{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".dump") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		result = append(result, DbTemplate{
			Name:      strings.TrimSuffix(entry.Name(), ".dump"),
			Size:      info.Size(),
			CreatedAt: info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return result
}

func (p *PostgresRunner) containerRef() string {
	if p.containerID != "" {
		return p.containerID
	}
	return fmt.Sprintf("spawntree-postgres-%s", p.Version)
}

func (p *PostgresRunner) buildImage(ctx context.Context, tag string) error {
	dir := filepath.Join(SpawntreeHome(), "postgres")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dockerfilePath := filepath.Join(dir, fmt.Sprintf("Dockerfile.%s", p.Version))
	content := strings.Join([]string{
		fmt.Sprintf("FROM postgres:%s", p.Version),
		fmt.Sprintf("RUN apt-get update && apt-get install -y --no-install-recommends postgresql-%s-pgvector postgresql-%s-cron postgresql-%s-postgis-3 && rm -rf /var/lib/apt/lists/*", p.Version, p.Version, p.Version),
	}, "\n") + "\n"
	if err := os.WriteFile(dockerfilePath, []byte(content), 0o600); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "docker", "build", "-t", tag, "-f", dockerfilePath, dir)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func (p *PostgresRunner) waitForReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, err := runCommandOutput("docker", "exec", p.containerRef(), "pg_isready", "-U", "postgres")
		if err == nil && strings.Contains(out, "accepting connections") {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("postgres %s did not become ready within %s", p.Version, timeout)
}

type RedisRunner struct {
	Port        int
	containerID string
	status      InfraStatus
	mu          sync.Mutex
	dbIndexMap  map[EnvKey]int
	nextDBIndex int
}

func NewRedisRunner() *RedisRunner {
	return &RedisRunner{
		Port:        redisPort,
		status:      InfraStatusStopped,
		dbIndexMap:  map[EnvKey]int{},
		nextDBIndex: 1,
	}
}

func (r *RedisRunner) Status() InfraStatus { return r.status }

func (r *RedisRunner) EnsureRunning(ctx context.Context) error {
	r.status = InfraStatusStarting
	id, state, err := findDockerContainer([]string{
		"spawntree.managed=true",
		"spawntree.type=redis",
	})
	if err == nil && id != "" {
		r.containerID = id
		if state != "running" {
			if _, err := runCommandOutput("docker", "start", id); err != nil {
				r.status = InfraStatusError
				return err
			}
		}
		if err := r.waitForReady(ctx, 30*time.Second); err != nil {
			r.status = InfraStatusError
			return err
		}
		r.status = InfraStatusRunning
		return nil
	}
	if _, err := runCommandOutput("docker", "image", "inspect", redisImage); err != nil {
		cmd := exec.CommandContext(ctx, "docker", "pull", redisImage)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			r.status = InfraStatusError
			return err
		}
	}
	args := []string{
		"run", "-d",
		"--name", redisContainer,
		"--label", "spawntree.managed=true",
		"--label", "spawntree.type=redis",
		"--restart", "unless-stopped",
		"-p", fmt.Sprintf("127.0.0.1:%d:6379", r.Port),
		"-v", fmt.Sprintf("%s:/data", redisDataDir()),
		redisImage, "redis-server", "--databases", "512", "--appendonly", "yes",
	}
	output, err := runCommandOutput("docker", args...)
	if err != nil {
		r.status = InfraStatusError
		return err
	}
	r.containerID = strings.TrimSpace(output)
	if err := r.waitForReady(ctx, 30*time.Second); err != nil {
		r.status = InfraStatusError
		return err
	}
	r.status = InfraStatusRunning
	return nil
}

func (r *RedisRunner) Stop(context.Context) error {
	if r.containerID == "" {
		return nil
	}
	_, _ = runCommandOutput("docker", "stop", r.containerRef())
	r.status = InfraStatusStopped
	return nil
}

func (r *RedisRunner) AllocateDBIndex(envKey EnvKey) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.dbIndexMap[envKey]; ok {
		return existing
	}
	idx := r.nextDBIndex
	r.nextDBIndex++
	r.dbIndexMap[envKey] = idx
	return idx
}

func (r *RedisRunner) FreeDBIndex(envKey EnvKey) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.dbIndexMap, envKey)
}

func (r *RedisRunner) AllocatedDBCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.dbIndexMap)
}

func (r *RedisRunner) FlushDB(dbIndex int) error {
	_, err := runCommandOutput("docker", "exec", r.containerRef(), "redis-cli", "-n", fmt.Sprintf("%d", dbIndex), "FLUSHDB")
	return err
}

func (r *RedisRunner) waitForReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, err := runCommandOutput("docker", "exec", r.containerRef(), "redis-cli", "PING")
		if err == nil && strings.TrimSpace(out) == "PONG" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("redis did not become ready within %s", timeout)
}

func (r *RedisRunner) containerRef() string {
	if r.containerID != "" {
		return r.containerID
	}
	return redisContainer
}

type InfraManager struct {
	mu       sync.Mutex
	postgres map[string]*PostgresRunner
	redis    *RedisRunner
}

func NewInfraManager() *InfraManager {
	return &InfraManager{
		postgres: map[string]*PostgresRunner{},
	}
}

func (m *InfraManager) EnsurePostgres(ctx context.Context, version string) (*PostgresRunner, error) {
	if version == "" {
		version = "17"
	}
	m.mu.Lock()
	runner := m.postgres[version]
	if runner == nil {
		runner = NewPostgresRunner(version)
		m.postgres[version] = runner
	}
	m.mu.Unlock()
	if runner.Status() != InfraStatusRunning {
		if err := runner.EnsureRunning(ctx); err != nil {
			return nil, err
		}
	}
	return runner, nil
}

func (m *InfraManager) EnsureRedis(ctx context.Context) (*RedisRunner, error) {
	m.mu.Lock()
	if m.redis == nil {
		m.redis = NewRedisRunner()
	}
	runner := m.redis
	m.mu.Unlock()
	if runner.Status() != InfraStatusRunning {
		if err := runner.EnsureRunning(ctx); err != nil {
			return nil, err
		}
	}
	return runner, nil
}

func (m *InfraManager) StopPostgres(ctx context.Context, version string) error {
	if version != "" {
		m.mu.Lock()
		runner := m.postgres[version]
		m.mu.Unlock()
		if runner != nil {
			return runner.Stop(ctx)
		}
		return nil
	}
	m.mu.Lock()
	runners := make([]*PostgresRunner, 0, len(m.postgres))
	for _, runner := range m.postgres {
		runners = append(runners, runner)
	}
	m.mu.Unlock()
	for _, runner := range runners {
		if err := runner.Stop(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (m *InfraManager) StopRedis(ctx context.Context) error {
	m.mu.Lock()
	runner := m.redis
	m.mu.Unlock()
	if runner != nil {
		return runner.Stop(ctx)
	}
	return nil
}

func (m *InfraManager) StopAll(ctx context.Context) error {
	if err := m.StopPostgres(ctx, ""); err != nil {
		return err
	}
	return m.StopRedis(ctx)
}

func (m *InfraManager) GetStatus(_ context.Context) (InfraStatusResponse, error) {
	m.mu.Lock()
	pgRunners := make([]*PostgresRunner, 0, len(m.postgres))
	for _, runner := range m.postgres {
		pgRunners = append(pgRunners, runner)
	}
	redisRunner := m.redis
	m.mu.Unlock()

	resp := InfraStatusResponse{
		Postgres: []PostgresInstanceInfo{},
	}
	for _, runner := range pgRunners {
		databases := []string{}
		if runner.Status() == InfraStatusRunning {
			if values, err := runner.ListDatabases(); err == nil {
				databases = values
			}
		}
		resp.Postgres = append(resp.Postgres, PostgresInstanceInfo{
			Version:     runner.Version,
			Status:      runner.Status(),
			ContainerID: runner.containerID,
			Port:        Port(runner.Port),
			DataDir:     postgresDataDir(runner.Version),
			Databases:   databases,
		})
	}
	if redisRunner != nil {
		resp.Redis = &RedisInstanceInfo{
			Status:             redisRunner.Status(),
			ContainerID:        redisRunner.containerID,
			Port:               Port(redisRunner.Port),
			AllocatedDbIndices: redisRunner.AllocatedDBCount(),
		}
	}
	return resp, nil
}

func findDockerContainer(labels []string) (id string, state string, err error) {
	args := []string{"ps", "-a", "--format", "{{.ID}}\t{{.State}}"}
	for _, label := range labels {
		args = append(args, "--filter", "label="+label)
	}
	out, err := runCommandOutput("docker", args...)
	if err != nil {
		return "", "", err
	}
	scanner := bufio.NewScanner(strings.NewReader(out))
	if scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) >= 2 {
			return strings.TrimSpace(fields[0]), strings.TrimSpace(fields[1]), nil
		}
	}
	return "", "", fmt.Errorf("container not found")
}
