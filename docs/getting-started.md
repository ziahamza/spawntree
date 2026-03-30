# Getting Started

## Install

```bash
npm i -g spawntree
```

Or run directly:

```bash
npx spawntree --help
```

## Prerequisites

- Node.js >= 20
- Git (for environment isolation)

## Quick Start

1. Navigate to your project:

```bash
cd my-project
```

2. Generate a config:

```bash
spawntree init
```

This creates `spawntree.yaml`. Edit it to match your project.

3. Start your environment:

```bash
spawntree up
```

Services start in dependency order. Ctrl+C to stop.

4. Check what's running:

```bash
spawntree status
```

## Your First spawntree.yaml

```yaml
services:
  api:
    type: process
    command: node src/server.js
    port: 3000
    healthcheck:
      url: http://localhost:${PORT}/health

  worker:
    type: process
    command: node src/worker.js
    depends_on:
      - api
```

spawntree automatically:
- Creates an isolated git worktree for your environment
- Allocates non-conflicting ports
- Injects `PORT`, `ENV_NAME`, and service discovery vars
- Monitors healthchecks
- Cleans up on Ctrl+C

## Next Steps

- [Configuration Reference](./configuration.md)
- [Environment Variables](./environment-variables.md)
- [Examples](../examples/)
