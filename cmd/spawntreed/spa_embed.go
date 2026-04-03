//go:build !noui

package main

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"

	"github.com/ziahamza/spawntree/internal/daemon"
)

//go:embed web
var webFS embed.FS

func init() {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return
	}
	fileServer := http.FileServer(http.FS(sub))

	daemon.SetSPAHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Try to serve the exact file first
		if path != "/" && !strings.HasSuffix(path, "/") {
			if f, err := sub.Open(strings.TrimPrefix(path, "/")); err == nil {
				f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		// SPA fallback: serve index.html for all other routes
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	}))
}
