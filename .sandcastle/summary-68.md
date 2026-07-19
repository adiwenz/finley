# Slice 5 — Per-person account ownership (`owners: PersonId[]`) + household net worth (issue #68)

## Overview

Adds the engine-core standing model for **per-person account ownership** and the
**household net-worth aggregate** that #30 (multi-person app panel) and #38
(IRA/Roth/HSA account types) build on. An account is now owned by a *set* of
persons — `owners = [p]` is an individual account, `owners = [p1, p2]` a joint
one — held in a single canonical `household.accounts` list. Net worth sums that
list exactly once, so a joint account is never double-counted, and pure selectors
partition each person's holdings into personal vs joint.

This lands **additively** alongside the standing `Person`/`Job` model from Slice 1
(#74) and is deliberately distinct from the low-level simulator `Account` class
(the compiled shape with a single `ownerId`, rate segments, and transfers) — the
same authoring-vs-sim seam that separates standing `Person` from `SimPerson`.

## RGR Verification Details

- **RED:** Added `packages/engine/src/standingAccount.test.ts` (6 cases) covering
  the retirement single-owner refusal, the ownerless refusal, the
  personal/joint/all partition on both owners of a joint account, and the
  "net worth sums once" guard (per-person sum inflates a joint balance to 1300_00
  cents; the canonical household sum stays at 900_00). The suite failed to load —
  `Failed to load url ./standingAccount … Does the file exist?` — because the
  implementation module did not exist yet.
- **GREEN:** Implemented `packages/engine/src/standingAccount.ts` and exported it
  from the barrel. The 6 tests pass.
- **REFACTOR:** Removed an unused `type StandingAccount` test import flagged by
  `tsc`; re-ran the full workspace to confirm zero regressions.

## Key Decisions & Why

- **Standing account, not the sim `Account`.** The existing `Account` class is a
  *compiled* simulator shape (`ownerId: string`, rate segments, one-time
  transfers). Renaming or overloading it would ripple through `goal.ts`,
  `projectionBase.ts`, and the whole sim core — out of scope for an additive
  slice. The authoring account gets its own honest type, `StandingAccount`,
  mirroring the `Person` (authoring) vs `SimPerson` (sim) split from Slice 1.
- **Ownership is a set (`owners: PersonId[]`).** `[p]` vs `[p1, p2]` is the single
  source distinguishing individual from joint — no separate `joint` flag to drift
  out of sync. `isJoint` / `isIndividual` read it directly.
- **Invariant refused at authoring.** `assertAccountOwnership` (called by
  `makeStandingAccount`) throws when an account has no owners, or when a
  `retirement` account has more than one — deferral limits and RMDs are legally
  per-person, so a joint retirement account is meaningless. This mirrors the
  `careerJobOf` "refused where authored" pattern rather than defending against the
  bad shape everywhere downstream.
- **Net worth = household aggregate, summed once.** `householdNetWorthCents`
  reduces the canonical `household.accounts` list a single time. Because a joint
  account lives in that list exactly once, the aggregate never double-counts it —
  in contrast to summing each person's `accountsOf`, which *would* (the test pins
  both numbers to make the distinction explicit).
- **Selectors accept a `Person` or a bare `PersonId`.** `personalAccounts` /
  `jointAccounts` / `accountsOf` take a `PersonRef`, so callers can pass either
  `person` or `person.id` — honoring the `person.personalAccounts` phrasing in the
  design doc while staying pure free functions (the standing `Person` is an
  interface, not a class).

## Changes Made

- **`packages/engine/src/standingAccount.ts` (new):**
  - `StandingAccount` — `{ id, owners: PersonId[], balanceCents, retirement }`.
  - `StandingHousehold` — `{ persons: Person[], accounts: StandingAccount[] }`,
    the single canonical account list.
  - `assertAccountOwnership` / `makeStandingAccount` — enforce ≥1 owner and
    retirement ⇒ exactly one owner.
  - `isJoint` / `isIndividual` — ownership predicates.
  - `personalAccounts` / `jointAccounts` / `accountsOf` — per-person partition
    selectors (personal ∪ joint = accounts, personal ∩ joint = ∅).
  - `householdNetWorthCents` — the household aggregate, summed once.
- **`packages/engine/src/standingAccount.test.ts` (new):** 6-case RGR spec.
- **`packages/engine/src/index.ts`:** barrel exports for the new types and
  functions, with a comment marking the seam against the sim `Account`.

## Acceptance Criteria

- [x] `Account.owners: PersonId[]` replaces single-owner assumptions; `[p]` vs
  `[p1,p2]` distinguishes individual vs joint — `StandingAccount.owners`.
- [x] Retirement accounts enforce `owners.length === 1` — `assertAccountOwnership`
  throws otherwise.
- [x] Household net worth sums `household.accounts` exactly once —
  `householdNetWorthCents`; test pins joint-not-double-counted.
- [x] `personalAccounts` / `jointAccounts` / `accounts` selectors return correct
  partitions.
- [x] Employer-plan accounts are job-attached (`Job.deferral.fundAccountId` +
  `employerMatchFraction`, from Slice 1 §11); personal retirement accounts are
  person-owned (`StandingAccount` with `owners = [p]`, `retirement: true`).

## Verification & Testing

- `npm run check:purity` — ✓ no I/O, no app/rules imports in engine source.
- `npm run typecheck` — ✓ clean.
- `npm run test` — **419 passed | 45 todo (464)** across 38 test files, including
  the new 6-case `standingAccount.test.ts`. Zero regressions.

## Notes for the Next Iteration

- The standing account carries an authored `balanceCents`; wiring these accounts
  into the projection/compilation pipeline (so the sim reads the standing list
  instead of `projectionBase`'s hardcoded `p1` accounts) is deferred — this slice
  is the ownership + aggregate *model* the later slices lower.
- #38 layers account-type channels (traditional/Roth IRA/HSA) + rules-seam limits
  on top of this `owners` + `retirement` shape.
- #30 is the app surface of this model, re-scoped onto `owners: PersonId[]`.
