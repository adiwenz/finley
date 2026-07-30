# Handoff — issue 207

**Completed so far:** task 1 (Extract `validateLedger` with no behaviour change)

## Live constraints
- `validateLedger(ledger, base)` is the shared replay-validation gate — new file
  `packages/engine/src/ledger/validateLedger.ts`, exported from `index.ts`. It takes a full
  `Ledger` (reads only `.events`) and a `LedgerBaseConfig`, and returns
  `ValidateLedgerResult = { ok: true } | { ok: false; event: LifeEvent; reason: string }`.
  On failure it hands back the offending `event` (not a pre-formatted message) so each caller
  phrases its own error. Tasks 2 (gate imports) and 3 build directly on this — reuse it, don't
  re-fold.
- The result type is named `ValidateLedgerResult`, NOT `ValidationResult`. `ValidationResult`
  already exists in `ledger.ts` with a different shape (`{ ok: false; reason }`, no event) and
  is used by `checkEvent`/`validateLedgerStructure`; the two are distinct on purpose.
- `validateLedger` is replay-validity only — it never re-checks affordability (AC: an insolvent
  plan must still load). This falls out for free because affordability lives on `addEvent`, not
  `checkEvent`; don't add an affordability pass in the import gate.
- Task 2 gates the import paths. Per the issue, wrap the failure in the engine idiom
  `throw new Error("Projection: cannot load — ${conflict}")`. `fromInput` is explicitly NOT
  gated. Confirm current names against #201's rename status before wiring: the issue references
  `fromState`/`fromJSON`, `fromScenario`, and `resetLedger` (`projectionRoot.ts`, the "one
  ledger write with no gate"). #201 may or may not have merged — check the actual symbols.

## Dead ends
- (none yet)

## Deferred
- Format `version` field + `UnsupportedVersionError` — task 3. Migration is seam-only: reject
  non-current, don't transform.
