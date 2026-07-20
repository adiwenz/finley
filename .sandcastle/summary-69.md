# Slice 6 — Unified `allocations()` view + waterfall ordering (folds in #26) — issue #69

## Overview

This slice unifies the three things that compete for a month's cash — per-job
pre-tax 401(k) deferrals, budget line items, and goals — into one ordered
`allocations()` view, and folds #26's deadline-paced (sinking-fund) goal funding
into the waterfall. Reads unify; writes route to the **canonical home** (401k → job,
expense/contribution → budget, goal semantics → goal). Goals now fund via a
growth-aware sinking-fund **pace** rather than the old strict fill-order, so two
affordable goals with different deadlines both reach 100% regardless of priority
order; priority only bites under scarcity. Drawdown was already RMD-first and
tax-efficient; this slice makes the liquidation order **overridable** (§16).

All engine deliverables are pure and jurisdiction-agnostic (`check:purity` clean).

## RGR Verification Details

Each unit was built RED → GREEN:

1. **`requiredContributionCents` (AC7):** wrote `sinkingFund.test.ts` first → RED
   (module missing) → implemented `sinkingFund.ts` → GREEN (6 tests). Covers the
   zero-rate (even spread) and near-deadline (`monthsRemaining ≤ 1` → full gap) edge
   cases, plus the growth-aware annuity identity.
2. **Growth-aware `goalPaced` line source:** added a RED test in `budgetLine.test.ts`
   (a fund rate must lower the pace) → threaded `fundMonthlyRate` through
   `ResolveLineContext` and delegated to `requiredContributionCents` → GREEN.
3. **Fund-to-pace waterfall (AC3–6, AC8):** rewrote the goal describe-block in
   `waterfall.test.ts` to pacing semantics → 8 RED failures → reworked `fundGoals`
   into a two-pass paced loop → GREEN (21 tests). Threaded `nowMonth` +
   `goalFundMonthlyRate` from the simulator; existing `simulate` disposition tests
   stayed green because their $2k/mo scenario is exactly on-pace.
4. **`allocations()` unified view (AC1, AC2):** wrote `allocations.test.ts` first →
   RED → implemented `allocations.ts` (selector + `goalToLineItem` + `routeAllocationWrite`)
   → GREEN (10 tests).
5. **Overridable drawdown order (AC9):** added direct-unit RED tests on
   `buildWithdrawalSources` (default order, override, RMD-first, exported constant) →
   added `DEFAULT_LIQUIDATION_ORDER` + optional `liquidationOrder` param → GREEN.
6. **Amortization integration (AC3, AC8):** added `simulate.test.ts` tests proving a
   dated goal climbs an amortized path (not fill-then-idle) and both affordable goals
   hit 100% regardless of order.

## Key Decisions & Why

- **One primitive, three consumers.** `requiredContributionCents(target, balance,
  monthsRemaining, monthlyRate)` is the single sinking-fund calc, solving
  `balance·(1+r)^m + c·((1+r)^m − 1)/r = target` for `c`. The `goalPaced` line source
  and the waterfall's goal loop both call it, so pace math never drifts. The two edge
  cases are the mathematical **limits** of that formula, not special-cased guesses:
  zero-rate is the `r→0` limit (`(target−balance)/m`, also dodging the 0/0);
  near-deadline is `m ≤ 1` (the whole gap is due now). Always clamped ≥ 0.
