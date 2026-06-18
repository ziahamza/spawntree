# Default sandbox image for spawntree.
#
# A sandbox is a long-lived container the daemon execs AI agents into. Baking
# the agent CLI in (rather than `npx`-ing it per session) avoids a multi-second
# cold start on every session and lets the sandbox work without npm egress.
#
# One image serves BOTH providers: Docker runs it directly, and Apple
# `container` runs the same OCI/Linux image in a lightweight VM on Apple
# silicon. Keep it linux/amd64 + linux/arm64 multi-arch.
#
# Build & publish (see README.md in this dir):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/ziahamza/spawntree-sandbox:latest --push .
#
# Override per provider/sandbox via the `defaultImage` provider config or the
# `image` field on a create request.

FROM node:22-bookworm-slim

# git is required for the agent to operate on the mounted worktree; the rest
# are common build prerequisites agents reach for. ca-certificates so the
# agent can reach api.anthropic.com over TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Bake the Claude Code ACP agent so the daemon execs the on-PATH binary with
# no per-session download. (Codex parity — `@openai/codex` — is a follow-up.)
RUN npm install -g @zed-industries/claude-code-acp

# The daemon overrides the entrypoint to keep the container idle and execs the
# agent on demand; this default keeps a bare `run` alive too.
CMD ["sleep", "infinity"]
