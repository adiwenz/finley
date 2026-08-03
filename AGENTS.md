# Finley — agent instructions

`CONTEXT.md` at the repo root is the canonical ubiquitous language. Use its vocabulary, and
respect its `_Avoid_` lines.

## Agent skills

### Issue tracker

GitHub Issues on `adiwenz/finley`, via the `gh` CLI. External pull requests are **not** a
triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Two roles only: `ready-for-agent` → **`Sandcastle`**, and `wontfix`. Do not create labels for
the other canonical roles. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root. **This repo does not use ADRs** — decisions
live in the spec or PRD issue that produced them, and in the code's doc-comments. See
`docs/agents/domain.md`.
