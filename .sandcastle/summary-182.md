# Issue #182 — What the app can do that the Projection API cannot

## Overview

`Projection` (`packages/engine/src/projectionRoot.ts`) is the published high-level API of
`@finley/engine`, but it was *append-only authoring*: it could create a goal, a job, a budget
line and three kinds of transaction, and run the projection — nothing else. The app, meanwhile,
is a full editor over the same data through a second write path (plain `Plan` spreads plus the
functional ledger layer).

The issue maps every divergence between the two. **This change closes all of them**, so the two
write paths reach the same set of operations and an integrity rule added to `Projection` no
longer protects strictly less than the same rule added to a panel.

`Projection` is now add / edit / remove for every authorable thing, rather than an authoring
funnel that has to be escaped through `fromJSON`.

## The issue's map, row by row

### Standing edits (the `Plan`)

| The app does | `Projection` before | `Projection` now |
| --- | --- | --- |
| Edit a goal's name, target, date, disposition, account type | — | `updateGoal` |
| Set a goal's return rate | — | `updateGoal` (subsumes it) |
| Reorder goals | — (appends only) | `reorderGoal` |
| Edit a job | — | `updateJob` |
| Remove a job | — | `removeJob` |
| Add/remove a pay change | — | `addJobPayChange` / `removeJobPayChange` |
| Add an income override | — | `addJobIncomeOverride` / `removeJobIncomeOverride` |
| Set a job's monthly income | — | `setJobMonthlyIncome` |
| Set a job's 401(k) deferral fraction | — | `setJobDeferralFraction` |
| Edit or remove a budget line | — (adds only) | `updateBudgetLine` / `removeBudgetLine` |
| Edit any other plan scalar | — (only `retirementAge`) | `updatePlan(PlanPatch)` |

`updateGoal` / `reorderGoal` landed in the branch's first commit; the rest are new here.

### Ledger transactions

| Event | `Projection` before | `Projection` now |
| --- | --- | --- |
| `RelationshipEvent` | `marry` | `marry` |
| `LoanEvent` | `takeLoan` | `takeLoan` |
| `HomePurchaseEvent` | `buyHome` | `buyHome` |
| `ChildEvent` | — | `haveChild` |
| `SeparationEvent` | — | `separate` |
| `DebtPayoffEvent` | — | `payOffDebt` |
| `BudgetItemStartEvent` | — | **n/a** — retired by #158; no longer in the union |

The issue's event table predates #158, which removed `BudgetItemStartEvent` and
`BudgetItemEndEvent` from `LifeEvent` entirely (recurring spend lives in Base + Adjustments).
So the union is now fully covered: every event type the simulator handles has an authoring
method. `DebtPayoffEvent`, which the issue called "only half-real: nothing constructs one
outside tests", now has a real constructor.

### Event lifecycle

| Capability | `Projection` before | `Projection` now |
| --- | --- | --- |
| Remove | — (named as future work in the class comment) | `removeTransaction(id)` |
| Revise | — | `reviseTransaction(id, next)` |
| Replace wholesale | — (`fromJSON` only) | `resetLedger(ledger)` |

Plus a `ledger` getter, the companion to the existing `plan` getter: removal and revision are
addressed **by id**, so a caller has to be able to read the ids.

## Key Decisions & Why

- **`PlanPatch` excludes the collections, at runtime as well as in the type.** The one
  free-form setter takes every `Plan` field *except* `goals`, `jobs` and `budgetLines`. Those
  have methods that mint stable ids and enforce rules — `removeGoal` refuses while an event
  still spends from a goal's fund account — and a bare `Partial<Plan>` would make
  `updatePlan({ goals: [] })` a way straight past that guard. The type blocks it, and
  `updatePlan` also destructures the three collections off the patch before spreading, because
  `Projection` is published to JavaScript callers the type never reaches. A type that is the
  only guard is not a guard.
- **Patches, not whole drafts.** `updateJob` / `updateBudgetLine` / `updateGoal` all take a
  partial: a programmatic caller names only what changes, and everything unnamed carries
  through — a job's accumulated pay changes and its deferral's `fundAccountId`, a budget line's
  `span` / `overrides` / `priority`. This is deliberately the app's `applyJobDraft` rule ("form
  fields overwrite, everything else carries") rather than its `lineFromDraft` rebuild, since an
  API caller has no form to round-trip through.
