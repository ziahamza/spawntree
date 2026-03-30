# Examples

Real-world project structures showing how spawntree fits into different stacks. Each example is a self-contained project you can `spawntree up` in.

These also serve as the E2E testing harness. If the examples work, spawntree works.

| Example | Stack | What it demonstrates |
|---------|-------|---------------------|
| [node-fullstack](./node-fullstack/) | Node.js API + worker | `depends_on`, healthchecks, service discovery |
| [python-fastapi](./python-fastapi/) | Python HTTP + scheduler | Python processes, dependency ordering |
| [multi-language](./multi-language/) | Node + Python + static | Mixed runtimes, .env files, 3-service chain |

## Running an example

```bash
cd examples/node-fullstack
spawntree up
```

## Using examples as E2E tests

Each example can be run as an automated test:

```bash
# Start the example, wait for healthchecks, verify, stop
cd examples/node-fullstack
spawntree up &
sleep 3
curl -f http://localhost:$(spawntree status --json | jq '.services.api.port')/health
spawntree down
```

A formal E2E test harness using these examples is planned for v0.1.1.
