# Multi-Language Stack Example

Node.js API gateway + Python ML inference service + static file server. Demonstrates:

- Mixed Node.js and Python services in one spawntree config
- 3-service dependency chain (ml-service starts first, gateway depends on it)
- `.env` file for model configuration
- Cross-language service discovery via injected URLs
- A static frontend that calls through the gateway to the ML service

## Architecture

```
Browser → Static Server (Node, :8080)
              ↓
         Gateway (Node, :4000)
              ↓
         ML Service (Python, :5000)
```

## Run

```bash
cd examples/multi-language
spawntree up
```

## Try it

```bash
# Health check
curl http://localhost:<gateway-port>/health

# Make a prediction through the gateway
curl -X POST http://localhost:<gateway-port>/api/predict \
  -H "Content-Type: application/json" \
  -d '{"text": "spawntree is great"}'

# Or open the static frontend in your browser
open http://localhost:<static-port>
```

Ports are allocated by spawntree. Check `spawntree status` for the actual ports.

## Multiple environments

```bash
# Run two isolated stacks simultaneously
spawntree up                        # default env (current branch)
spawntree up --prefix experiment    # second env with different model

# Override model in second env
spawntree up --prefix experiment --env MODEL_NAME=sentiment-v2
```

Each environment gets its own ports, processes, and state. No conflicts.
