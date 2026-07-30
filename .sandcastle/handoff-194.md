# Handoff — issue 194

**Completed so far:** tasks 1-3 (Declare the input types; Resolve refs; Build fromInput)

## Live constraints

- **Types** live in `packages/engine/src/scenarioInput.ts`; ref resolution in
  `scenarioRefs.ts`; the applier is `Projection.fromInput` in `projectionRoot.ts`. All three are
  exported from the barrel. `EventEntry` discriminates on **`type`** via `eventEntryType()`
  (exhaustive `never` default) — extend that switch, never a parallel one.
- **`fromInput` takes a jurisdiction:** `Projection.fromInput(input, jurisdiction): FromInputResult`
  — NOT the bare `fromInput(input)` the issue's Shape section shows. That signature predates #195
  making the validation jurisdiction required with no default; `create`/`fromScenario`/`fromState`
  all now demand one, so `fromInput` does too. Tasks 5-6 must pass a jurisdiction (tests use
  `nullJurisdiction`). The §4.5 down-payment affordability gate only fires under a real
  jurisdiction — under `nullJurisdiction` it is silent (the issue's "Blocked on #195" note), so a
  preset/PLAN_DEFAULTS built under `nullJurisdiction` is NOT down-payment-checked. Expected, not a
  regression.
- **Plan-plane apply order is goals → jobs → budget lines**, and it is load-bearing.
  `resolveRefs` treats the plan plane as one mutually-visible block, but the applier needs a real
  topological order: a job's `deferral.fundAccountRef` and a budget line's `accountRef` can both
  name a goal's derived fund account, and a goal points at nothing — so goals must mint first. If a
  later task adds a plan-plane entry that references another plan-plane entry, re-check this order.
- **A goal ref binds to `goalFundAccountId(goal)`**, not the goal id — task 2's model.
  `fromInput` imports `goalFundAccountId`, so task 4's re-prefix (`goal-` → `fund-`) flows through
  it automatically; task 4 needs no `fromInput` edit. Well-known refs (`WELL_KNOWN_REF_IDS`,
  exported) resolve to themselves: `PRIMARY_PERSON_ID`, `SAVINGS_ID`, `RETIREMENT_ID`,
  `BROKERAGE_ID`, `SYNTHETIC_CARD_ID`.
- **A deferral with no `fundAccountRef` defaults to `RETIREMENT_ID`** (the standing 401(k)).
  `JobEntry.deferral.fundAccountRef` is optional but `JobDeferral.fundAccountId` is required, so the
  applier fills the gap. If PLAN_DEFAULTS/presets author a deferral, an omitted account means
  retirement.
- **A partner's nested `marry` jobs drop `ownerRef`** — `marry` stamps the owner it mints. Their
  own `ref` is never consumed (nothing points *at* a job), so `resolveRefs` validates it but the
  applier ignores it. Don't rely on a nested job's ref resolving to anything.
- **Refusal shape:** `ScenarioInputError { reason, eventIndex?, ref? }`. `fromInput` sets
  `eventIndex`/`ref` for event failures (both ref-graph and method refusals); plan-plane failures
  carry only `reason` (their location is in the text). Method refusals surface the raw
  `Projection: cannot …` message verbatim. If a task needs a machine-readable plan-plane index, it
  owns extending the error shape.
- **All-or-nothing** is structural: the handle is local until the last write, so a refusal returns
  `{ ok: false }` and no projection ever escapes. Don't add a partial-return path.

## Dead ends

- (none)

## Deferred

- **Task 4** owns re-prefixing `goalFundAccountId` (`goal-${id}` → `fund-${id}`) and must land
  BEFORE task 5 converts PLAN_DEFAULTS, so the doubled `goal-goal-N` form never lands. `fromInput`
  already routes through `goalFundAccountId`; task 4 only edits `projectionBase.ts` + snapshot/chart
  keys/snapshots.
- **Tasks 5-6** convert PLAN_DEFAULTS and the presets to `ScenarioInput` and delete
  `buildPresetLedger`. `fromInput` is ready for both. Note there is NO `id?` field on any
  `ScenarioInput` entry — so a preset that needs a pinned id (the issue allows this for stable
  fixtures) cannot express it through `fromInput` alone; re-read the issue's last two task notes
  before assuming the conversion is pure.
