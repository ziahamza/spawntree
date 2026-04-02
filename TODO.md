# TODO

## v0.2 — Polish + Production Readiness

### Core
- [ ] `--detach` mode (`spawntree up -d`, run in background)
- [ ] `spawntree logs -f` live follow via SSE streaming
- [ ] Port-binding verification (detect when process binds to wrong port)
- [ ] `spawntree doctor` (check Docker, git, node, mise)
- [ ] `spawntree status --global` across all repos
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
- [x] Document daemon architecture
- [ ] Document shared global infrastructure
- [ ] Document framework port injection
- [ ] Document PORTLESS=0 behavior
- [ ] CONTRIBUTING.md
- [ ] ASCII architecture diagram in README

## Future
- [ ] Secret providers (1Password, Wrangler, Vercel, Aptible)
- [ ] DB version management
- [ ] Cloudflare tunnels
- [ ] Windows support
- [ ] Homebrew tap
- [ ] Plugin system
