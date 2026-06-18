# spawntree-sandbox image

The default OCI image sandboxes run. A sandbox is a long-lived container the
daemon execs AI agents into (`docker exec -i` / `container exec -i`), so the
image just needs the agent toolchain present and the container kept alive.

## Why bake the agent

Sessions spawn the agent with `npx -y @zed-industries/claude-code-acp`. With the
package installed **globally in this image**, `npx` resolves the on-PATH binary
and runs it offline — no multi-second per-session download, and the sandbox
works even with restricted egress. Without baking, every session pays an npm
cold start inside a fresh container.

## One image, both providers

Docker runs this image directly; Apple `container` runs the same OCI/Linux
image in a lightweight VM on Apple silicon. Build multi-arch so both work:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/ziahamza/spawntree-sandbox:latest --push .
```

The default tag is referenced by `DEFAULT_SANDBOX_IMAGE` in
`packages/daemon/src/sandbox/constants.ts`. Override per provider via the
`defaultImage` provider config, or per sandbox via the `image` field on a
create request.

## What's included

- Node 22 (for the agent CLI)
- `git`, `ca-certificates`, `openssh-client` (worktree ops + TLS to the model API)
- `@zed-industries/claude-code-acp` installed globally

Codex parity (`@openai/codex`) is a follow-up — Codex stores thread state inside
its own process, which doesn't survive container removal, so sandboxed Codex
needs a state-dir mount before it's first-class.

## Credentials & networking

The image carries **no secrets**. The daemon injects `ANTHROPIC_API_KEY`, a
GitHub token, and git identity into the container env at sandbox-create time.
Default networking is NAT/bridged egress (the agent needs `api.anthropic.com`);
a sandbox is process/filesystem isolation, not network isolation.
