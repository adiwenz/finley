# Sandcastle — automated issue implementation

Sandcastle reads open GitHub issues labeled **`Sandcastle`**, plans a batch of
unblocked, non-overlapping work, and runs a Claude Code agent per issue in an
isolated sandbox. Each agent implements the issue on its own branch
(`sandcastle/issue-<n>`), verifies typecheck + tests inside the sandbox, and the
finished branch is pushed and relabeled `sandcastle-done` for review.

The orchestrator is `.sandcastle/new_flow/main.ts`, run via `npm run sandcastle`.

Two independent choices:

- **Where the orchestrator runs** — your machine, or GitHub Actions (so a run
  survives your laptop being closed/offline).
- **What sandbox the agents run in** — local **Docker** containers, or **Vercel**
  cloud microVMs. Pick with `--sandbox docker|cloud`.

---

## 1. Prerequisites (all modes)

Install workspace deps:

```bash
npm install
```

Create the secrets file and fill it in:

```bash
cp .sandcastle/.env.example .sandcastle/.env
```

| Variable | Required | How to get it |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | `claude setup-token` (uses your Claude subscription). Or set `ANTHROPIC_API_KEY` instead. |
| `GH_TOKEN` | yes | A GitHub token with **Issues: read/write** and **Metadata: read**. Used to read the queue and relabel issues. |

Only variables whose **key** appears in `.sandcastle/.env` are forwarded into the
sandbox, so keep the keys present even if a value comes from your environment.

---

## 2. Running it

```bash
npm run sandcastle                                   # defaults: --sandbox docker --review worktree
npm run sandcastle -- --sandbox cloud                # Vercel cloud sandboxes
npm run sandcastle -- --sandbox docker --review push # explicit
```

| Flag | Values | Default | Meaning |
|---|---|---|---|
| `--sandbox` | `docker` \| `cloud` | `docker` | Local Docker containers vs. Vercel cloud microVMs. |
| `--review` | `worktree` \| `push` | `worktree` locally, `push` under CI | `worktree` stands up a local git worktree per finished branch; `push` just pushes the branch (for ephemeral/CI runners). |

Env equivalents: `SANDCASTLE_SANDBOX`, `SANDCASTLE_REVIEW`.

---

## 3. Sandbox option A — Docker (local)

The Docker provider does **not** auto-build; it expects a prebuilt image named
`sandcastle:<repo-dir>` (here `sandcastle:finley`) whose baked-in user UID
matches your user (it bind-mounts your worktree). Build it once (and whenever
`.sandcastle/Dockerfile` changes):

```bash
docker build \
  -f .sandcastle/Dockerfile \
  -t "sandcastle:$(basename "$PWD")" \
  --build-arg AGENT_UID="$(id -u)" \
  --build-arg AGENT_GID="$(id -g)" \
  .
```

Then:

```bash
npm run sandcastle -- --sandbox docker
```

---

## 4. Sandbox option B — Vercel cloud

Add three secrets (to `.sandcastle/.env` locally, or the environment). All three
are required together — a bare token can't tell Vercel which team/project to bill
the sandbox to:

| Variable | Where to find it |
|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens |
| `VERCEL_TEAM_ID` | Vercel dashboard → team → Settings (`team_…`) |
| `VERCEL_PROJECT_ID` | Vercel dashboard → project → Settings (`prj_…`) |

Run:

```bash
npm run sandcastle -- --sandbox cloud
```

Without a custom image, the cloud sandbox boots a stock runtime and installs
`git`/`gh`/`claude` on **every** run. To bake them in (faster, reproducible),
build and push a Vercel Container Registry (VCR) image.

### 4a. Build + push the VCR image

Vercel sandboxes run on **linux/amd64** — build for that platform explicitly
(especially on Apple Silicon):

```bash
docker build --platform linux/amd64 \
  -f .sandcastle/vercel.Dockerfile \
  -t finley-sandcastle:latest \
  .
```

Authenticate Docker to the Vercel Container Registry, then tag and push. The
registry host/path is `vcr.vercel.com/<team>/<project>/<repo>` — confirm the
exact login mechanism in Vercel's VCR docs (typically a Vercel access token):

```bash
docker login vcr.vercel.com
docker tag finley-sandcastle:latest \
  vcr.vercel.com/<team-slug>/<project-slug>/finley-sandcastle:latest
docker push \
  vcr.vercel.com/<team-slug>/<project-slug>/finley-sandcastle:latest
```

### 4b. Point Sandcastle at the image

Set `VERCEL_SANDBOX_IMAGE`. Because the image is scoped to the sandbox's
project, a bare repository name resolves to the `latest` tag:

```bash
VERCEL_SANDBOX_IMAGE=finley-sandcastle
```

Unset → stock runtime + per-run install. Set → boot from the image, no install.

---

## 5. Running on GitHub Actions (detached from your machine)

Workflow: `.github/workflows/sandcastle.yml`. The runner is the control plane, so
a run keeps going with your laptop closed/offline.

Add repo secrets under **Settings → Secrets and variables → Actions**:

| Secret | Needed for |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | always |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | cloud mode |
| `VERCEL_SANDBOX_IMAGE` | cloud mode, optional (VCR image ref, e.g. `finley-sandcastle`) |

`GITHUB_TOKEN` is provided automatically (git push + issue relabel). Docker mode
needs no Vercel secrets — just the Claude token.

Trigger it: **Actions → Sandcastle → Run workflow**, and pick the **Sandbox
provider** (`cloud` or `docker`). For docker mode the workflow builds the image
on the runner (layer-cached) before running; no manual build needed.

---

## 6. Reviewing results

Each finished issue is pushed to `origin` as `sandcastle/issue-<n>` and relabeled
`sandcastle-done` (left open). To review a branch locally after a `push`-mode run
(e.g. from CI):

```bash
git fetch origin sandcastle/issue-<n>
.sandcastle/new_flow/create-review-worktree.sh sandcastle/issue-<n> <n>
```

That stands up a runnable worktree at `../finley-review-issue-<n>` on its own dev
port. Tear it down with `.sandcastle/new_flow/remove-review-worktree.sh <n>`.

---

## 7. Notes & tuning

- **Concurrency.** The planner selects **up to 3** non-overlapping issues per
  batch — a soft cap in `.sandcastle/new_flow/plan-prompt.md`, not a hard limit.
  On Docker all agents share the runner's CPU/RAM; on Vercel each is its own
  microVM, so the cloud path scales further (bounded by your Vercel concurrency
  quota).
- **`amd64` for cloud images.** A create-time HTTP 500 from Vercel is often an
  `arm64` image built on Apple Silicon without `--platform linux/amd64`. Verify
  with `docker image inspect <image> --format '{{.Architecture}}'`.
