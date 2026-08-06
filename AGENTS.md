# Finley — agent instructions

A browser-based financial life simulator: enter a household's income, expenses, accounts and
life events; get a month-by-month net-worth projection and a solved retirement year.

## Read these first

1. **`README.md`** — the workspace table, the one-way dependency rule, every `npm` script.
2. **`packages/engine/src/index.ts`** — the engine's entire public surface, one curated
   re-export per line with the reason beside it. This is the fastest map in the repo: it says
   what a caller may name, what is internal, and why nothing that writes is exported.
3. **`CONTEXT.md`** — the canonical ubiquitous language. **Grep it for the term you need; do
   not read it front to back.** It is 60+ entries under eight `###` groups. Use its vocabulary,
   and respect its `_Avoid_` lines.

## Repo map

Open-core monorepo, workspaces under `packages/`. Dependency direction is **one-way**
`app → rules → engine`, and engine purity (no I/O, no app/jurisdiction code) is enforced by
`scripts/check-engine-purity.mjs` in `npm run check` and CI.

| Package | Contents |
|---|---|
| `@finley/engine` | Pure simulation. Defines the jurisdiction interface; ships a null jurisdiction so it runs standalone. |
| `@finley/rules` | Jurisdiction implementations (e.g. `US-2026`). Flat directory, one file per tax/benefit rule. |
| `@finley/app` | UI, persistence, user data. Imports the two public packages. |

`packages/engine/src` — the bulk of the codebase:

| Directory | What lives there |
|---|---|
| `facade/` | `Projection` — the **only** public entry point. Every read and write goes through it. |
| `projection/` | The month-by-month simulator: waterfall, withdrawal, obligations, snapshot/report. |
| `ledger/` | Life events: add/update/remove, interpret, validation, household. |
| `authoring/` | The write side — jobs, goals, housing, liabilities, relationships, budget lines. |
| `plan/` | The authored model (plan, person, account, scenario) and id minting. |
| `job/` `goal/` `budget/` `liability/` `money/` | Entity types and their own rules. |
| `compile/` | Plan → projection base. |
| `retirement/` | The solver, outlook, deferral limits, early-retiree health check. |
| `jurisdiction/` | The open-core seam, plus `nullJurisdiction`. |
| `input/` | The declarative, id-free `ScenarioInput` that seed data and presets are written as. |
| `testing/` | Engine-side fixtures. |

`packages/app/src` has two layers, and the distinction matters for how you test:

- `components/` — 13 panel directories (`jobsPanel`, `baseAdjustments`, `budgetEditor`,
  `goalsPanel`, `retirementPanel`, `netWorthChart`, `timeline`, `startingPositionPanel`, …).
- Root-level `*View.ts` **view-model modules** (`retirementView`, `goalsView`, `ledgerView`,
  `fundingView`, `jobEditing`, `presets`, `planDefaults`, …) — plain functions turning a
  `Projection` into what a panel draws. This is the seam to reach for first.

## Where to look

| Task | Start at |
|---|---|
| Add or change an authoring gesture | `engine/src/authoring/`, then `engine/src/index.ts` |
| Change simulation maths | `engine/src/projection/` |
| Add a tax or benefit rule | `rules/src/` (flat, one file per rule) |
| Change what a panel draws | the matching `app/src/*View.ts` before `app/src/components/` |
| Add a life event | `engine/src/ledger/eventTypes.ts` + `eventHandlers.ts` |
| Change the retirement answer | `engine/src/retirement/` |

## Testing & exploration

To learn what the engine actually does, observe it through the REPL — `repl.ts`, run with
`npx tsx repl.ts`, which preloads a live `Projection` — then pin what you observed as a test.
Never a standalone script that gets written, read once and deleted, and never a language that
cannot import `@finley/engine`: a Python probe cannot reach the engine, so it only reimplements
the arithmetic and then confirms its own reimplementation — verification in the commit message,
nothing verified in fact.

Not yet knowing the expected value is not licence for a script. Observe the number in the REPL,
then — once it is known — write the test that asserts it. This is the step `/tdd` refuses to let
you shortcut by copying output straight into an assertion, so the REPL is where the assertion's
value is earned.

### Scope the test run

Tests sit beside their source as `*.test.ts(x)`. **Do not run `npm test` to check one change** —
it takes 2.5–3.5 minutes, nearly all of it the app's panel tests, which render a DOM of ~13,700
nodes (the default plan spans 660 months and the panels draw per-month elements). Measured:

```bash
npx vitest run packages/engine/src/retirement   # ~5s   — while iterating
npx vitest run packages/engine                  # ~13s  — 1046 tests, before handing off engine work
npx vitest run packages/app/src/goalsView.test.ts   # <1s — view-model tests
npm test                                        # ~3min — everything; pre-commit only
npm run check                                   # purity + typecheck + test — the full gate
```

`npm run typecheck` alone is ~8s and catches most mistakes.

**Prefer the view-model seam.** A behaviour expressed as a `*View.ts` function tests two to
three orders of magnitude faster than the same behaviour through a rendered panel —
`jobEditing.test.ts` runs 16 tests in 27ms; `goalsView.test.ts` 17 in 466ms; one
`baseAdjustmentsPanel.test.tsx` test can take 10s. Render a panel only when the assertion is
genuinely about the DOM.

## Not product code

`.claude/`, `.codex/`, `.sandcastle/`, `ralph/`, `docs/agents/` are tooling and agent
instructions. Skip them when searching for behaviour — they are a large share of the repo's
markdown and will dominate a grep for a domain term.

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
