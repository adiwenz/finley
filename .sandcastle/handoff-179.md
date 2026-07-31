# Handoff — issue 179

**Done so far:**
- **Cut 1 (task 1/4) — DONE.** Anchors + reused-event holdings. Three dedicated authoring
  methods + their `ScenarioInput` entries, no new event types, no decomposition. Pre-now
  separation works through the existing `separate` method (no new method — the floor already
  covered `≥ marriage`).
- Remaining: **Decomposition** (split `HomePurchaseEvent`), **Cut 2** (`ownHome` holding),
  **Glossary** (CONTEXT.md: *Holding* / *Anchor* entries). See the issue body for each.

## Live constraints (consumed by later tasks)
- **The month convention lives in one place per surface.** Each pre-existing doorway computes its
  own internal month and never exposes it: `startPartnered` → `-partneredForMonths`,
  `haveExistingChild` → birth at `-ageMonths` (event month AND `birthMonth` both set),
  `carryLoan` → `PRE_NOW_MONTH` (-1). When you add `ownHome`, follow the same rule — the `-1`
  convention stays inside the engine; the method takes current terms.
- **`entryMonth(entry)` in `scenarioInput.ts` is load-bearing.** `scenarioRefs.ts` sorts the event
  schedule by it, so forward-ref detection and replay order agree. Every new entry whose method
  computes its month internally (e.g. `ownHome`) MUST get a case there, or it sorts as `month:
  undefined` and the ref graph breaks. Anchors/holdings declare `month?: never` on their entry.
- **Holdings reuse existing state functions, not new ones.** `applyCarryLoan` delegates to
  `applyLoan` at `-1`; `ownHome` should likewise compose `acquireAsset(-1)` + the mortgage loan,
  reusing the decomposed primitives Task 2 produces. The loan handler records `startMonth =
  event.month` unchanged (`eventHandlers.ts:179`), so a `-1` holding needs no handler special-case.
- **Anchor income clips for free.** A partner at a negative membership `startMonth` still compiles
  income from month 0 — `compilePerson.ts:91` floors `paidStart` at 0, and `interpret.ts:150`
  keeps the membership because a negative month is finite. Don't add clipping logic; it's there.

## Dead ends / deferred
- **The "holding `startMonth` must be exactly -1" precondition** (issue *Preconditions* section)
  is NOT yet added to the loan/property handler `check`s. Cut 1 didn't need it — `carryLoan` fixes
  the month internally so it can't be mis-dated at mint — but the import gate (`validateLedger`)
  won't yet reject a hand-crafted holding at, say, `-5`. Whoever adds the property holding in Cut 2
  is the natural owner; decide there.
- **No new tests broke.** The Cut-1 spec lives in `packages/engine/src/preExisting.test.ts` (both
  the facade methods and the `fromInput` entries). If you touch the loan/relationship/child
  handlers, that file is the regression guard for the pre-existing paths.
