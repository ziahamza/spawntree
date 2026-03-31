package daemon

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Service interface {
	Name() string
	Type() ServiceType
	Start(context.Context) error
	Stop(context.Context) error
	Status() ServiceStatus
	Healthcheck(context.Context) bool
	PID() *int
	ContainerID() string
}

type ProcessRunner struct {
	name        string
	config      ServiceConfig
	envVars     map[string]string
	cwd         string
	repoID      string
	envID       string
	logStreamer *LogStreamer

	mu     sync.Mutex
	status ServiceStatus
	cmd    *exec.Cmd
}

func NewProcessRunner(name string, config ServiceConfig, envVars map[string]string, cwd, repoID, envID string, logStreamer *LogStreamer) *ProcessRunner {
	return &ProcessRunner{
		name:        name,
		config:      config,
		envVars:     envVars,
		cwd:         cwd,
		repoID:      repoID,
		envID:       envID,
		logStreamer: logStreamer,
		status:      ServiceStatusStopped,
	}
}

func (p *ProcessRunner) Name() string        { return p.name }
func (p *ProcessRunner) Type() ServiceType   { return ServiceTypeProcess }
func (p *ProcessRunner) ContainerID() string { return "" }

func (p *ProcessRunner) PID() *int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	pid := p.cmd.Process.Pid
	return &pid
}

func (p *ProcessRunner) Start(ctx context.Context) error {
	_ = ctx
	if p.config.Command == "" {
		return fmt.Errorf("service %q: command is required for process services", p.name)
	}

	p.mu.Lock()
	p.status = ServiceStatusStarting
	p.mu.Unlock()

	command := p.config.Command
	if port := p.envVars["PORT"]; port != "" && !strings.Contains(command, "--port") {
		command = injectFrameworkFlags(command, port)
	}

	cmd := exec.Command("sh", "-lc", command)
	cmd.Dir = p.cwd
	cmd.Env = mergeEnv(os.Environ(), p.envVars)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	p.mu.Lock()
	p.cmd = cmd
	p.mu.Unlock()

	go streamPipeLines(stdout, func(line string) {
		p.logStreamer.AddLine(p.repoID, p.envID, p.name, "stdout", line)
	})
	go streamPipeLines(stderr, func(line string) {
		p.logStreamer.AddLine(p.repoID, p.envID, p.name, "stderr", line)
	})

	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.status != ServiceStatusStopped {
			p.status = ServiceStatusFailed
			if err != nil {
				p.logStreamer.AddLine(p.repoID, p.envID, p.name, "system", fmt.Sprintf("[spawntree] Process exited: %v", err))
			}
		}
		p.cmd = nil
	}()

	time.Sleep(500 * time.Millisecond)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd == nil {
		return fmt.Errorf("%q exited immediately", p.name)
	}
	p.status = ServiceStatusRunning
	return nil
}

func (p *ProcessRunner) Stop(context.Context) error {
	p.mu.Lock()
	cmd := p.cmd
	p.status = ServiceStatusStopped
	p.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		_, _ = cmd.Process.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
	return nil
}

func (p *ProcessRunner) Status() ServiceStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.status
}

func (p *ProcessRunner) Healthcheck(ctx context.Context) bool {
	return runHealthcheck(ctx, p.config.Healthcheck, p.status == ServiceStatusRunning)
}

type ContainerRunner struct {
	name          string
	config        ServiceConfig
	envVars       map[string]string
	allocatedPort int
	repoID        string
	envID         string
	logStreamer   *LogStreamer
	containerName string

	mu          sync.Mutex
	status      ServiceStatus
	containerID string
	logCmd      *exec.Cmd
}

func NewContainerRunner(name string, config ServiceConfig, envVars map[string]string, allocatedPort int, repoID, envID string, logStreamer *LogStreamer) *ContainerRunner {
	return &ContainerRunner{
		name:          name,
		config:        config,
		envVars:       envVars,
		allocatedPort: allocatedPort,
		repoID:        repoID,
		envID:         envID,
		logStreamer:   logStreamer,
		status:        ServiceStatusStopped,
		containerName: sanitizeDockerName(fmt.Sprintf("spawntree-%s-%s-%s", repoID, envID, name)),
	}
}

func (c *ContainerRunner) Name() string      { return c.name }
func (c *ContainerRunner) Type() ServiceType { return ServiceTypeContainer }
func (c *ContainerRunner) PID() *int         { return nil }
func (c *ContainerRunner) ContainerID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.containerID
}

