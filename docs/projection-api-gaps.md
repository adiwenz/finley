# What the app can do that the `Projection` API cannot

`Projection` (`packages/engine/src/projectionRoot.ts`) is documented as "the high-level public
API of `@finley/engine`". The app does not use it. It holds a bare `Plan` in React state and
edits it with plain spreads, and drives the timeline through the *functional* ledger layer
(`addEvent` / `removeEvent` / `updateEvent`) via `hooks/useLedger.ts`.

So there are two write paths over the same data, and only one of them is the published API.
This file lists where they diverge. It is a map of known gaps, not a backlog — nothing here is
a defect on its own.

## Why it matters

An integrity rule added to `Projection` protects API callers only; the same rule added to a
panel protects the UI only. The goal-deletion guard is the worked example: "an event still
spends from this goal's fund account" is enforced in `Projection.removeGoal` **and**
pre-checked by the goals panel, because neither path can reach the other. The rule itself is
shared — both call `eventsFundedByGoal` — so they cannot drift, but the *wiring* is duplicated
and will be for every rule like it.

Any gap below is a place where the same duplication would be needed if that operation ever
grows a rule.

## Standing edits (the `Plan`)

`Projection` has five: `addJob`, `addBudgetLine`, `addGoal`, `removeGoal`, `setRetirementTarget`.

| The app does | Where | `Projection` |
| --- | --- | --- |
| Edit a goal's name, target, date, disposition, account type | `goalsView.updateGoal` | — |
| Set a goal's return rate | `goalsView.setGoalRate` | — |
| Reorder goals | `goalsView.reorderGoal` | — (appends only) |
| Edit a job | `planPeople.updateJobInList`, `jobEditing.editJob` | — |
| Remove a job | `planPeople.removeJobFromList` | — |
| Add/remove a pay change | `planPeople.addJobPayChange`, `removeJobPayChange` | — |
| Add an income override | `planPeople.addIncomeOverride` | — |
| Set a job's monthly income | `planPeople.setJobMonthlyIncome` | — |
| Set a job's 401(k) deferral fraction | `planPeople.setJobDeferralFraction` | — |
| Edit or remove a budget line | `baseAdjustments/budgetLines.updateLineFromDraft`, `removeLine` | — (adds only) |
| Edit any other plan scalar | `budgetEditor.updateBudget(patch)` | — (only `retirementAge`) |

Goal **priority** is the sharpest of these: priority is a goal's index in `Plan.goals`, and
`addGoal` appends, so an API caller can only ever author goals in lowest-priority order and
has no way to reorder them afterwards.

The plan-scalar row covers roughly fifteen fields the budget editor patches freely —
`openingBalanceCents`, `savingsReturnPct`, `retirementReturnPct`, `brokerageReturnPct`,
`inflationPct`, `healthMonthlyCents`, `postCoverageHealthMonthlyCents`, `healthInflationPct`,
`enrollsInPublicHealthCoverage`, `currentAge`, `lifeExpectancy`, `benefitClaimingAge`,
`sharedScheme`, `surplusCashTo`, `name` — against the one setter `Projection` exposes.
`budgetEditor` takes a `Partial<Plan>`, so it can write any field the type has.

## Ledger transactions (events)

`Projection` has three: `marry`, `takeLoan`, `buyHome`.

| Event the app authors | Form | `Projection` |
| --- | --- | --- |
| `RelationshipEvent` | `relationshipForm` | `marry` |
| `LoanEvent` | `loanForm` | `takeLoan` |
| `HomePurchaseEvent` | `homePurchaseForm` | `buyHome` |
| `ChildEvent` | `childForm` | — |
| `SeparationEvent` | `separationForm` | — |
| `BudgetItemStartEvent` | `expenseForm` | — |

`BudgetItemEndEvent` and `DebtPayoffEvent` are in the union and handled by the simulator, but
authored by neither surface today. `DebtPayoffEvent` in particular is only half-real: nothing
constructs one outside tests.

## Event lifecycle

`Projection` can only append. The functional layer already has the rest, and the app uses it:

- **Remove** — `useLedger.removeEvent` → `removeEvent`, which refuses when a dependent would
  fail and surfaces the conflict. `Projection` has no `removeTransaction(id)`; its own class
  comment names it as future work.
- **Revise** — `useLedger.reviseEvents` → `updateEvent`. No `Projection` equivalent.
- **Replace wholesale** — `useLedger.resetLedger`, used when loading a starter scenario. No
  `Projection` equivalent, though `fromJSON` gets you there.

## The shape of the gap

`Projection` is an *append-only authoring* API: it creates things and runs the projection. The
app is a full editor. Closing the gap is not a matter of adding a few methods — it is deciding
whether `Projection` becomes the app's state root (at which point every panel's local guard
collapses into the API and this file goes away) or stays a separate published surface that has
to mirror rules the app enforces independently.
