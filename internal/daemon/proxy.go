package daemon

import (
	"fmt"
	"maps"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type ProxyServer struct {
	port      int
	lifecycle sync.Mutex
	routesMu  sync.Mutex
	routes    atomic.Value
	server    *http.Server
	listener  net.Listener
	started   bool
}

func NewProxyServer(port int) *ProxyServer {
	if port == 0 {
		port = 13655
	}
	return &ProxyServer{
		port: port,
	}
}

func (p *ProxyServer) Port() int {
	return p.port
}

func (p *ProxyServer) IsRunning() bool {
	p.lifecycle.Lock()
	defer p.lifecycle.Unlock()
	return p.started
}

func (p *ProxyServer) Start() error {
	p.lifecycle.Lock()
	if p.server != nil {
		p.lifecycle.Unlock()
		return nil
	}

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p.port))
	if err != nil {
		p.lifecycle.Unlock()
		return err
	}

	p.storeRoutes(map[string]int{})

	p.server = &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", p.port),
		Handler:           http.HandlerFunc(p.handle),
		ReadHeaderTimeout: 5 * time.Second,
	}
	p.listener = listener
	server := p.server
	p.lifecycle.Unlock()

	go func() {
		_ = server.Serve(listener)
	}()

	p.lifecycle.Lock()
	p.started = true
	p.lifecycle.Unlock()
	return nil
}

func (p *ProxyServer) Stop() error {
	p.lifecycle.Lock()
	defer p.lifecycle.Unlock()
	if p.server == nil {
		return nil
	}
	err := p.server.Close()
	p.server = nil
	p.listener = nil
	p.started = false
	return err
}

func (p *ProxyServer) Register(hostname string, targetPort int) string {
	p.routesMu.Lock()
	defer p.routesMu.Unlock()
	next := maps.Clone(p.routeSnapshot())
	next[hostname] = targetPort
	p.storeRoutes(next)
	return fmt.Sprintf("http://%s:%d", hostname, p.port)
}

func (p *ProxyServer) Unregister(hostname string) {
	p.routesMu.Lock()
	defer p.routesMu.Unlock()
	next := maps.Clone(p.routeSnapshot())
	delete(next, hostname)
	p.storeRoutes(next)
}

func (p *ProxyServer) RegisteredHostnames() []string {
	snapshot := p.routeSnapshot()
	out := make([]string, 0, len(snapshot))
	for hostname := range snapshot {
		out = append(out, hostname)
	}
	slices.Sort(out)
	return out
}

func (p *ProxyServer) handle(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if idx := strings.Index(host, ":"); idx >= 0 {
		host = host[:idx]
	}

	targetPort, ok := p.routeSnapshot()[host]
	if !ok {
		http.Error(w, "No route for host: "+host, http.StatusNotFound)
		return
	}

	targetURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", targetPort))
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	proxy.Director = func(req *http.Request) {
		req.URL.Scheme = targetURL.Scheme
		req.URL.Host = targetURL.Host
		req.Host = targetURL.Host
		req.Header.Set("X-Forwarded-Host", r.Host)
		req.Header.Set("X-Forwarded-Proto", "http")
		req.Header.Set("X-Forwarded-For", r.RemoteAddr)
	}
	proxy.ServeHTTP(w, r)
}

func (p *ProxyServer) routeSnapshot() map[string]int {
	if snapshot, ok := p.routes.Load().(map[string]int); ok {
		return snapshot
	}
	return map[string]int{}
}

func (p *ProxyServer) storeRoutes(routes map[string]int) {
	p.routes.Store(routes)
}