func (c *ContainerRunner) Start(context.Context) error {
	if c.config.Image == "" {
		return fmt.Errorf("service %q: image is required for container services", c.name)
	}
	c.mu.Lock()
	c.status = ServiceStatusStarting
	c.mu.Unlock()

	_, _ = runCommandOutput("docker", "pull", c.config.Image)
	containerPort := c.config.Port
	if containerPort == 0 {
		containerPort = 80
	}
	args := []string{
		"run", "-d",
		"--name", c.containerName,
		"--label", "spawntree.managed=true",
		"--label", fmt.Sprintf("spawntree.repoId=%s", c.repoID),
		"--label", fmt.Sprintf("spawntree.envId=%s", c.envID),
		"--label", fmt.Sprintf("spawntree.service=%s", c.name),
		"-p", fmt.Sprintf("127.0.0.1:%d:%d", c.allocatedPort, containerPort),
	}
	keys := make([]string, 0, len(c.envVars))
	for key := range c.envVars {
		keys = append(keys, key)
	}
	sortStrings(keys)
	for _, key := range keys {
		args = append(args, "-e", key+"="+c.envVars[key])
	}
	for _, vol := range c.config.Volumes {
		mode := vol.Mode
		if mode == "" {
			mode = "rw"
		}
		args = append(args, "-v", fmt.Sprintf("%s:%s:%s", vol.Host, vol.Container, mode))
	}
	args = append(args, c.config.Image)
	if c.config.Command != "" {
		args = append(args, strings.Fields(c.config.Command)...)
	}
	output, err := runCommandOutput("docker", args...)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.containerID = strings.TrimSpace(output)
	c.status = ServiceStatusRunning
	c.mu.Unlock()

	c.logStreamer.AddLine(c.repoID, c.envID, c.name, "system", fmt.Sprintf("[spawntree-daemon] Container started: %s on port %d", c.config.Image, c.allocatedPort))
	c.attachLogs()
	return nil
}

func (c *ContainerRunner) Stop(context.Context) error {
	c.mu.Lock()
	c.status = ServiceStatusStopped
	logCmd := c.logCmd
	c.logCmd = nil
	c.mu.Unlock()

	if logCmd != nil && logCmd.Process != nil {
		_ = logCmd.Process.Kill()
	}
	_, _ = runCommandOutput("docker", "stop", c.containerName)
	_, _ = runCommandOutput("docker", "rm", "-f", c.containerName)
	return nil
}

func (c *ContainerRunner) Status() ServiceStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

func (c *ContainerRunner) Healthcheck(ctx context.Context) bool {
	if c.config.Healthcheck == nil {
		out, err := runCommandOutput("docker", "inspect", "-f", "{{.State.Running}}", c.containerName)
		return err == nil && strings.TrimSpace(out) == "true"
	}
	return runHealthcheck(ctx, c.config.Healthcheck, c.Status() == ServiceStatusRunning)
}

func (c *ContainerRunner) attachLogs() {
	// #nosec G204 -- command shape is fixed and arguments are passed directly without shell interpolation.
	cmd := exec.Command("docker", "logs", "-f", c.containerName)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		return
	}
	c.mu.Lock()
	c.logCmd = cmd
	c.mu.Unlock()
	go streamPipeLines(stdout, func(line string) {
		c.logStreamer.AddLine(c.repoID, c.envID, c.name, "stdout", line)
	})
	go streamPipeLines(stderr, func(line string) {
		c.logStreamer.AddLine(c.repoID, c.envID, c.name, "stderr", line)
	})
	go func() {
		_ = cmd.Wait()
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.status != ServiceStatusStopped {
			c.status = ServiceStatusFailed
			c.logStreamer.AddLine(c.repoID, c.envID, c.name, "system", "[spawntree-daemon] Container exited")
		}
	}()
}

type ExternalRunner struct {
	name          string
	config        ServiceConfig
	allocatedPort int
	upstreamURL   *url.URL

	mu     sync.Mutex
	status ServiceStatus
	server *http.Server
}

func NewExternalRunner(name string, config ServiceConfig, allocatedPort int) (*ExternalRunner, error) {
	upstream, err := url.Parse(config.URL)
	if err != nil {
		return nil, err
	}
	return &ExternalRunner{
		name:          name,
		config:        config,
		allocatedPort: allocatedPort,
		upstreamURL:   upstream,
		status:        ServiceStatusStopped,
	}, nil
}

func (e *ExternalRunner) Name() string        { return e.name }
func (e *ExternalRunner) Type() ServiceType   { return ServiceTypeExternal }
func (e *ExternalRunner) PID() *int           { return nil }
func (e *ExternalRunner) ContainerID() string { return "" }

