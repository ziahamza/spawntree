package daemon

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

type ProxyServer struct {
	port     int
	mu       sync.RWMutex
	routes   map[string]int
	server   *http.Server
	listener net.Listener
	started  bool
}

func NewProxyServer(port int) *ProxyServer {
	if port == 0 {
		port = 13655
	}
	return &ProxyServer{
		port:   port,
		routes: map[string]int{},
	}
}

func (p *ProxyServer) Port() int {
	return p.port
}

func (p *ProxyServer) IsRunning() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.started
}

func (p *ProxyServer) Start() error {
	p.mu.Lock()
	if p.server != nil {
		p.mu.Unlock()
		return nil
	}

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p.port))
	if err != nil {
		p.mu.Unlock()
		return err
	}

	p.server = &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", p.port),
		Handler:           http.HandlerFunc(p.handle),
		ReadHeaderTimeout: 5 * time.Second,
	}
	p.listener = listener
	server := p.server
	p.mu.Unlock()

	go func() {
		_ = server.Serve(listener)
	}()

	p.mu.Lock()
	p.started = true
	p.mu.Unlock()
	return nil
}

func (p *ProxyServer) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
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
	p.mu.Lock()
	defer p.mu.Unlock()
	p.routes[hostname] = targetPort
	return fmt.Sprintf("http://%s:%d", hostname, p.port)
}

func (p *ProxyServer) Unregister(hostname string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.routes, hostname)
}

func (p *ProxyServer) RegisteredHostnames() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]string, 0, len(p.routes))
	for hostname := range p.routes {
		out = append(out, hostname)
	}
	return out
}

func (p *ProxyServer) handle(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if idx := strings.Index(host, ":"); idx >= 0 {
		host = host[:idx]
	}

	p.mu.RLock()
	targetPort, ok := p.routes[host]
	p.mu.RUnlock()
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
