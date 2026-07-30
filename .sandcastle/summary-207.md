# Issue 207 — Validate ledgers on load: strict single-authority import

## Overview

Loading a serialized projection is now **all-or-nothing**: the engine returns a handle over a
*valid* ledger or rejects the input. Previously the import paths installed a pre-built ledger with
no replay check, so a corrupt, tampered, hand-edited, or version-skewed plan silently produced a
broken projection instead of a clean error. This is the groundwork for saving and sharing plans —
loading a plan someone else authored now carries a trustworthy "reject if invalid" guarantee.

Three complementary gates, all on the **import** paths only (`fromState`, `fromScenario`,
`resetLedger`) and never on the authoring path (`addEvent`/`commitEvent`, which validate
per-event as they mint):

1. **Shape + counter flooring** — `withNormalizedCounters` (pre-existing) floors the id and
   sequence counters past whatever the imported data occupies.
2. **Replay validity** — every event must satisfy its precondition against the state its
   predecessors produce. Replay validity, *not* affordability: an insolvent plan still loads.
3. **Format version** — the serialized state declares its version; a non-current version is
   rejected as unsupported before replay is even attempted.

## Work by task

- **Task 1 — Extract `validateLedger`** (`6b10a0e`): pulled the replay-validation fold out of
  `removeEvent` into a shared `validateLedger(ledger, base): ValidateLedgerResult` in
  `packages/engine/src/ledger/validateLedger.ts`. Seeds the base state, then `checkEvent` +
  `applyEvent` each sorted event, bailing on the first conflict. Reused in `removeEvent` /
  `updateEvent` with no behaviour change.
- **Task 2 — Gate the import paths** (`cf7e299`): added `Projection.assertReplayable`, which runs
  `validateLedger` against the plan's base and throws `Projection: cannot load — ${reason}`,
  naming the offending event. Wired into `fromState`, `fromScenario`, and `resetLedger` (asserted
  before commit, so a refused reset mutates nothing).
- **Task 3 — Format version + rejection** (this commit): see below.

## Task 3 — RGR Verification Details

- **RED** (`packages/engine/src/projectionRoot.test.ts`): a new `describe` block asserting the
  serialized state carries `CURRENT_FORMAT_VERSION`, that a non-current version throws
  `UnsupportedVersionError` carrying the file version and `SUPPORTED_VERSION_RANGE`, that an
  unversioned plan is rejected, and that the version gate fires **before** replay (a state that is
  both wrong-version and un-replayable throws the version error, not the replay error). Initially
  failed — the symbols did not exist and no version check ran.
- **GREEN**: added the `version` field, the constants, `UnsupportedVersionError`, and
  `assertSupportedVersion`; stamped the version in `fromScenario`; gated `fromState`. 139/139 in
  the file, 1167 across the suite.

## Key Decisions & Why

- **`version` is a required field of `ProjectionState`.** The format is self-describing: a plan
  file declares the shape that wrote it. Making it required (not optional) puts the single
  authority in the type — every construction path must state a version, and an incoming file that
  omits one is treated as unsupported rather than silently assumed current.
- **Version checked before replay.** Replaying a shape this build cannot read would fail with an
  arbitrary per-event conflict masking the real cause (the wrong version). `assertSupportedVersion`
  runs first in `fromState`; `fromScenario`/`resetLedger` take a fresh scenario/ledger stamped with
  the current version, so only `fromState` (the one path that ingests a foreign `ProjectionState`)
  needs the check.
- **Two rejection buckets.** `UnsupportedVersionError` (version → app UX "update to open this")
  carries `fileVersion` + supported range; shape/replay failures stay a generic
  `Error("Projection: cannot load — …")` ("can't open"). The app distinguishes on the error type.
- **Migration is seam-only.** `SUPPORTED_VERSION_RANGE` is exactly `{ min: 1, max: 1 }` today, so
  the range check reduces to "must equal current". The seam (a range plus a rejection) is in place;
  the transforms get written when v2 first exists.
- **Affordability is never re-checked on load** (falls out for free — `validateLedger` runs only
  `checkEvent`, and `withNormalizedCounters` id-flooring is kept as a complement, not a substitute).

## Changes Made

- `packages/engine/src/projectionRoot.ts`
  - `ProjectionState.version: number` — the self-describing format version.
  - `CURRENT_FORMAT_VERSION = 1`, `SUPPORTED_VERSION_RANGE = { min, max }`.
  - `UnsupportedVersionError` — carries `fileVersion` (`undefined` for a pre-versioning plan) and
    the supported range.
  - `assertSupportedVersion(version)` — rejects anything outside the range, including unversioned.
  - `fromScenario` stamps `version: CURRENT_FORMAT_VERSION`; `fromState` calls
    `assertSupportedVersion` before flooring and replay.
- `packages/engine/src/index.ts` — export `CURRENT_FORMAT_VERSION`, `SUPPORTED_VERSION_RANGE`,
  `UnsupportedVersionError`.
- `packages/engine/src/projectionRoot.test.ts` — new versioning `describe`; two existing
  hand-built `ProjectionState` literals updated with the now-required `version` field.

## Verification & Testing

- `npm run check:purity` — engine purity guard passes (version narrowing is pure in-memory
  computation, no I/O).
- `npm run typecheck` — clean.
- `npm run test` — **1167 tests green** (45 todo), including the new versioning suite.
