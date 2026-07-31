# Handoff — issue 179

**Done so far:**
- **Cut 1 (task 1/4) — DONE.** Anchors + reused-event holdings: `startPartnered`,
  `haveExistingChild`, `carryLoan` + their `ScenarioInput` entries. Pre-now separation via the
  existing `separate` method.
- **Decomposition (task 2/4) — DONE.** Split `HomePurchaseEvent` into two composed primitives.
  The shape it left is under *Live constraints* below.
- Remaining: **Cut 2** (`ownHome` holding), **Glossary** (CONTEXT.md: *Holding* / *Anchor*).
  See the issue body for each.

## Live constraints (consumed by later tasks)

### From the decomposition (task 2) — what Cut 2 builds on
- **`HomePurchaseEvent` is now the `acquireAsset` primitive.** The type name is kept (the issue
  sanctions "the slimmed `HomePurchaseEvent`"), but it no longer mints a mortgage. It carries an
  optional `securedByLiabilityId` (the mortgage link) and drains the down payment. The financing
  mortgage is an independent `LoanEvent`. `buyHome` composes them, **loan first** — see
  `packages/engine/src/authoring/housing.ts` `applyHomePurchase`.
- **`ownHome` (Cut 2) composes the same two primitives at `-1`.** Emit the mortgage `LoanEvent`
  first (reuse `applyCarryLoan`/`applyLoan` at `PRE_NOW_MONTH`), then a `HomePurchaseEvent` at
  `-1` naming it via `securedByLiabilityId`. Owned-outright omits the loan and the link.
- **Holding mode is NOT built yet.** `HomePurchaseEvent.check`/`apply` still ALWAYS drain the
  down payment and (on the authoring path) run the §4.5 gate. For a holding, Cut 2 must make the
  draw / gate conditional (no draw, no gate at `-1`). The down-payment source fields are still
  required by `eventValidation.ts` — relax them for the holding. `purchasePriceCents` is the
  property's opening value; for a holding it is the current value.
- **The securing precondition is directional and referential, not a causedBy edge.**
  `HomePurchaseEvent.check` requires `securedByLiabilityId`, when present, to already exist in
  `state.liabilitiesById` (`packages/engine/src/ledger/eventHandlers.ts`). This buys ordering
  (loan sorts first) AND removal-safety (removing the loan while the house names it is blocked).
  There is **no** causedBy link between property and mortgage: removing the home leaves the
  mortgage standing. Do NOT add one in Cut 2.
- **The mortgage id is `${propertyId}-mortgage`** — used as both the `LoanEvent` id and its
  `liabilityId`. Not counter-minted (parent-suffixed, like `${partnerId}-job-N`); `mint.ts`'s
  regex ignores it for the floor. Keep this scheme in `ownHome`.
- **`buyHome` revision no longer carries mortgage terms.** The mortgage is revised through the
  `takeLoan` verb on the `${propertyId}-mortgage` id (`authoring/revise.ts`).

### From Cut 1 — still live
- **The month convention lives in one place per surface.** Each pre-existing doorway computes its
  internal month and never exposes it (`startPartnered` → `-partneredForMonths`,
  `haveExistingChild` → `-ageMonths`, `carryLoan` → `PRE_NOW_MONTH`). `ownHome` follows suit:
  the `-1` convention stays inside the engine; the method takes current terms.
- **`entryMonth(entry)` in `scenarioInput.ts` is load-bearing.** `scenarioRefs.ts` sorts the
  schedule by it. A new entry computing its month internally (`ownHome`) MUST get a case there or
  it sorts as `month: undefined` and the ref graph breaks. Holdings declare `month?: never`.
  (Note: a `buyHome`/`ownHome` entry now expands to TWO events at authoring time via the facade
  method; the ref graph still resolves at the ENTRY level — the loan↔property link is a minted id
  invisible to `scenarioRefs`, so no ref-graph change was needed.)
- **`isPreExisting(startMonth)` already opens a `-1` property at value / liability at balance**
  (`runState.ts`). A `-1` holding needs no handler special-case for opening values.
- **Anchor income clips for free.** A partner at a negative membership `startMonth` still compiles
  income from month 0 (`compilePerson.ts` floors `paidStart` at 0; `interpret.ts` keeps a finite
  negative-month membership). Don't add clipping logic.

## Dead ends / deferred
- **The "holding `startMonth` must be exactly -1" precondition** (issue *Preconditions*) is still
  NOT added to the loan/property handler `check`s. Neither Cut 1 nor the decomposition needed it
  (methods fix months internally). Cut 2 adds a property holding — it is the natural owner. Decide
  there whether `validateLedger` should reject a hand-crafted holding at, e.g. `-5`.
- **Regression guards for the affected paths:** Cut 1 → `packages/engine/src/preExisting.test.ts`.
  Decomposition → `events.homePurchase.test.ts` (handler seam; `addFinanced`/`mortgage` fixtures +
  referential-precondition + removal tests) and `projectionFacade.test.ts` (composition +
  revision). Touch the home/loan handlers → these bind.
