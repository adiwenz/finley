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
- **`toHousehold` populates the household's real accounts.** An earlier revision of this
  branch emitted `accounts: []`, which made `Household` authoritative-looking but disconnected:
  `householdNetWorthCents` answered 0 and the ownership helpers answered `[]` for every
  interpreted household. Fixed by making the *account itself* carry both aspects
  ({@link PlanAccount}): `buildPlanAccounts` builds one spec per account and yields the
  authoring `Account` alongside its compiled `SimAccount`. The base carries that single
  collection, the household rosters the authoring side, and `buildHouseholdSimInput` runs the
  compiled side — so the two can never describe different holdings.
- **Direction stays authoring → compiled.** `Account` is not recovered from `SimAccount`:
  `SimAccount.ownerId` is single-valued, so joint ownership is unrepresentable in the compiled
  shape and any such derivation would have to be deleted the moment joint accounts land.
- **Accounts remain plan-derived defaults, not new user input.** `buildPlanAccounts` already
  synthesized savings / retirement / brokerage plus one fund per goal from the `Plan`; it now
  emits `PlanAccount`s instead of bare `SimAccount`s. Nobody authors an account by hand, and
  `owners: [PRIMARY_PERSON_ID]` is the true owner rather than a placeholder. Joint ownership is
  a later issue; until then `jointAccounts()` correctly returns `[]`.
- **The ownership invariant is enforced at the canonicalization boundary.** `toHousehold`
  rejects a base whose account names an owner absent from `memberships`, so a mis-built base
  fails loudly instead of silently understating `personalAccounts`.

## Changes Made

- `packages/engine/src/ledger/household.ts` — `Household` gains `readonly accounts: readonly
  Account[]`; added a type-only `Account` import.
- `packages/engine/src/account.ts` — deleted the `AccountHousehold` interface; `personalAccounts`,
  `jointAccounts`, `accountsOf`, and `householdNetWorthCents` now accept `Household` (type-only
  import).
- `packages/engine/src/planAccount.ts` — **new.** `PlanAccount` plus the `planAccount()`
  factory: the single construction site pairing an authoring `Account` with its compiled
  `SimAccount`, plus `authoringAccounts()` / `simAccounts()` view helpers.
- `packages/engine/src/ledger/ledgerBase.ts` — `initialAccounts` is now `readonly PlanAccount[]`.
- `packages/engine/src/projectionBase.ts` — `buildPlanAccounts` returns `PlanAccount[]`;
  `retirement` reads off the tax profile's `forcedDistributionEligible` rather than being
  stated twice.
- `packages/engine/src/ledger/interpret.ts` — `toHousehold` populates `accounts` from the
  base and asserts every owner is rostered (`assertAccountOwnersRostered`).
- `packages/engine/src/projection/buildHouseholdInput.ts`, `ledger/addEvent.ts` — read the
  compiled `.sim` side.
- `packages/engine/src/index.ts` — barrel no longer exports the removed `AccountHousehold` type.
- `packages/engine/src/account.test.ts` — added a `householdWith(...)` factory; the shared
  fixture and a new unified-aggregate test build a `Household`; existing ownership assertions
  (partition, no double-count) are unchanged and still green.

## Verification & Testing

- `npm run check:purity` — ✓ passed (no I/O, no app/rules imports).
- `npm run typecheck` — ✓ clean.
- `npm run test` — **1079 passed | 45 todo (1124)** across 86 test files.
- New regressions in `packages/engine/src/ledger/interpret.accounts.test.ts`: an interpreted
  household rosters its initial accounts; the simulator receives the same collection (id,
  order and balance parity); net worth counts those balances; `accountsOf` /
  `personalAccounts` / `jointAccounts` answer correctly and answer nothing for a non-member;
  and an off-roster owner is refused.
