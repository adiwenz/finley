# Custom Vercel Container Registry (VCR) image for Sandcastle cloud runs.
#
# Bakes in the agent toolchain so a cloud sandbox needs no per-run install:
#   - git         : the agent commits its work
#   - GitHub CLI  : the prompts query issues (`gh issue list` / `gh issue view`)
#   - Claude Code : the `claude` binary Sandcastle invokes as the agent
#   - node + npm  : run the project's typecheck / tests
#
# Boot from it by setting VERCEL_SANDBOX_IMAGE to this image's VCR ref (see the
# build/push commands in the README). Vercel sandboxes run on linux/amd64, so
# build with `--platform linux/amd64` if you're on Apple Silicon.
#
# Runs as a non-root `agent` user: Claude Code refuses
# `--dangerously-skip-permissions` when it's root, and there's no sudo in the
# image. This mirrors `.sandcastle/Dockerfile` so both sandbox paths behave the
# same.

FROM node:22-bookworm

# System tools + GitHub CLI (from GitHub's official apt repo).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Rename the base image's "node" user to "agent". Unlike the Docker image we
# don't need UID/GID alignment (nothing is bind-mounted — the repo is cloned
# inside the sandbox), so keep node's default 1000:1000.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g "$AGENT_GID" node \
  && usermod -o -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node

# The provider clones the repo into /vercel/sandbox/workspace; make that tree
# owned by the agent so the non-root user can write it.
RUN mkdir -p /vercel/sandbox/workspace && chown -R "$AGENT_UID:$AGENT_GID" /vercel/sandbox

USER ${AGENT_UID}:${AGENT_GID}

# Claude Code CLI. install.sh drops it in $HOME/.local/bin for the agent user.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:${PATH}"

# Fail the build early if any required tool is missing from PATH.
RUN command -v git && command -v gh && command -v node && command -v npm && command -v claude

# Vercel starts the container and execs commands into it; keep it alive in case
# the image's own CMD is what runs.
CMD ["sleep", "infinity"]