func (e *ExternalRunner) Start(context.Context) error {
	e.mu.Lock()
	e.status = ServiceStatusStarting
	e.mu.Unlock()

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", e.allocatedPort))
	if err != nil {
		return err
	}

	proxy := httputil.NewSingleHostReverseProxy(e.upstreamURL)
	proxy.ModifyResponse = func(resp *http.Response) error {
		localOrigin := fmt.Sprintf("http://127.0.0.1:%d", e.allocatedPort)
		if origin := resp.Header.Get("Access-Control-Allow-Origin"); origin != "" && origin != "*" {
			resp.Header.Set("Access-Control-Allow-Origin", localOrigin)
		} else if origin == "" {
			resp.Header.Set("Access-Control-Allow-Origin", "*")
		}
		resp.Header.Set("Access-Control-Allow-Credentials", "true")
		resp.Header.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
		if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
			resp.Header.Set("Cache-Control", "no-cache")
			resp.Header.Set("Connection", "keep-alive")
		}
		resp.Header.Del("X-Frame-Options")
		return nil
	}
	proxy.Director = func(req *http.Request) {
		req.URL.Scheme = e.upstreamURL.Scheme
		req.URL.Host = e.upstreamURL.Host
		req.Host = e.upstreamURL.Host
		if origin := req.Header.Get("Origin"); origin != "" {
			req.Header.Set("Origin", e.upstreamURL.Scheme+"://"+e.upstreamURL.Host)
		}
		if referer := req.Header.Get("Referer"); referer != "" {
			req.Header.Set("Referer", e.upstreamURL.Scheme+"://"+e.upstreamURL.Host)
		}
	}

	e.mu.Lock()
	e.server = &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
				w.WriteHeader(http.StatusNoContent)
				return
			}
			proxy.ServeHTTP(w, r)
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	server := e.server
	e.status = ServiceStatusRunning
	e.mu.Unlock()

	go func() {
		_ = server.Serve(listener)
	}()
	return nil
}

func (e *ExternalRunner) Stop(context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.status = ServiceStatusStopped
	if e.server == nil {
		return nil
	}
	err := e.server.Close()
	e.server = nil
	return err
}

func (e *ExternalRunner) Status() ServiceStatus {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.status
}

func (e *ExternalRunner) Healthcheck(ctx context.Context) bool {
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, e.upstreamURL.String(), nil)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode < 500
}

func runHealthcheck(ctx context.Context, check *HealthcheckConfig, fallback bool) bool {
	if check == nil || check.URL == "" {
		return fallback
	}
	timeout := 2 * time.Second
	if check.Timeout > 0 {
		timeout = time.Duration(check.Timeout) * time.Second
	}
	if strings.HasPrefix(check.URL, "tcp://") {
		target := strings.TrimPrefix(check.URL, "tcp://")
		conn, err := net.DialTimeout("tcp", target, timeout)
		if err != nil {
			return false
		}
		_ = conn.Close()
		return true
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, check.URL, nil)
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 400
}

func mergeEnv(base []string, overrides map[string]string) []string {
	env := map[string]string{}
	for _, item := range base {
		if idx := strings.Index(item, "="); idx >= 0 {
			env[item[:idx]] = item[idx+1:]
		}
	}
	for key, value := range overrides {
		env[key] = value
	}
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sortStrings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+env[key])
	}
	return out
}

func streamPipeLines(reader io.Reader, emit func(string)) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		emit(scanner.Text())
	}
}

func runCommandOutput(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s failed: %s", name, strings.Join(args, " "), strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func sanitizeDockerName(name string) string {
	builder := strings.Builder{}
	for _, ch := range name {
		switch {
		case ch >= 'a' && ch <= 'z':
			builder.WriteRune(ch)
		case ch >= 'A' && ch <= 'Z':
			builder.WriteRune(ch + 32)
		case ch >= '0' && ch <= '9':
			builder.WriteRune(ch)
		case ch == '-' || ch == '_':
			builder.WriteRune(ch)
		default:
			builder.WriteRune('-')
		}
	}
	result := builder.String()
	if len(result) > 63 {
		result = result[:63]
	}
	return strings.Trim(result, "-")
}

func injectFrameworkFlags(command, port string) string {
	lower := strings.ToLower(command)
	switch {
	case strings.Contains(lower, "vite"), strings.Contains(lower, "react-router"):
		return fmt.Sprintf("%s --port %s --host 127.0.0.1 --strictPort", command, port)
	case strings.Contains(lower, "next"):
		return fmt.Sprintf("%s --port %s --hostname 127.0.0.1", command, port)
	case strings.Contains(lower, "astro"), strings.Contains(lower, "nuxt"):
		return fmt.Sprintf("%s --port %s --host 127.0.0.1", command, port)
	case strings.Contains(lower, "expo"), strings.Contains(lower, "react-native"):
		return fmt.Sprintf("%s --port %s", command, port)
	default:
		return command
	}
}

func sortStrings(values []string) {
	for i := 0; i < len(values); i++ {
		for j := i + 1; j < len(values); j++ {
			if values[j] < values[i] {
				values[i], values[j] = values[j], values[i]
			}
		}
	}
}