- **Pace vs. triage split (#26).** The waterfall funds each *dated* goal up to its
  pace in priority order (pass 1); `asap` goals — which have no deadline, hence no
  pace — fill fill-order from the remainder afterward (pass 2). When every pace fits,
  order is a no-op and each goal amortizes to its own date; only under scarcity does
  priority decide who falls behind. This is exactly #26's "deadline sets the pace,
  priority becomes scarcity triage."
- **Canonical-home routing (§13/§20).** Every `Allocation` carries a discriminated
  `home` (`job` / `budgetLine` / `goal`) with a stable id derived from it, and
  `routeAllocationWrite` validates that an edit kind belongs to that home (a
  deferral edit can't land on a goal). This is the §20 "no `Adjustment` entity" rule
  in code: one fact, one home, so reads never contradict and undo rides on the home.
- **Merge order mirrors cash flow (§13).** Pre-tax deferrals sort first (off gross,
  above the tax line); budget lines and goals share one post-tax band ordered by flat
  waterfall priority (§15), goals folded in as computed goal-paced line items (§14)
  via `goalToLineItem`. Category tier supplies the default priority via the shared
  `budgetLinePriority` helper (single source of truth, reused by `orderBudgetLines`).
- **Additive, zero-regression.** `nowMonth`/`goalFundMonthlyRate` on `WaterfallInput`
  and `liquidationOrder` on `buildWithdrawalSources` are optional with
  behavior-preserving defaults, so the scalar path and every existing sim test stay
  green. Nothing scalar was removed — that remains #72's job.

## Changes Made

- **`sinkingFund.ts` (new):** `requiredContributionCents` — the pure growth-aware
  sinking-fund pace.
- **`allocations.ts` (new):** `allocations()` unified ordered view; `goalToLineItem`
  (goal → computed goal-paced line, §14); `routeAllocationWrite` + `AllocationEdit`
  (canonical-home write routing); `budgetLineAllocationId`; supporting types.
- **`budgetLine.ts`:** `goalPaced` now delegates to `requiredContributionCents`
  (growth-aware) via a new optional `ResolveLineContext.fundMonthlyRate`; extracted
  `budgetLinePriority` as the shared tier-default helper.
- **`projection/waterfall.ts`:** `fundGoals` reworked to the two-pass fund-to-pace
  loop; `WaterfallInput` gains optional `nowMonth` + `goalFundMonthlyRate`.
- **`projection/simulate.ts`:** `allocateMonth` threads the current `month` and a
  per-fund monthly-rate lookup into the waterfall.
- **`projection/withdrawal.ts`:** exported `DEFAULT_LIQUIDATION_ORDER`; added the
  optional `liquidationOrder` override to `buildWithdrawalSources` (§16 overridable).
- **`index.ts`:** exported the new modules.
- **Tests:** `sinkingFund.test.ts`, `allocations.test.ts` (new); pacing/amortization/
  order-independence/override coverage added to `budgetLine`, `waterfall`, `simulate`,
  and `withdrawal` test suites.

## Verification & Testing

- `npm run check:purity` — ✓ engine purity (no I/O, no app/rules imports).
- `npm run typecheck` — ✓ clean.
- `npm run test` — **502 passed | 45 todo (547) across 43 files**, 0 failures.

### Acceptance-criteria mapping

| AC | Where verified |
|----|----------------|
| Unified ordered view, stable ids | `allocations.test.ts` |
| Writes route to canonical home | `allocations.test.ts` (`routeAllocationWrite`) |
| Goals fund via goal-paced; both affordable goals reach 100% regardless of order | `waterfall.test.ts`, `simulate.test.ts` |
| Waterfall funds to pace; order bites only under scarcity | `waterfall.test.ts` |
| `asap` goals fund from remainder after dated goals | `waterfall.test.ts` |
| Surplus routes to configured destination | `waterfall.test.ts` |
| `requiredContributionCents` pure + zero-rate/near-deadline | `sinkingFund.test.ts` |
| Dated goal amortizes to target by deadline (not fill-then-idle) | `simulate.test.ts` |
| Drawdown RMD-first, tax-efficient default, overridable | `withdrawal.test.ts` |

## Notes for the next iteration

- `goalToLineItem` represents an `asap` goal with a placeholder `literal` 0 source
  (the waterfall funds asap goals fill-order from the remainder, not via a dated
  pace). The dateless `asap` **completion** rule (fire `spend`/`convertToEquity` on
  balance ≥ target) is deliberately out of scope here — split out to #79.
- The unified `allocations()` view is a pure selector; wiring it into the
  `Projection` facade (the stateful root with one undo stack) and rewiring the app's
  scalar call sites is the single hinge at #72.
- Goal funding still flows through `state.goals` (SimGoal[]) in the simulator;
  `goalToLineItem` is the read-projection that proves the §14 "a goal is a computed
  line item" equivalence without a risky mid-branch simulator rewire.
