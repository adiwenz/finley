# Handoff — issue 207

**Completed so far:** tasks 1-2 (Extract `validateLedger`; Gate the import paths)

## Live constraints
- `validateLedger(ledger, base)` (`packages/engine/src/ledger/validateLedger.ts`, exported from
  `index.ts`) is the shared replay-validation gate: returns
  `ValidateLedgerResult = { ok: true } | { ok: false; event: LifeEvent; reason: string }`. Its
  `reason` already embeds the offending event's type + id (from `checkEvent`, format
  `${type} "${id}": ${requirement}`), so callers phrase a message around `reason` alone.
- Import gate lives in `Projection.assertReplayable(ledger)` (`projectionRoot.ts`, next to
  `baseConfig`). It validates against `this.baseConfig()` and throws
  `Projection: cannot load — ${result.reason}`. Wired into all three import paths:
  `fromState`, `fromScenario` (construct then assert on `projection.ledger`), and `resetLedger`
  (assert BEFORE commit — a refused reset mutates nothing). `create` → `fromScenario` over an
  empty ledger passes trivially; `transact` → `fromState` re-validates committed (already-valid)
  state, harmless.
- Replay-validity only — never affordability (an insolvent plan still loads). Falls out for
  free: affordability lives on `addEvent`, `validateLedger` only runs `checkEvent`. Do not add
  an affordability pass. `withNormalizedCounters` (id/seq flooring) is kept — complementary to
  validation, not a substitute.
- `fromInput`/`fromJSON` do NOT exist yet (#194/#201 unmerged); current names are `fromState`,
  `fromScenario`, `resetLedger`. `fromInput`, when it lands, must NOT take this gate.

## Dead ends
- (none)

## Traps
- `packages/app/src/components/goalsPanel/goalsDelete.test.tsx` — its `homePurchase` helper now
  namespaces `propertyId`/`mortgageLiabilityId` by event id (`house-${id}`/`mtg-${id}`). It
  previously hardcoded `house1`/`mtg1`, so a two-purchase fixture was un-replayable and only
  loaded because there was no gate. Keep fixtures replay-valid — any app test that builds a
  ledger and loads it through the harness (`readerOf`/`runOf` → `fromScenario`) now hits the gate.

## Deferred
- Task 3: add a `version` field to the serialized format and reject a non-current version with
  `UnsupportedVersionError` (carrying file version + supported range), distinct from the generic
  invalid-plan `Error` this task throws. Migration is seam-only — reject non-current, don't
  transform. The version check is separate from `assertReplayable`; decide the ordering (a
  version mismatch should likely be reported before replay, since replaying a foreign shape is
  meaningless).
