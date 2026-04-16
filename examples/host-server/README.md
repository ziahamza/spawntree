# Federation Host Server (example)

A tiny HTTP server that aggregates multiple spawntree daemons — running on your
laptop, your team's workstation, a remote dev box — behind a single API and
dashboard.

Each registered daemon is a **host**. The example server:

- Stores registered hosts in a local SQLite file (`hosts.db`)
- Proxies API calls to the selected host
- Exposes a tiny admin API for registering/listing/deleting hosts
- Is less than 400 lines and has zero deps beyond `better-sqlite3`

The web dashboard ships with a host-switcher dropdown in the top-left. When you
select a host, the dashboard's API client flips to that host's proxy base URL.
Switching hosts doesn't reload the page.

This example is intentionally minimal — no auth, no WebSocket proxying, no TLS.
It's meant to show the shape. Harden before running it exposed.

## Run it

```bash
cd examples/host-server
pnpm install
pnpm start              # listens on http://127.0.0.1:7777
```

The server creates `hosts.db` in the current directory on first run.

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
│ (host dropdown)  │           │  (this example)  │
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

## Why this lives in the repo

The spawntree daemon is designed for a single user on a single machine.
Federation is explicitly not in the daemon's scope — but the shape of "many
daemons, one UX" comes up often enough (team dashboards, remote dev boxes,
embedding into a larger platform) that shipping a worked example makes the story
concrete.

Copy this directory, harden the pieces you need, and you have a host.
