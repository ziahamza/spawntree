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
	if err := daemon.EnsureBaseDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "spawntreed: %v\n", err)
		os.Exit(1)
	}

	portRegistry, err := daemon.NewPortRegistry()
	if err != nil {
		fmt.Fprintf(os.Stderr, "spawntreed: %v\n", err)
		os.Exit(1)
	}
	logStreamer := daemon.NewLogStreamer()
	infraManager := daemon.NewInfraManager()
	registryManager, err := daemon.NewRegistryManager()
	if err != nil {
		fmt.Fprintf(os.Stderr, "spawntreed: %v\n", err)
		os.Exit(1)
	}

	proxyPort := registryManager.DaemonConfig().Proxy.Port
	proxy := daemon.NewProxyServer(proxyPort)
	envManager := daemon.NewEnvManager(portRegistry, logStreamer, infraManager, proxy)
	app := daemon.NewApp(envManager, logStreamer, infraManager, registryManager, daemonVersion)

	_ = os.Remove(daemon.SocketPath())
	unixListener, err := net.Listen("unix", daemon.SocketPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "spawntreed: %v\n", err)
		os.Exit(1)
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
		fmt.Fprintf(os.Stderr, "spawntreed: %v\n", err)
		os.Exit(1)
	}

	unixServer := &http.Server{Handler: app}
	httpServer := &http.Server{Handler: app}

	meta := daemon.RuntimeMetadata{
		PID:        os.Getpid(),
		StartedAt:  time.Now().UTC().Format(time.RFC3339),
		SocketPath: daemon.SocketPath(),
		HTTPPort:   httpListener.Addr().(*net.TCPAddr).Port,
	}
	if err := daemon.SaveRuntimeMetadata(meta); err != nil {
		fmt.Fprintf(os.Stderr, "spawntreed: %v\n", err)
		os.Exit(1)
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
		_ = envManager.DownEnv(shutdownCtx, env.RepoID, env.EnvID)
	}
	_ = proxy.Stop()
	_ = unixServer.Shutdown(shutdownCtx)
	_ = httpServer.Shutdown(shutdownCtx)
}