- **`setJobDeferralFraction` earns its place beside `updateJob`.** It is not sugar: 0 *removes*
  the deferral rather than recording a 0% one, and a positive fraction preserves the funded
  account and employer match, which belong to the employment and not to the elected rate. That
  asymmetry is a rule; `updateJob`'s `deferral` patch replaces the whole object.
- **No guard on job / budget-line removal.** `removeGoal` is guarded because dropping a goal
  drops its derived `goal-<id>` fund account, which an event may still reference. A job or a
  budget line derives no such account, so no ledger reference can dangle. The docstrings say
  so, rather than leaving the absence unexplained.
- **Plan edits do not re-validate the ledger.** Editing income changes the projection base, but
  the affordability gate is an append-time check — a transaction already accepted stays
  accepted. That matches the app exactly (the gate fires only on `addEvent`), so the two paths
  do not diverge on when a plan edit can invalidate a purchase.
- **`removeTransaction` / `reviseTransaction` delegate to the functional layer.** They wrap
  `removeEvent` / `updateEvent` — the same transitive-dependent closure and whole-ledger replay
  the app gets through `useLedger` — and convert a refusal into the thrown-with-state-untouched
  contract `removeGoal` and `commitEvent` already give. The rules are shared, not re-stated.
- **`resetLedger` is the one ledger write with no gate**, and its docstring says so: the caller
  owns the incoming ledger's validity, exactly as the app's preset load does. It exists because
  `fromJSON` discards the plan the timeline was authored against.
- **One `baseConfig()` helper.** `commitEvent`, `removeTransaction` and `reviseTransaction` all
  need the same `nullJurisdiction` replay context; it is built once rather than three times.
- **Ids follow the existing mint.** `haveChild` → `child-N` (one id for the event and the
  durable child, as `buyHome` does for a property), `separate` → `separation-N`, `payOffDebt`
  → `payoff-N`, all off the single shared counter so nothing collides.

## Changes Made

- `packages/engine/src/projectionRoot.ts`
  - New types: `JobPatch`, `BudgetLinePatch`, `PlanPatch`, `HaveChildInput`, `SeparateInput`,
    `PayOffDebtInput`.
  - Jobs: `updateJob`, `removeJob`, `setJobMonthlyIncome`, `setJobDeferralFraction`,
    `addJobPayChange`, `removeJobPayChange`, `addJobIncomeOverride`, `removeJobIncomeOverride`.
  - Budget lines: `updateBudgetLine`, `removeBudgetLine`.
  - Plan scalars: `updatePlan`; `setRetirementTarget` now routes through it.
  - Transactions: `haveChild`, `separate`, `payOffDebt`.
  - Lifecycle: `removeTransaction`, `reviseTransaction`, `resetLedger`, and a `ledger` getter.
  - Private `mapJobs` (one "which job, leave the rest alone") and `baseConfig`.
  - Class docstring: states the add/edit/remove contract, and drops the "a future
    `removeTransaction(id)`" note now that it exists.
- `packages/engine/src/index.ts` — barrel-exports the six new types.
- `packages/engine/src/projectionRoot.test.ts` — six new describe blocks (36 new tests): job
  editing and removal, pay changes and income overrides, budget-line editing and removal, plan
  scalars (including a `@ts-expect-error` + runtime assertion that the collections are
  unreachable), the three new transactions with their refusals, and the transaction lifecycle
  with its conflict cases.

## Verification & Testing

- `npm run typecheck` → clean.
- `npm run check:purity` → engine purity passed (no I/O, no app/rules imports).
- `npm test` → **1052 passed | 45 todo (1097)**, 85 files, all green.
  `projectionRoot.test.ts`: 58 passed (was 22 before the branch, 28 after the first commit).

## Notes for the next iteration

Every row of the issue's map is closed. What remains is the architectural question the issue
itself closes on, which no set of methods answers: whether `Projection` **becomes** the app's
state root — at which point every panel's local guard collapses into the API and the
duplicate-wiring problem goes away — or stays a separate published surface that has to mirror
rules the app enforces independently. Parity means the two surfaces can now hold the same
rules; it does not mean they share one implementation of them. The goal-deletion guard is still
wired twice.
