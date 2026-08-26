# Issue #316 — Inherit at death: re-owner a deceased member's accounts to the surviving partner

## Overview

When a household member died while a partner survived, their accounts stayed in the household
but were never spent: `runDecumulation`'s person-aware pass covered the survivor's deficit from
the survivor's *own* accounts and never fell through to the pooled pass, so the deceased's money
sat untouched until the terminal estate sweep. This left the survivor showing a running deficit
and a depleted account balance beside an untouched fortune that belonged, in the model's own
terms, to the household they were still part of.

The fix re-owners a deceased member's cash and taxable-brokerage accounts to the surviving
partner, in place, at the death month — before anything that month reads account ownership. The
survivor's existing person-aware funding pass and RMD gate then draw the inherited accounts
naturally, with no change to either. Retirement accounts are deliberately left untouched;
inherited-retirement distribution rules and beneficiary taxation are out of scope (#304).

## RGR Verification Details

Work landed as a single coherent change (derivation → wiring → application), verified end-to-end:

- **RED → GREEN**: `deathOwnershipTransfer.test.ts` is new and covers the transfer function in
  isolation (exact-month gating, retirement exclusion, targeted-owner-only mutation), the wired
  household simulator (pre-death untouched, post-death drawn for the survivor's deficit, own
  account drained before the inherited one, no-survivor households untouched), a real
  marriage/death fixture reproducing the reported shape via `netWorthByPersonCents`, a
  separation control case (still drains to zero, nothing transfers), and an estate-settlement
  parity check (identical totals with and without a mid-run transfer).
- `snapshot.test.ts` and `snapshotDeath.test.ts` were updated in lockstep: the dated snapshot now
  attributes a transferred account to the survivor rather than flagging it `inEstate`, and an
  emptied inherited account is kept (it is a real, if empty, account of the survivor's) rather
  than dropped as an ownerless estate row.
- `projectionFacade.reads.test.ts`'s existing "death is not a departure" test was updated: the
  account is no longer `inEstate` once a survivor is present to inherit it.
- `personActiveWindow.test.ts` covers `survivingPartnerTransfers` directly: normal transfer,
  simultaneous last-death (no survivor), household of one, separation-before-death (excluded),
  and separation-dated-after-death (still transfers, symmetric with `personActiveWindow`'s own
  handling of that ordering).
- Full suite run clean: `npm run typecheck`, `npm run check:purity`, and `npm run test`
  (176 test files, 2931 tests, 45 todo) all green.

## Key Decisions & Why

- **Derived, not authored.** `survivingPartnerTransfers` computes transfers off the same
  membership list every other death-boundary calculation already reads (`personActiveWindow`,
  `lifeExpectancyEndMonthExclusive`) — consistent with how this codebase treats death generally:
  "read from the partner's own expectancy rather than recorded anywhere" (see
  `ledger/partnership.ts`). This is what the issue's "via a ledger event rather than a silent
  re-owner at the sim boundary" asks for in this codebase's idiom: a dated, deterministic event
  applied mid-run and visible on the timeline, not a hack confined to the terminal estate sweep.
- **In-place mutation, ahead of the month's other reads.** `SimAccount.ownerId` becomes mutable
  (via a new `reassignOwner` method) and `runMonth` calls `applyDeathOwnershipTransfers` before
  anything else that month runs. The RMD gate and decumulation waterfall both key off `ownerId`
  directly, so mutating it first is the entire fix — neither needs to know death happened.
- **`initSimState` now clones accounts** (`withAdditionalTransfers([])`) before building state.
  Without this, a longer-lived caller holding the original `SimAccount` instances across more
  than one query (e.g. `fundingLookup`, which builds an `ownerId` map and then runs a full
  projection) would see the in-place mutation leak backwards into checks it never asked about.
- **Scoped to cash/brokerage only.** `applyDeathOwnershipTransfers` skips any account with
  `taxProfile.forcedDistributionEligible` — retirement accounts hand off to #304 rather than
  re-implementing inherited-distribution rules here, per the issue's explicit scope note.
- **Snapshot reads the same derivation.** `buildSnapshot` computes `effectiveOwners` from the
  same `survivingPartnerTransfers` call, so the dated snapshot and the running projection can
  never disagree about whose money an account is after a death.

## Changes Made

- `packages/engine/src/job/personActiveWindow.ts` — new `SurvivingPartnerTransfer` type and
  `survivingPartnerTransfers()`, deriving each transfer (deceased, survivor, month) from
  memberships, excluding members who separated before their own death and deaths with no living
  co-member that month.
- `packages/engine/src/projection/deathOwnershipTransfer.ts` (new) — `applyDeathOwnershipTransfers`,
  reassigning matching cash/brokerage accounts' ownership at the exact transfer month.
- `packages/engine/src/plan/simAccount.ts` — `ownerId` is now mutable; new `reassignOwner` method.
- `packages/engine/src/projection/runState.ts` — `initSimState` clones incoming accounts so the
  in-place reassignment cannot leak into a caller's shared `SimAccount` instances.
- `packages/engine/src/projection/simulate.ts` — `runMonth` applies death ownership transfers
  before any other per-month read of account ownership.
- `packages/engine/src/projection/simulate.types.ts` — `HouseholdSimInput.deathOwnershipTransfers`.
- `packages/engine/src/projection/buildHouseholdInput.ts` — derives `deathOwnershipTransfers` from
  `household.memberships` when building the engine's sim input.
- `packages/engine/src/projection/snapshot.ts` — `buildSnapshot` attributes a transferred
  account's balance to the survivor instead of flagging it `inEstate`.
- Tests: `deathOwnershipTransfer.test.ts` (new), `personActiveWindow.test.ts`, `snapshot.test.ts`,
  `snapshotDeath.test.ts`, `projectionFacade.reads.test.ts`.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — clean (no I/O/app imports in engine source).
- `npm run test` — **176 test files passed, 2931 tests passed** (45 todo, pre-existing and
  unrelated), 0 failures.
