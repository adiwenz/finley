# Handoff — how to build this with Claude Code

The build artifacts:
- **`BUILD_SPEC.md`** — the source of truth: *what* to build and every architectural decision.
- **`ARCHITECTURE.md`** — *how it's partitioned and shipped*: the three-repo open-core split
  (public `engine` + `rules`, private `app`), dependency direction, engine-purity rule, and the
  phased build order across repos.
- **`TEST_PLAN.md`** — *what correctness means*: the invariants, grouped.
- **`invariants.test.ts`** — a runnable suite: the invariants that are checkable now (green) plus
  `todo` targets for the rest. Contains the pinned known-value anchors.
- **`cashFlowSeries.ts` / `cashFlowSeries.test.ts`** — the already-built, already-passing
  foundation (build step 1 extends this; do not regenerate it). Lives in the **`engine`** repo.

Put all of these **in the repo** (e.g. spec + plans in `/docs`, code at the root or `/src`) and
add a `CLAUDE.md` that points to `BUILD_SPEC.md` as the source of truth and states the guardrails
below. Commit the foundation files first.

**This workflow applies PER REPO.** Per `ARCHITECTURE.md`, build in phases across three repos
(walking skeleton across all three → `engine` core → `rules` → `app`). The invariant suite is the
gate in `engine`; `rules` needs its own known-value anchors (published tax tables, a hand-computed
Social Security benefit); `app` gets integration tests. The foundation code files belong to
`engine`.

---

## Workflow

1. **Give the spec** — as repo files, not pasted. Commit `cashFlowSeries.*` so Claude Code builds
   *around* the passing foundation.
2. **Grill me** — have Claude Code read the spec and interrogate it. Point the grilling at
   **§10 Open decisions** — those must be resolved by you here, not guessed later.
3. **PRD — keep it thin.** Scope, milestones, acceptance criteria only. Do NOT restate the
   architecture (that's the spec); if the two drift, bugs follow. Reuse the v1/deferred lists and
   build order already in §1.
4. **Issues** — one per build step (§1 steps 1–10 are nearly this already). Each links its spec
   section and its acceptance tests. **Preserve dependency order** — later components assume
   earlier invariants.
5. **Loop (per-issue, supervised)** — the highest-risk step, because wrong financial math is
   *silent* (plausible numbers that are wrong). Guardrails below.
6. **Check the code** — review for the specific invariants, not just "does it run" (list below).
7. **Accept & commit per-issue** — not one big batch. Bisectable history; matches "each step
   passes before the next."

**Two additions to the bare workflow:**
- **Walking skeleton first** — before heavy implementation, stand up the thinnest end-to-end
  path (a trivial `simulate()` on an empty ledger → bare UI that renders it). Proves the seams
  connect (engine ↔ state ↔ UI) before real logic goes in.
- **Run the invariant suite every loop iteration** — not just per-component unit tests.

---

## Guardrails (put these in CLAUDE.md)

1. **The loop does not write its own correctness tests for money math.** Pin acceptance tests in
   the issue. If the same loop writes both code and its tests, it can converge on
   internally-consistent-but-wrong. In particular:
2. **Never edit the §9 known-value anchors in `invariants.test.ts`.** Those assert against
   external truth (published amortization, closed-form compounding) and are the backstop. The
   loop MAY convert a `todo` into a real test as it builds the matching component; it may NOT
   change an anchor's expected numbers.
3. **Loop per-issue, then checkpoint** for human review before the next. Never run unsupervised
   across all 10 steps — an early wrong assumption compounds through everything after it.
4. **The invariant suite staying green is the gate** each issue must pass before commit
   (todos may shrink; a FAIL blocks).

---

## What to look for in code review (the invariants that are cheap to violate, expensive to fix)

- **Integer-cents discipline** — no float ever leaks into a balance, series value, or transfer.
- **Single compounding point (§0.2)** — growth happens in exactly one place; disabling it makes
  balances go flat. No growth hiding in event or allocation logic.
- **Immutable ledger / remove-then-replay (§6)** — no in-place edit of a stored event; every
  change is add-record or remove-record-then-replay.
- **Precise monthly rate** — `(1+annual)^(1/12) − 1`, never `annual/12` (the shortcut is a
  systematic error that compounds into real dollars over decades; the compounding anchor guards
  against it).
- **Tax seams are real seams (§5.3)** — one `computeTax()` chokepoint and routed withdrawals, not
  tax logic smeared around. `taxTreatment` present on every account even though v1 ignores it.
- **Tagging isolation (§4.3)** — a separation ends partner streams only; child-cost and mortgage
  streams (owned by other events) are untouched.

---

## Order of dependencies (do not reorder)

`CashFlowSeries` (exists) → extend it (step 1) → `Account` incl. rate-segments + one-time
transfers (2) → `Person`/`Household`/`Property` + `ownerId` (3) → `FinancialState` (4) → events
incl. Refinance/Sale + durable entities (5) → `Simulator` + waterfall + shortfall + multi-income
(6) → undo/cascade (7) → retirement (8) → government programs: Social Security, Medicare, RMDs
(9) → recommendations (10) → UI incl. snapshot/scrubber + temporal views (11). Each assumes the
invariants of the ones before it.
