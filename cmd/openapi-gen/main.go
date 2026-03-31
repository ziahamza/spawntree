package main

import (
	"os"
	"path/filepath"

	"github.com/ziahamza/spawntree/internal/daemon"
)

func main() {
	path := filepath.Join(".", "openapi.yaml")
	if err := os.WriteFile(path, daemon.OpenAPIYAML(), 0o600); err != nil {
		panic(err)
	}
}
