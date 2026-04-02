//go:build noui

package main

// No embedded web UI. The daemon runs in API-only mode.
// Build with: go build -tags noui ./cmd/spawntreed
// The /api/v1/* endpoints work normally. Non-API routes return a JSON message.
