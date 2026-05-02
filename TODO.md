# TODO

## v0.2 — Polish + Production Readiness

### Core

- [ ] `--detach` mode (`spawntree up -d`, run in background)
- [ ] `spawntree logs -f` live follow via SSE streaming _(web UI covers this
      visually via LogViewer)_
- [ ] Port-binding verification (detect when process binds to wrong port)
- [ ] `spawntree doctor` (check Docker, git, node, mise)
- [ ] `spawntree status --global` across all repos _(web UI covers this visually
      via Dashboard)_
- [ ] Shell completions (bash, zsh, fish)

### Mise Integration

- [ ] Detect `.mise.toml` in project root
- [ ] Run `mise install` before starting services
- [ ] Activate mise-managed toolchains for `type: process` services

### UX

- [ ] Colored status output (green=running, red=failed, gray=stopped)
- [ ] Show last 10 log lines on process crash
- [ ] `--verbose` / `--quiet` flags
- [ ] `--timeout` flag for healthcheck override
- [ ] Pretty table output for `spawntree up`

### Error Messages

- [ ] Docker not running → clear install instructions
- [ ] Non-git directory → suggest `git init`
- [ ] Port exhaustion → suggest `spawntree status --all`

## Testing

- [ ] Integration tests: Docker Postgres lifecycle
- [ ] Integration tests: Docker Redis lifecycle
- [ ] Integration tests: container runner
- [ ] Integration tests: reverse proxy routing
- [ ] Integration tests: SSE log streaming
- [ ] E2E test script for all example projects
- [ ] Test concurrent requests to daemon
- [ ] Test Ctrl+C cleanup

## Documentation

- [ ] Update docs/configuration.md with all service types
- [ ] Document daemon architecture
- [ ] Document shared global infrastructure
- [ ] Document framework port injection
- [ ] Document PORTLESS=0 behavior
- [ ] CONTRIBUTING.md
- [ ] ASCII architecture diagram in README

## Web UI v2

- [ ] Config overrides UI (global spawntree config editor in web)
- [ ] Past run history browser (timeline of env starts/stops/crashes)
- [ ] Health dashboard for infrastructure (PG/Redis detailed metrics)
- [ ] Auth system (for Cloudflare tunnels / Tailscale remote access)
- [ ] Frontend component tests (vitest in packages/web)
- [ ] Wire canonical repo IDs to env listing (bridge two-level identity)
- [ ] Light mode support
- [ ] CSRF token protection for localhost API

## Future

- [ ] Secret providers (1Password, Wrangler, Vercel, Aptible)
- [ ] DB version management
- [ ] Cloudflare tunnels
- [ ] Windows support
- [ ] Homebrew tap
- [ ] Plugin system
- [ ] Document the git-subtree workflow for downstream vendors
- [ ] Add `spawntree --version` flag (currently only via `spawntree help`)
