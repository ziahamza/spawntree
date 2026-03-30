# CLI Reference

## Global Options

```
--config-file <path>    Path to spawntree.yaml (default: spawntree.yaml)
--lock-file <path>      Path to lock file (default: .spawntree.lock)
-V, --version           Print version
-h, --help              Print help
```

## Commands

### spawntree up

Start the environment. Runs in foreground, Ctrl+C to stop.

```bash
spawntree up                         # env = current branch
spawntree up --prefix agent-1        # env = <branch>-agent-1
spawntree up --env API_KEY=secret    # override env var
spawntree up --config-file alt.yaml  # use different config
```

| Option | Description |
|--------|-------------|
| `--prefix <name>` | Create a named environment alongside the default |
| `--env <KEY=VALUE>` | Override environment variables (repeatable) |

### spawntree down

Stop the environment.

```bash
spawntree down           # stop current branch's env
spawntree down feat-auth # stop a specific env
```

### spawntree status

Show environment status.

```bash
spawntree status        # current branch's env
spawntree status --all  # all envs in this repo
```

### spawntree logs

Tail service logs with colored prefixes.

```bash
spawntree logs          # all services
spawntree logs api      # specific service
```

### spawntree rm

Full teardown: kill processes, remove worktree, clean state.

```bash
spawntree rm feat-auth
```

### spawntree init

Generate a `spawntree.yaml` config file.

```bash
spawntree init                  # blank template
spawntree init --from-compose   # from docker-compose.yml
spawntree init --from-package   # from package.json scripts
```
