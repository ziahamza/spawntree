# spawntree-host-server

A tiny HTTP server that aggregates multiple spawntree daemons — running on your
laptop, your team's workstation, a remote dev box — behind a single API and
dashboard.

Each registered daemon is a **host**. The server:

- Stores registered hosts in a local SQLite file (`hosts.db`)
- Proxies API calls to the selected host (including SSE streams)
- Exposes a small admin API for registering/listing/deleting hosts
- Is under 500 lines of pure Node.js with one dep (`better-sqlite3`)

The web dashboard ships with a host-switcher dropdown in the top-left. When
you select a host, the dashboard's API client flips to that host's proxy base
URL without reloading. Selection is stored in localStorage.

This package is intentionally minimal — no auth, no WebSocket proxying, no
TLS. Harden for your deployment before running it exposed to the internet.

## Install

```bash
npm i -g spawntree-host-server
spawntree-host-server                # listens on http://127.0.0.1:7777
```

Or run without installing:

```bash
npx spawntree-host-server
```

From inside this monorepo:

```bash
pnpm --filter spawntree-host-server start
```

Environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `HOST_SERVER_PORT` | `7777` | Listen port |
| `HOST_SERVER_HOST` | `127.0.0.1` | Listen address |
| `HOST_SERVER_DB`   | `./hosts.db` | SQLite file path |

## Register your local daemon

```bash
curl -X POST http://127.0.0.1:7777/api/hosts \
  -H 'content-type: application/json' \
  -d '{"name":"laptop","url":"http://127.0.0.1:2222"}'
```

List what's registered:

```bash
curl http://127.0.0.1:7777/api/hosts
```

Proxy a call to the `laptop` host:

```bash
curl http://127.0.0.1:7777/h/laptop/api/v1/daemon
```

Same shape for any spawntree API path — SSE streams included:

```bash
curl http://127.0.0.1:7777/h/laptop/api/v1/events
```

## Architecture

```
┌──────────────────┐           ┌──────────────────┐
│  Web Dashboard   │──────────►│   Host Server    │
│ (host dropdown)  │           │   (this pkg)     │
└──────────────────┘           │   hosts.db       │
                               └─────────┬────────┘
                                         │ proxies /h/:name/*
                ┌────────────────────────┼────────────────────────┐
                │                        │                        │
                ▼                        ▼                        ▼
        ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
        │  spawntree  │          │  spawntree  │          │  spawntree  │
        │   daemon    │          │   daemon    │          │   daemon    │
        │  (laptop)   │          │ (workstation│          │ (remote dev)│
        │  :2222      │          │  :2222)     │          │  :2222)     │
        └─────────────┘          └─────────────┘          └─────────────┘
```

## API

| Method   | Path                      | Purpose                        |
| -------- | ------------------------- | ------------------------------ |
| `POST`   | `/api/hosts`              | Register a host                |
| `GET`    | `/api/hosts`              | List registered hosts          |
| `GET`    | `/api/hosts/:name`        | Get one host's metadata        |
| `DELETE` | `/api/hosts/:name`        | Deregister a host              |
| `GET`    | `/api/hosts/:name/health` | Live-probe the upstream daemon |
| `*`      | `/h/:name/*`              | Proxy to the upstream daemon   |

All admin responses are JSON. Proxied responses pass through status, headers,
and body unchanged — including `text/event-stream` for SSE.

Input validation:

- `name` — lowercase alphanumeric + `_-`, max 64 chars (regex-checked)
- `url` — must be `http:` or `https:` (URL-parsed)
- `label` — optional free-form string, max 256 chars. HTML-escaped on the
  landing page.

## Programmatic use

The package also exports nothing as a library — it's a CLI. If you want to
embed the same routing logic in another server, copy `src/server.ts` (it's
self-contained: no imports from other packages in this monorepo).

## Why this exists

The spawntree daemon is designed for a single user on a single machine.
Federation is explicitly not in the daemon's scope — but the shape of "many
daemons, one UX" comes up often enough (team dashboards, remote dev boxes,
embedding into a larger platform) that shipping it as a ready-to-install
package makes the story concrete.
