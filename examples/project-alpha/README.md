# Project Alpha

Django 6.0 health app with PydanticAI, DBOS, and Expo mobile client.

- **db**: Postgres with pgvector (shared global instance)
- **dbos-db**: Separate Postgres database for DBOS workflow state
- **redis**: Redis for cache/queues
- **mailpit**: Local SMTP catcher for email testing
- **django**: Django API server (Daphne ASGI)
- **vite**: Frontend asset dev server (HMR)

## Requirements

- Postgres with pgvector extension (spawntree provides this automatically)
- Redis
- Docker (for Mailpit container)
- uv, node, bun (via mise)
- API keys in .env (OpenAI, AWS S3, Twilio)

## Run

```bash
cd /path/to/project-alpha/backend
cp /path/to/spawntree/examples/project-alpha/spawntree.yaml .
spawntree up
```
