# Handoff — issue 194

**Completed so far:** tasks 1-2 (Declare the input types; Resolve refs)

## Live constraints

- **Types** live in `packages/engine/src/scenarioInput.ts`. `EventEntry` is a discriminated union
  on **`type`**, keyed by `eventEntryType()` (exhaustive switch, `never` default). Task 3 must
  extend that switch, not add a parallel one.
- **Ref resolution** is task 2's `resolveRefs(input)` in `packages/engine/src/scenarioRefs.ts`
  (exported from the barrel). It is a **standalone validation pass — it mints no ids.** It returns
  `{ ok: true, order }` or `{ ok: false, error }`; `order` is the events stable-sorted by `month`
  (array position breaks ties), each carrying its ORIGINAL `input.events` index. **Task 3 must
  reuse `resolveRefs` first, then mint over its returned `order`** — do not re-sort or re-validate.
- The resolution model task 3 must honour when minting: the plan plane (`jobs`, `goals`,
  `budgetLines`) applies as one block first, so its declarations are mutually visible; events then
  apply in `order`, each seeing only strictly-earlier events. A declared **goal** ref resolves to
  its DERIVED fund account `goalFundAccountId(goal)`, not the goal id. Well-known refs
  (`WELL_KNOWN_REF_IDS`, exported) resolve to themselves: `PRIMARY_PERSON_ID`, `SAVINGS_ID`,
  `RETIREMENT_ID`, `BROKERAGE_ID`, `SYNTHETIC_CARD_ID`. `SAVINGS_ID`/`BROKERAGE_ID` were
  module-private in `projectionBase.ts`; task 2 exported them (needed for the well-known set).
- `EventEntry`'s six variants map 1:1 to the six `Projection` authoring methods in
  `projectionRoot.ts` (`marry`/`haveChild`/`takeLoan`/`buyHome`/`separate`/`payOffDebt`). Each of
  those takes ID-bearing inputs (`ownerId`, `fundAccountId`, `downPaymentSourceIds`, …); task 3
  translates entry refs → minted ids via a registry it fills as it applies, then calls the method.
  `MarryInput.jobs` is `JobInput[]` (ID-free, owner minted by `marry`); a marry's nested jobs are
  applied at the marry's order — `resolveRefs` already validates their refs at that instant.
- `FromInputResult` references `Projection` via a **type-only** import from `projectionRoot.ts`.
  When `projectionRoot.ts` gains `fromInput` (task 3), keep the back-edge cycle-free by having
  `fromInput` return the shape, not by turning that type import into a value import in
  `scenarioInput.ts`.
- A goal ref resolves to `goalFundAccountId(goal)`. Task 4 re-prefixes that from `goal-${id}` to
  `fund-${id}`; do task 4 before converting `PLAN_DEFAULTS` (task 5) so the doubled `goal-goal-N`
  form never lands. Task 2 did NOT touch `goalFundAccountId`.

## Dead ends

- (none yet)

## Deferred

- `fromInput` itself — task 3. Task 2 stops at validating the ref graph and returning the event
  schedule; nothing applies or mints yet.
- `ScenarioInputError` currently carries `{ reason, eventIndex?, ref? }`. `resolveRefs` sets
  `eventIndex` only for event (or nested-in-event) failures; plan-plane failures encode their
  location in `reason` (`"job entry 0 …"`, `"budget line entry 2 …"`) with `eventIndex` undefined.
  If task 3 needs a machine-readable plan-plane index, it owns extending the error shape.
