FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

# Pre-accept Claude Code's first-run onboarding. Without this the interactive TUI
# runs the theme picker and an OAuth login flow on every fresh container — that
# flow does not consult CLAUDE_CODE_OAUTH_TOKEN, unlike --print mode. The trust
# dialog and the bypass-permissions warning are separate gates with separate keys
# (the latter lives in settings.json, and IS_SANDBOX=1 does not suppress it).
RUN node -e 'const fs=require("fs"),p="/home/agent/.claude.json";const j=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};j.hasCompletedOnboarding=true;j.theme="dark";j.projects=Object.assign({},j.projects,{"/home/agent/workspace":{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}});fs.writeFileSync(p,JSON.stringify(j,null,2));' \
 && mkdir -p /home/agent/.claude \
 && printf '{\n  "skipDangerousModePermissionPrompt": true\n}\n' > /home/agent/.claude/settings.json

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
