package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ziahamza/spawntree/internal/daemon"
)

const daemonVersion = "0.2.0"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "spawntreed: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	if err := daemon.EnsureBaseDirs(); err != nil {
		return err
	}

	stateStore, err := daemon.NewStateStore()
	if err != nil {
		return err
	}

	// Open SQLite database for web UI state
	db, err := daemon.OpenDB(daemon.DBPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: failed to open database: %v (web UI will be limited)\n", err)
		db = nil
	}

	logStreamer := daemon.NewLogStreamer()
	infraManager := daemon.NewInfraManager()
	portRegistry := daemon.NewPortRegistry(stateStore)
	registryManager := daemon.NewRegistryManager(stateStore)

	proxyPort := registryManager.DaemonConfig().Proxy.Port
	proxy := daemon.NewProxyServer(proxyPort.Int())
	envManager := daemon.NewEnvManager(stateStore, portRegistry, logStreamer, infraManager, proxy)
	app := daemon.NewApp(envManager, logStreamer, infraManager, registryManager, db, daemonVersion)

	_ = os.Remove(daemon.SocketPath())
	unixListener, err := net.Listen("unix", daemon.SocketPath())
	if err != nil {
		return err
	}
	defer os.Remove(daemon.SocketPath())

	httpPort := registryManager.DaemonConfig().HTTP.Port
	var httpListener net.Listener
	if httpPort > 0 {
		httpListener, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", httpPort))
	} else {
		httpListener, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		return err
	}

	unixServer := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second}
	httpServer := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second}

	meta := daemon.RuntimeMetadata{
		PID:        os.Getpid(),
		StartedAt:  time.Now().UTC().Format(time.RFC3339),
		SocketPath: daemon.SocketPath(),
		HTTPPort:   daemon.Port(httpListener.Addr().(*net.TCPAddr).Port),
	}
	if err := daemon.SaveRuntimeMetadata(meta); err != nil {
		return err
	}

	go func() {
		_ = unixServer.Serve(unixListener)
	}()
	go func() {
		_ = httpServer.Serve(httpListener)
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for _, env := range envManager.ListEnvs("") {
		_ = envManager.DownEnv(shutdownCtx, string(env.RepoID), string(env.EnvID))
	}
	_ = proxy.Stop()
	_ = unixServer.Shutdown(shutdownCtx)
	_ = httpServer.Shutdown(shutdownCtx)
	if db != nil {
		_ = db.Close()
	}
	return nil
}
