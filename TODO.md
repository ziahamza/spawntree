# TODO

Small improvements and fixes. Ordered roughly by priority within each section.

## v0.1.0 polish

- [ ] `spawntree up` should print a table with service name, port, status, and URL columns
- [ ] `spawntree status` should detect and mark dead processes (PID check) rather than trusting PID files
- [ ] `spawntree logs -f` (follow mode) should use `fs.watch` to tail new log lines in real time
- [ ] `spawntree init` should detect common stacks (Next.js, Rails, Django, Flask) and generate smarter defaults
- [ ] Add `--verbose` and `--quiet` flags to control output level
- [ ] Add `--timeout` flag to `spawntree up` for healthcheck wait time override
- [ ] Handle branch names with slashes (e.g., `feat/auth`) by replacing `/` with `-` in env names
- [ ] Validate that allocated ports are actually free before starting services (EADDRINUSE pre-check)
- [ ] `spawntree down` should also work by killing the foreground process group, not just by PID lookup
- [ ] Add shell completions (bash, zsh, fish) via commander's built-in support

## Config & .env

- [ ] Support `dotenv-expand` variable references within .env files (e.g., `BASE_URL=http://localhost:${PORT}`)
- [ ] Add `spawntree validate` command to check spawntree.yaml without starting anything
- [ ] Support `extends` in spawntree.yaml for sharing common service config across envs
- [ ] Warn if `.env.local` exists but isn't gitignored

## Error messages

- [ ] When a process exits immediately, show the last 10 lines of its log in the error output
- [ ] When port allocation fails, suggest `spawntree status --all` to see what's using slots
- [ ] When git worktree creation fails, check for common issues (detached HEAD, dirty index) and suggest fixes
- [ ] `spawntree up` in a non-git directory should suggest `git init` first

## Testing

- [ ] Add E2E test that runs the compiled CLI against a sample project with 2 process services
- [ ] Add test for `.env` resolution order (base < local < env-specific < CLI < shell)
- [ ] Add test for branch names with special characters as env names
- [ ] Add test for concurrent `spawntree up` (lock file contention)
- [ ] Add test for Ctrl+C handling (SIGINT cleanup)
- [ ] Test that `spawntree rm` fully cleans up (no leftover worktrees, PID files, or state)

## Developer experience

- [ ] Add `spawntree doctor` command that checks prerequisites (git, node version, docker availability)
- [ ] Colored output for service status (green = running, red = failed, gray = stopped)
- [ ] Show elapsed time for each service startup in the status output
- [ ] `spawntree up` should print the exact `spawntree down` or Ctrl+C instruction on startup
- [ ] Add a `--dry-run` flag that shows what would be started without starting it

## Documentation

- [ ] Add CONTRIBUTING.md with dev setup instructions
- [ ] Add architecture diagram to README (ASCII art of the data flow)
- [ ] Document the `spawntree.yaml` schema formally (JSON Schema or TypeScript types in docs)
- [ ] Add examples/ directory with sample projects (node app, python worker, mixed stack)
