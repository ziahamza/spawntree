# CLI Reference

## Global Options

```
--config-file <path>    Path to spawntree.yaml (default: spawntree.yaml)
--lock-file <path>      Path to lock file
-V, --version           Print version
-h, --help              Print help
```

## Commands

### spawntree up

Start the environment. Auto-starts the daemon if not running.

```bash
spawntree up                         # env = current branch
spawntree up --prefix agent-1        # env = <branch>-agent-1
spawntree up --env API_KEY=secret    # override env var
```

Services start in dependency order. Logs stream to stdout. Ctrl+C stops everything.

### spawntree down

Stop the environment (keep state for fast restart).

```bash
spawntree down                       # stop current branch's env
spawntree down --prefix agent-1      # stop a prefixed env
```

### spawntree status

Show environment status with service table.

```bash
spawntree status                     # current branch's env
spawntree status --all               # all envs
```

### spawntree logs

Stream service logs (via daemon SSE).

```bash
spawntree logs                       # all services
spawntree logs api                   # specific service
```

### spawntree rm

Full teardown: stop services, remove worktree, free ports.

```bash
spawntree rm <env-id>
```

### spawntree init

Generate a `spawntree.yaml` config file.

```bash
spawntree init                       # blank template
spawntree init --from-compose        # from docker-compose.yml
spawntree init --from-package        # from package.json scripts
```

### spawntree infra

Manage shared infrastructure (Postgres, Redis).

```bash
spawntree infra status               # show shared containers
spawntree infra stop                 # stop all shared infra
spawntree infra stop --target postgres
spawntree infra stop --target redis
```

### spawntree db

Database template management.

```bash
spawntree db dump <name>             # dump current env's DB to template
spawntree db restore <name>          # restore template into current env
```
