# Handoff — issue 194

**Completed so far:** task 1 (Declare the input types)

## Live constraints

- Types live in `packages/engine/src/scenarioInput.ts`, exported from the barrel
  (`index.ts`). `EventEntry` is a discriminated union on **`type`**, keyed by `eventEntryType()`
  (exhaustive switch, `never` default). Task 2/3 must extend that switch, not add a parallel one.
- `EventEntry`'s six variants map 1:1 to the six `Projection` authoring methods in
  `projectionRoot.ts` (`marry`/`haveChild`/`takeLoan`/`buyHome`/`separate`/`payOffDebt`) — build
  each event by translating its entry's refs to ids, then calling the matching method.
- Ref positions to resolve (task 2): `JobEntry.ownerRef`/`deferral.fundAccountRef`,
  `BudgetTargetInput.accountRef`, every event's `ownerRef`/`liabilityRef`/`accountRef`/
  `partnerRef`/`downPaymentSourceRefs`. `ScenarioInputError` already carries `{ reason,
  eventIndex?, ref? }` for naming the offending entry.
- `FromInputResult` references `Projection` via a **type-only** import from `projectionRoot.ts`.
  When `projectionRoot.ts` gains `fromInput` (task 3) it will import these authoring types back —
  keep that back-edge type-only-free-of-cycle by having `fromInput` return the shape, not by
  moving the class import to a value import in `scenarioInput.ts`.
- A goal ref resolves to its DERIVED fund account (`goalFundAccountId(goal)`), not the goal id —
  noted on `GoalEntry`. Task 4 re-prefixes `goalFundAccountId` to `fund-${goal.id}`; do task 4
  before converting `PLAN_DEFAULTS` (task 5) so the doubled `goal-goal-N` form never lands.
- Well-known ref targets (task 2 rule 2): `PRIMARY_PERSON_ID` (`projectionBase.ts:37`), and the
  three standing account ids `SAVINGS_ID`/`RETIREMENT_ID`/`BROKERAGE_ID` (`projectionBase.ts:38,
  RETIREMENT_ID exported from ids.ts`), plus `SYNTHETIC_CARD_ID` (`liability.ts:118`). Note
  SAVINGS_ID/BROKERAGE_ID are module-private in `projectionBase.ts` today.

## Dead ends

- (none yet)

## Deferred

- `fromInput` itself — task 3. This task is types only; `eventEntryType` is the sole runtime
  export so far.
- Ref resolution logic — task 2. The types name the ref fields; nothing resolves them yet.
