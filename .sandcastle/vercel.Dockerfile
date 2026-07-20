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
# Runs as ROOT, deliberately. A non-root `agent` user (renaming/relocating the
# base node user + chowning /vercel/sandbox) killed Vercel's in-container exec
# daemon at boot — every command failed with "Sandbox stream was closed". Vercel
# ships that user/home/mount and expects it intact, so we leave it. Claude Code's
# refusal to run --dangerously-skip-permissions as root is instead handled by
# IS_SANDBOX=1 (set in new_flow/main.ts), the documented escape hatch for a
# genuinely sandboxed environment — which a Vercel microVM is.

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

# Claude Code CLI. install.sh drops it in $HOME/.local/bin (root, at build time).
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

# Fail the build early if any required tool is missing from PATH.
RUN command -v git && command -v gh && command -v node && command -v npm && command -v claude

# Vercel starts the container and execs commands into it; keep it alive in case
# the image's own CMD is what runs.
CMD ["sleep", "infinity"]
