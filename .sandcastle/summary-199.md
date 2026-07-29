# Issue 199 — Unify the ledger and account household aggregates

## Overview

Before this change the engine carried **two** distinct "household" shapes:

- `Household` — the ledger aggregate (`packages/engine/src/ledger/household.ts`), the immutable
  array-shaped model interpretation produces and both projection and snapshot read. It rosters
  people via `memberships`, but carried no accounts.
- `AccountHousehold` — the account-ownership aggregate (`packages/engine/src/account.ts`),
  `{ persons, accounts }`, consumed only by the ownership helpers (`personalAccounts`,
  `jointAccounts`, `accountsOf`, `householdNetWorthCents`) and their test.

Both held the roster (`AccountHousehold.persons` duplicated `Household.memberships[].person`),
which is exactly the redundancy #72's Person-basis groundwork set up to remove. This issue folds
them into **one** authoring household: `Household` gains an `accounts` field, `AccountHousehold`
is deleted, and the ownership helpers now operate on the single `Household`. The roster lives in
one place (`memberships`), so it can never drift from a second person list.

Landing this before the `Projection` facade begins surfacing `Household` to the app means the
facade exposes the already-unified shape once, not a shape that immediately changes.

## RGR Verification Details

- **RED:** Added `householdWith(...)` factory and an "accounts on the unified household
  aggregate" test to `account.test.ts`, and retyped the shared fixture as `Household`. Because
  `Household` had no `accounts` field and the helpers still took `AccountHousehold`, `npm run
  typecheck` failed with `TS2353` (`'accounts' does not exist in type 'Household'`) and a cascade
  of `TS2345` (`'Household' is not assignable to 'AccountHousehold'`). Note: vitest transpiles
  without type-checking, so the RED signal is `tsc`, not the runtime run.
- **GREEN:** Added `readonly accounts: readonly Account[]` to `Household`, populated it in
  `toHousehold`, retargeted the four ownership helpers from `AccountHousehold` to `Household`,
  deleted the `AccountHousehold` interface, and dropped it from the barrel. `tsc` clean; the new
  test and the full suite pass.
- **REFACTOR:** Tightened the `Household.accounts` doc comment; re-ran the full check.

## Key Decisions & Why

- **`Household` is the survivor; `AccountHousehold` is deleted.** `Household` is the wired,
  rich, derived aggregate that projection and snapshot already consume; `AccountHousehold` was
  thin scaffolding used only by its own helpers and test. Folding *into* `Household` keeps the
  single household consistent with `account.ts`'s standing invariant ("there is ONE canonical
  `household.accounts` list").
- **The roster is `memberships`, not a parallel `persons` list.** The ownership helpers take a
  `PersonRef` argument and never read a household-level person list, so `AccountHousehold.persons`
  was pure duplication and is simply dropped.
- **Ownership helpers stay in `account.ts`, typed against `Household` via a type-only import.**
  `account.ts` is the account module and already owns the household-net-worth concern. The
  resulting `account.ts` ↔ `ledger/household.ts` reference is **type-only on both sides**
  (`Household` needs `Account`; the helpers need `Household`), so it is fully erased at compile
  time — there is no runtime import between the two files and thus no runtime cycle.
- **`toHousehold` populates `accounts: []`.** No authoring-`Account` source flows through the
  ledger today — accounts still enter the simulation as compiled `SimAccount`s on the base
  (`buildPlanAccounts` → `base.initialAccounts`), and `SimAccount` carries a single `ownerId`,
  not the authoring `owners[]`. Deriving `Account` from `SimAccount` would invert the
  authoring→compiled direction, so it is deliberately not done here. The field unifies the
  aggregate now; wiring an authoring-account source through interpretation is future work. This
  is documented at the field and at the assignment so the empty value doesn't read as an
  oversight.

## Changes Made

- `packages/engine/src/ledger/household.ts` — `Household` gains `readonly accounts: readonly
  Account[]`; added a type-only `Account` import.
- `packages/engine/src/account.ts` — deleted the `AccountHousehold` interface; `personalAccounts`,
  `jointAccounts`, `accountsOf`, and `householdNetWorthCents` now accept `Household` (type-only
  import).
- `packages/engine/src/ledger/interpret.ts` — `toHousehold` emits `accounts: []` with a comment
  explaining why no source flows yet.
- `packages/engine/src/index.ts` — barrel no longer exports the removed `AccountHousehold` type.
- `packages/engine/src/account.test.ts` — added a `householdWith(...)` factory; the shared
  fixture and a new unified-aggregate test build a `Household`; existing ownership assertions
  (partition, no double-count) are unchanged and still green.

## Verification & Testing

- `npm run check:purity` — ✓ passed (no I/O, no app/rules imports).
- `npm run typecheck` — ✓ clean.
- `npm run test` — **1073 passed | 45 todo (1118)** across 85 test files.
