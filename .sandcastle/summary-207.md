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
  `UnsupportedVersionError` carrying the file version and the supported version, that an
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
  carries `fileVersion` + the version this build reads; shape/replay failures stay a generic
  `Error("Projection: cannot load — …")` ("can't open"). The app distinguishes on the error type.
- **The version gate is exact equality, not a range.** A range would promise something this build
  cannot deliver: reading a v1 file under v2 rules means *transforming* it, and no transforms
  exist. So `assertSupportedVersion` compares against `CURRENT_FORMAT_VERSION` and rejects an
  older version exactly as firmly as a newer one. When real migrations land, an older version
  stops throwing because it gets migrated up — not because an accepted range quietly widened.
- **A load error always names the offending event.** `Projection: cannot load — event "<id>"
  (<type>) fails — <reason>`, the same detail `removeEvent`/`updateEvent` give. The id and type are
  stamped in by the caller rather than borrowed from the `reason`, because a reason is free to
  explain a failure without naming the event — the unknown-type rejection does exactly that.
- **An unknown event discriminant is a rejection, not a crash.** `validateLedger` asks
  `isKnownEventType` before dispatching: an imported plan is untrusted data wearing a `LifeEvent`
  type, and a hand-edited or version-skewed one can name an event no handler answers to. The
  registry lookup would return `undefined` and throw a raw `TypeError` naming neither the event
  nor the plan.
- **Affordability is never re-checked on load** (falls out for free — `validateLedger` runs only
  `checkEvent`, and `withNormalizedCounters` id-flooring is kept as a complement, not a substitute).

## Changes Made

- `packages/engine/src/projectionRoot.ts`
  - `ProjectionState.version: number` — the self-describing format version.
  - `CURRENT_FORMAT_VERSION = 1` — the version written, and the sole one read.
  - `UnsupportedVersionError` — carries `fileVersion` (`undefined` for a pre-versioning plan) and
    the supported version.
  - `assertSupportedVersion(version)` — exact-equality gate; rejects older, newer, and unversioned.
  - `fromScenario` stamps `version: CURRENT_FORMAT_VERSION`; `fromState` calls
    `assertSupportedVersion` before flooring and replay.
  - `assertReplayable` names the offender: `event "<id>" (<type>) fails — <reason>`.
- `packages/engine/src/ledger/eventHandlers.ts` — `isKnownEventType(type)`, an own-property check
  against the handler registry, so a prototype name (`"toString"`) is not mistaken for an event
  type.
- `packages/engine/src/ledger/validateLedger.ts` — gates the discriminant before `checkEvent` /
  `applyEvent`, returning the offending event with reason `"unknown event type"`.
- `packages/engine/src/index.ts` — export `CURRENT_FORMAT_VERSION`, `UnsupportedVersionError`.
- `packages/engine/src/projectionRoot.test.ts` — new versioning `describe`; two existing
  hand-built `ProjectionState` literals updated with the now-required `version` field.

## Verification & Testing

- `npm run check:purity` — engine purity guard passes (version narrowing is pure in-memory
  computation, no I/O).
- `npm run typecheck` — clean.
- `npm run test` — **1173 tests green** (45 todo), including the new versioning, load-gate, and
  unknown-discriminant suites.
