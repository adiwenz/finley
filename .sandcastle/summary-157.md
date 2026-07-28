# Issue #157 — Make comments succinct

## Overview

Comments across the codebase were **too long** — paragraph-length doc blocks that
restated the code, re-explained one idea three ways, and narrated the history of
each decision. They also carried embedded issue/PR references (`#150`,
`#129/#151`, `Issue #105`, …) and decorative section banners (`// ─── Label ───`).

This branch sweeps every comment to the project's dense-but-succinct standard, in
four passes:

1. **Reference and banner strip.** Issue/PR tokens removed while the domain
   rationale they sat inside is preserved; decorative banners reduced to plain
   labels or deleted.
2. **Length sweep.** Paragraph-long comments compressed across the whole tree —
   restatement of signatures and types deleted outright, duplicate explanations
   collapsed to their clearest sentence, throat-clearing and code-history
   narration cut.
3. **Fact-carrying cut.** The length sweep alone only reached −20%, because
   rewording preserves length. This pass applies a *decision procedure* per
   comment instead: (a) if a reader learns nothing from the block that the
   declaration below already says, delete the whole block; (b) sentence by
   sentence, delete anything already stated in the same block or visible in the
   code; (c) compress only what survives.
4. **Long-block pass.** A final sweep over every comment block still 120+ words —
   mostly module headers. A header earns its length only by stating what the
   exports cannot: the layering constraint, the invariant, the rejected
   alternative, the footgun. Export enumerations and motivational framing went;
   the longest block in the tree is now 182 words (the decumulation channel's
   gross-up contract, which covers four distinct topics), down from 276.

Calibration is by file kind, not a word quota — a quota punishes files that are
already tight. Type/interface files keep per-field contracts (often the only place
a contract is written) but lose docs that re-say the field name; algorithmic
modules keep invariants and ordering constraints but lose the narrative
walkthrough; tests keep arithmetic pins and why-this-case-matters notes but lose
mechanics narration. Files already lean were left alone, and files under 1.2
comment words per line of code were excluded from the sweep entirely.

Measured: **96,044 → 55,097 comment words (−43%)**, 10,179 → 6,503 comment lines
(26% of all lines → 18%).

Kept throughout: invariants and runtime-enforced contracts, JS footguns
(`null >= 0`), rejected alternatives and what broke, legislated constants with
their SSA/IRS provenance and base years, magic-number derivations, and `§` spec
references.

The standard is encoded in the implementation prompt so future comments follow it —
now including an explicit length discipline (prefer one line; a paragraph must earn
itself; never pad to look thorough), which the first version lacked.

## Comments that contradicted the code

The per-comment procedure forces reading each claim against the declaration it
sits on, which surfaced nine comments that were simply wrong. Each was corrected
or deleted rather than compressed into a shorter falsehood:

- `projectionBase.ts` — claimed all non-liquid accounts carry the plan's return
  rate and that this drives the short-horizon risk flag. A goal's fund account
  carries `goal.annualReturnPct`, and the flag tests rate plus months-to-target,
  with liquidity playing no part.
- `allocations.ts` — claimed a goal is always the `goalPaced` sinking-fund source
  (`goalToLineItem` gives an `asap` goal a `literal` 0 source), and that a home is
  recovered from an id prefix (the code uses a `homeByLineId` map).
- `homePurchaseForm.test.tsx` — claimed jsdom is unavailable in this repo (it is a
  dependency, and a sibling test uses it), and that empty goal funds are not
  offered as funding sources (`sourcesAt` lists every labelled account with no
  balance filter; empty ones render disabled, not hidden).
- `compilePerson.ts` — cross-referenced a scalar income series in `projectionBase`
  that no longer exists.
- `presets.test.ts` — claimed each preset carries a *distinct* label and
  description above a loop that only asserts non-empty length.
- `netWorthBreakdown.ts` — claimed accounts always carry a label via the meta, but
  `accountBands` falls back with `?? humanizeId(id)` and the ordering code
  explicitly handles series-only ids.
- `allocationStep.ts` — a doc claiming one income source per (owner, category)
  where the code emits one per account.

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
