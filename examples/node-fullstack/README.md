# Node.js Full-Stack Example

A simple API server with a background worker that polls it. Demonstrates:

- Two `process` services with `depends_on` ordering
- Healthcheck on the API
- Service discovery via `${API_URL}` environment variable
- Graceful shutdown on SIGTERM

## Run

```bash
cd examples/node-fullstack
spawntree up
```

The API starts first (port allocated by spawntree), then the worker starts and polls `/api/items` every 5 seconds.

## What to observe

- Worker connects to the API using the auto-injected `API_URL`
- `spawntree status` shows both services running with their ports
- Ctrl+C stops both (worker first, then API, reverse dependency order)
- `spawntree logs api` shows API request logs
- `spawntree logs worker` shows polling results
