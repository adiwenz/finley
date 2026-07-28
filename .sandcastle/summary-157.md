# Issue #157 — Make comments succinct

## Overview

Comments across the codebase carried embedded issue/PR references (`#150`,
`#129/#151`, `Issue #105`, `#122-consistent`, …) and decorative section
banners (`// ─── Label ───────`). This branch sweeps every comment to the
project's dense-but-succinct standard: issue/PR reference tokens are stripped
while the domain rationale they sat inside is preserved, decorative banners are
reduced to plain labels or deleted, and the same standard is encoded in the
implementation prompt so future comments follow it.

No behavior changed. Every source/JSX/signature/string-literal/test-description
line is byte-identical; only comment text was edited.

## RGR Verification Details

The concrete, machine-checkable acceptance criteria (no issue refs in comments;
prompt carries the rule) are guarded by a new test,
`packages/engine/src/comments.guard.test.ts`, which:

- Walks every `.ts`/`.tsx` under `packages/`, strips string and template
  literals (so hex colors like `"#000"` and URLs in code never register), then
  extracts only comment text and asserts none matches an issue/PR reference
  pattern (`#\d{2,}`, `GH-\d+`, `issue N`, `PR N`, issue/pull URLs).
- Asserts the implementation prompt contains the comment-style rule.

**RED:** Before the sweep the guard reported **47 offending comment lines**
across 28 files, and both prompt assertions failed (rule absent).

**GREEN:** After the sweep + prompt edit, both tests pass. Full suite:
**973 passed | 45 todo (82 files)**, `typecheck` clean, engine purity check
clean.

## Key Decisions & Why

- **Guard test as the RED→GREEN anchor.** A comment-only change has no runtime
  behavior to test, so the testable seam is the *invariant the issue
  establishes*: "no issue/PR numbers survive in any comment" and "the prompt
  carries the rule." Both are repo-wide and regression-prone, so a standing
  guard is the right artifact — it also fails loudly if a future comment
  reintroduces a reference.
- **Strip strings before scanning comments.** Hex color literals
  (`const INK = "#1f3a2e"`) and pure-digit ones (`"#000"`) would otherwise
  false-positive against `#\d{2,}`. A small hand-rolled scanner drops
  string/template contents and keeps only comment spans, so the guard flags
  comments and nothing else.
- **`#\d{2,}` as the reference detector.** Every issue reference in the repo is
  a 3-digit number; hex colors referenced *inside* comments (e.g. `#6b93b8`)
  begin with a single digit, so requiring 2+ digits cleanly separates the two.
  `§4.5`-style spec-section references are deliberately **kept** — they cite the
  spec, not an issue.
- **Banners → plain labels, not blanket deletion.** A decorative separator with
  a descriptive label (`// ─── Legislated constants (one place, disclaimed) ───`)
  carries a real fact (single source of truth, disclaimed). Per the issue's
  "keep facts, delete decoration" rule, the `───` decoration is removed and the
  label kept as a plain `//` comment. Pure structural separators with no added
  information (`// ── Formula ──`, the `===` banners that merely duplicated the
  adjacent `console.log`) were deleted outright.
- **Comments-only, verified mechanically.** Every changed file was checked with
  `git diff -U0` filtered to non-comment added/removed lines — the result is
  empty, proving no code moved.
- **Test descriptions left intact.** A `describe("… (#150)")` title is a string
  literal (code), not a comment; per the issue's "comments only" rule it was not
  touched, and the guard (which strips strings) does not flag it.

## Changes Made

- **`.sandcastle/new_flow/implement-prompt.md`** — added a "Comment Style"
  section: *"Comments must be dense, not merely short. Explain why, plus any
  cases, constraints, or invariants not evident from the code. Never restate the
  code. Never reference issue or PR numbers."* (AC3)
- **`packages/engine/src/comments.guard.test.ts`** *(new)* — repo-wide guard for
  the two machine-checkable ACs.
- **Engine source (13 files)** — `goal.ts`, `plan.ts`, `projectionRoot.ts`,
  `ledger/{addEvent,eventTypes,funding,interpretState,transfers}.ts`,
  `projection/{fundingDrawStep,runState,simulate,simulate.types,withdrawal}.ts`:
  issue references stripped (domain text kept); `─── … ───` banners reduced to
  plain labels; one stale duplicate separator block deleted in `simulate.ts`.
- **Engine tests (11 files)** — `events.homePurchase.test.ts`,
  `ledger/funding.test.ts`, `cashFlowSeries.test.ts`, `events.budgetItems.test.ts`,
  `events.loans.test.ts`, `events.mechanics.test.ts`, `events.relationships.test.ts`,
  `events.test.ts`, `invariants.test.ts`, `projection/reportFlows.test.ts`,
  `snapshot.test.ts`: issue references stripped; decorative banners → plain
  labels or deleted (an `invariants.test.ts` label carrying a real instruction —
  "PIN THESE BY HAND" — was kept, decoration removed).
- **App (14 files)** — `components/addEventForm/{addEventForm,fundingSourcePicker,
  fundingSourcePicker.test,homePurchaseForm,homePurchaseForm.test}.tsx`,
  `components/goalsPanel/{goalForm.tsx,goalsPanel.test.tsx}`,
  `components/retirementPanel/retirementPanel.test.tsx`, `goalsView.ts`,
  `goalsView.test.ts`, `planDefaults.ts`, `planDefaults.test.ts`, `presets.test.ts`,
  `ledgerView.ts`: issue references stripped; banners de-decorated. Hex color and
  `§` spec references preserved.
- **Rules (5 files)** — `contributionLimits.ts`, `federalTaxTables.ts`,
  `healthCosts.ts`, `rmd.ts`, `socialSecurity.ts`: `── Label ──` banners reduced
  to plain labels; the pure `── Formula ──` separator deleted. (No issue
  references existed in `rules`.)

## Verification & Testing

- `npx vitest run packages/engine/src/comments.guard.test.ts` — **2 passed**
  (RED was 2 failed / 47 offenders).
- `npm run test` — **973 passed | 45 todo (82 files)**.
- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity passed.
- `git diff -U0` filtered to non-comment lines across all modified files —
  **empty** (all changes are comment-only; no behavioral diff).
