# Daemon Architecture

spawntree now uses a native Go daemon, `spawntreed`, as the single runtime owner for local orchestration.

## Runtime Model

- The CLI is a thin TypeScript client.
- The daemon is a native Go binary started on demand.
- One daemon manages all repos, environments, shared infra, proxy routes, and tunnel registry state for the local machine.

## Transports

The daemon exposes one API surface over two local transports:

- Unix socket: `~/.spawntree/spawntree.sock`
- Loopback HTTP: `127.0.0.1:<dynamic-port>`

The CLI uses the Unix socket. The loopback HTTP listener exists so a local dashboard can talk to the same daemon without a bridge process.

## API Contract

- The API contract lives in the repo-root [`openapi.yaml`](../openapi.yaml).
- `openapi.yaml` is generated from the Go daemon code.
- The TypeScript SDK in [`packages/core/src/generated`](../packages/core/src/generated) is generated from that OpenAPI file.
- SSE log streaming stays handwritten on the TypeScript side because the CLI needs an async iterator, but the payload types still come from the generated contract.

## State Layout

`~/.spawntree` is split into editable config and volatile runtime state.

- `config.yaml`: daemon-owned global registry
- `runtime/daemon.json`: live daemon metadata
- `runtime/port-registry.json`: allocated port ranges
- `repos/<repoId>/state.json`: persisted environment snapshot per repo
- `repos/<repoId>/logs/<envId>/*.log`: service logs

Per-project service topology still lives in each repo’s `spawntree.yaml`.

## Ownership Model

The daemon uses a single owned state path for:

- registered repos
- tunnel definitions and statuses
- live environments
- allocated port slots

This keeps the core daemon state under one owner instead of scattering mutable maps across multiple subsystems.

Long-lived runtime pieces such as log fanout, process runners, and proxy request handling still manage their own local synchronization where they need it.

## Binary Packaging

The npm daemon package ships precompiled binaries for supported platforms:

- macOS: `x64`, `arm64`
- Linux: `x64`, `arm64`
- Windows: `x64`, `arm64`

At runtime, the resolver picks the correct binary for the current Node.js platform and architecture.

## Release Flow

The release pipeline verifies three things separately:

1. the generated `openapi.yaml` is up to date with the Go daemon
2. the generated TypeScript SDK is up to date with `openapi.yaml`
3. the Go daemon passes fmt, lint, and tests

Then it builds the npm packages with the native daemon binaries included so the published npm package already contains the binary for each supported platform.
