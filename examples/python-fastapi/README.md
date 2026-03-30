# Python API + Scheduler Example

A Python HTTP API with a background scheduler that posts tasks to it. Demonstrates:

- Python services orchestrated by spawntree (no Docker needed)
- Service discovery via `${API_URL}`
- Dependency ordering (scheduler waits for API)
- Standard library only (no pip install required for the services themselves)

## Run

```bash
cd examples/python-fastapi
spawntree up
```

The API starts on an allocated port, then the scheduler begins creating tasks every 5 seconds.

## What to observe

- Scheduler auto-discovers the API via the injected `API_URL`
- `curl http://localhost:<port>/api/tasks` shows accumulated tasks
- Each environment gets its own task list (no shared state)
- Clean shutdown on Ctrl+C (scheduler stops posting, API drains)
