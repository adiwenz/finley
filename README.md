# Finley

A browser-based financial life simulator. Inputs are a household's income, expenses,
accounts, and discrete life events; output is a month-by-month net-worth projection and a
solved retirement year. See [`FINAL_BUILD_SPEC.md`](./FINAL_BUILD_SPEC.md) — the canonical
source of truth — and [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the open-core split.

## Workspaces

Open-core monorepo. Dependency direction is **one-way**: `app → rules → engine`.

| Package | Visibility | Contents |
|---|---|---|
| [`@finley/engine`](./packages/engine) | public | Pure simulation. No I/O, no jurisdiction facts. Defines the jurisdiction interface; ships a null jurisdiction so it runs standalone. |
| [`@finley/rules`](./packages/rules) | public | Jurisdiction implementations of the engine's interface (e.g. `US-2026`). |
| [`@finley/app`](./packages/app) | private | UI, persistence, user data. Imports the two public packages. |

The **engine-purity rule** (§0.8) is enforced by `scripts/check-engine-purity.mjs` (and in
CI): engine source may not do I/O or import app/rules code.

## Commands

```bash
npm install          # link workspaces + install dev tools
npm run dev          # start the app dev server (renders the engine projection)
npm run test         # Vitest across all packages
npm run typecheck    # tsc --noEmit
npm run check:purity # engine-purity gate
npm run check        # purity + typecheck + test (the full gate)
```

## Sandcastle (automated issue implementation)

Sandcastle runs Claude Code agents against `Sandcastle`-labeled GitHub issues, in
local Docker or Vercel cloud sandboxes, on your machine or via GitHub Actions. See
[`.sandcastle/README.md`](./.sandcastle/README.md) for full setup — tokens, the
Docker image build, the Vercel Container Registry image, and GitHub Actions
secrets.

```bash
npm run sandcastle -- --sandbox docker   # local Docker sandboxes (default)
npm run sandcastle -- --sandbox cloud    # Vercel cloud sandboxes
```
