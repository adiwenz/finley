# Handoff — issue 179

**Done so far:**
- **Cut 1 (task 1/4) — DONE.** Anchors + reused-event holdings: `startPartnered`,
  `haveExistingChild`, `carryLoan` + their `ScenarioInput` entries; pre-now `separate`.
- **Decomposition (task 2/4) — DONE.** `HomePurchaseEvent` split into the slimmed property event +
  reused `LoanEvent`, composed by `buyHome`.
- **Cut 2 (task 3/4) — DONE.** `ownHome` holding, `HomePurchaseEvent` holding mode, behavior-free
  basis metadata, and the holding-month precondition. See this run's commit + `git diff`.
- **Remaining: Glossary (task 4/4)** — CONTEXT.md, and it is the LAST task (writes the summary,
  deletes this file). See below.

## Task 4 — the only work left

- **Add two glossary entries to `CONTEXT.md`** (the domain-modeling deliverable), matching the
  code's vocabulary so the words and the engine agree:
  - **Holding** — a pre-existing stock (loan / property / mortgage) opened at the now marker
    (`PRE_NOW_MONTH = -1`) with CURRENT terms and NO account side-effects (no funding draw, no
    §4.5 gate). Authored by `carryLoan` / `ownHome`; the loan/property handlers now enforce that a
    holding's only valid pre-now month is exactly `-1` (`holdingMonthFault` in
    `packages/engine/src/ledger/eventHandlers.ts`).
  - **Anchor** — a pre-existing life event (marriage / birth / separation) placed at its TRUE past
    month, whose elapsed position drives remaining durations. Authored by `startPartnered` /
    `haveExistingChild` / pre-now `separate`. Exempt from the `-1` rule: carrying no balance, a
    true past month reconstructs nothing.
- **Then, as the last task:** write `.sandcastle/summary-179.md` (whole issue, read `git log`) and
  **delete this handoff** in the same commit — that finishing commit deletes the handoff rather
  than rewriting it.

## Live constraints
- **`HomePurchaseEvent` is the property primitive; holding-vs-transaction is decided by
  `isPreExisting(event.month)`.** At `-1` the handler skips the down-payment source requirement,
  the §4.5 gate, and the funding draw; at `month ≥ 0` it funds and gates. A holding is authored
  with `downPaymentCents: 0` and `downPaymentSourceIds: []` (see `applyOwnHome` in
  `packages/engine/src/authoring/housing.ts`). `purchasePriceCents` is the property's opening
  value — CURRENT value for a holding.
- **`acquiredMonth` + `originalPriceCents` on `HomePurchaseEvent` are behavior-free.** They are a
  future sell-home's capital-gains basis + display only; no current-balance logic reads them
  (gains-on-sale is a separate issue). Do NOT wire them into any balance/appreciation path.
- **`ownHome` composes two primitives at `-1`, loan first** (mortgage `LoanEvent` then property),
  reusing the `${propertyId}-mortgage` id scheme from `buyHome`. Owned-outright omits the loan and
  the `securedByLiabilityId` link. The property→mortgage link is referential, not a causedBy edge
  (removing the home leaves the mortgage standing) — unchanged from task 2.
- **The month convention lives one place per surface.** Each doorway computes its internal month
  and never exposes it; `ownHome` → `PRE_NOW_MONTH`. `entryMonth(entry)` in `scenarioInput.ts` has
  an `ownHome` case (returns `PRE_NOW_MONTH`) — a new `month`-computing entry MUST get one there or
  the ref graph sorts it as `month: undefined`.
- **Holdings need no runState special-case for opening values** — `isPreExisting` already opens a
  `-1` property at value / liability at balance (`runState.ts`).

## Deferred / not done (by design for this issue)
- **No app authoring surface for `ownHome`.** Consistent with Cut 1 (no app form either): the
  engine methods + `ScenarioInput` entries are the entry points. The "I only know what I originally
  paid" prefill lives in the app and is out of scope here. Task 4 need not add one.
- **No `ownHome` revision path.** `buyHome` revises its mortgage via the `takeLoan` verb on the
  `${propertyId}-mortgage` id (`authoring/revise.ts`); `ownHome` was not given a revise mapping —
  not required by Cut 2's acceptance criteria. Leave unless a later issue asks for it.

## Traps
- **The holding-month precondition (`holdingMonthFault`) is on BOTH the loan and property
  handlers.** It rejects any negative month that is not exactly `-1`. Anchors (RelationshipEvent /
  ChildEvent / SeparationEvent) are deliberately NOT gated — do not add the same check there.
- **Regression guards bind these paths.** Cut 2 → `packages/engine/src/preExisting.test.ts`
  (`ownHome` facade + declarative) and `events.homePurchase.test.ts` (handler holding mode +
  precondition + import rejection). Touch the home/loan handlers or `ownHome` → these bind.
