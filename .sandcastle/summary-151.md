# Issue #151 — Shared funding helper (ordered drain) + §4.5 gate rework

## Overview

Part of the **#129 epic** (Home Purchase Funding & Goal Decoupling). This slice introduces the single funding primitive that both money-out events (Home Purchase, One-Time Spend) will share, and reworks the §4.5 down-payment gate to validate *through* that primitive.

- **New pure primitive `drainSources`** — drains an amount from an ordered list of accounts, returning `{ drained, shortfall, draws }`. Pure and self-contained: it takes already-resolved balances plus an amount and never reaches for a projection, so both the affordability gate and (in #153/#154) event replay can share one definition of "can these sources fund this?".
- **§4.5 gate reworked** — the HomePurchase down-payment hard block now drains the down payment from its ordered liquid sources via `drainSources` and blocks on a positive `shortfall`, replacing the hand-rolled `reduce`-and-compare. Observable behaviour is preserved (exact coverage passes, any gap fails).

Deliberately **out of scope** (these belong to later slices, keeping this PR's diff to the funding helper + the gate):
- `downPaymentAccountId → downPaymentSourceIds: string[]`, ordered transfers → **#153**.
- One-Time Spend event → **#154**.
- Narrowing the "selected sources" from *all* eligible liquid buckets to the user-selected list → arrives with the multi-source field in **#153**. Until then the gate's selected-source list is every eligible liquid bucket (the pre-existing behaviour), now expressed via the shared helper.

## RGR Verification Details

**RED → GREEN, one vertical slice at a time:**

1. **Helper, full-coverage.** Wrote `drainSources` full-coverage test against a non-existent module → RED (`Failed to load url ./funding`). Implemented `packages/engine/src/ledger/funding.ts` → GREEN (1 test).
2. **Helper, partial-shortfall + ordering.** Added tests for the uncovered remainder, `drained + shortfall` reconciliation, order-preservation (small-listed-first drained first, *not* by size), and zero-balance skipping → all GREEN (6 tests total).
3. **Gate rework.** Added a boundary spec test to the HomePurchase suite ("one cent short still fails the gate") locking shortfall-gating semantics, confirmed the suite green, then refactored `homePurchase.check` to validate via `drainSources` and block on `shortfall > 0`. Full HomePurchase suite (16 tests, including the six §4.5 goal-fund tests from #105) stayed green — a behaviour-preserving refactor.

## Key Decisions & Why

- **`drained` doubles as the stated liquid total in the block message.** When the gate blocks, every source was drained dry and still fell short, so `drained` equals the buckets' combined balance. Reusing `drained` for the `"exceeds the $X of liquid funds"` figure keeps the stated total and the itemised bucket list a single value by construction — the invariant the #105 tests assert ("states a total that equals the sum of the buckets it lists") still holds without a separate sum.
- **Balances floored at zero (`Math.max(0, balanceCents)`).** A stray negative snapshot contributes nothing rather than *inflating* the amount owed. Liquid buckets are already positive-only, so this is defensive, not load-bearing — but it makes the primitive safe for any future caller.
- **`draws` returns per-source amounts (positive only), generic over the source type.** AC only requires `{ drained, shortfall }`, but the ordered-drain's natural, complete result is *how much came from each account* — exactly what #153's "ordered transfers" and #154's Spend outflow need. Emitting per-source draws now (with zero-draws skipped) means the shared primitive is genuinely shareable, not re-derived downstream. `drainSources<S extends { balanceCents }>` preserves each source's identity (e.g. the account id) in the returned draws.
- **Kept the gate's source set as all eligible liquid buckets.** Narrowing to the user-selected ordered list requires the `downPaymentSourceIds` field, which is #153. Doing it here would break the #105 goal-fund gate tests and cross the slice boundary. This slice delivers the *mechanism* (drain + shortfall); #153 supplies the *selection*.

## Changes Made

- **`packages/engine/src/ledger/funding.ts`** *(new)* — `drainSources(sources, amountCents)` plus `DrainResult<S>` / `DrainDraw<S>` types. Walks the ordered sources, taking `min(available, remaining)` from each until the amount is met; returns `{ drained, shortfall, draws }` where `drained + shortfall === max(0, amountCents)`.
- **`packages/engine/src/ledger/funding.test.ts`** *(new)* — 6 tests: full coverage, stop-when-met, partial shortfall, reconciliation, ordering (order-of-list not size), zero-balance skip.
- **`packages/engine/src/ledger/eventHandlers.ts`** — `homePurchase.check` §4.5 gate now imports and calls `drainSources`, blocking on `shortfall > 0` and quoting `drained` as the available-liquid total. Comment updated to describe the shared-primitive path.
- **`packages/engine/src/events.homePurchase.test.ts`** — added the one-cent-short boundary test locking hard-block-on-shortfall.
- **`packages/engine/src/index.ts`** — re-export `./ledger/funding`.

## Verification & Testing

- `npm run check:purity` → **Engine purity check passed** (no I/O, no app/rules imports).
- `npm run typecheck` → clean.
- `npm run test` (full workspace) → **909 passed | 45 todo (954)**, 78 test files.
  - Engine subset: **502 passed | 45 todo**.
  - `funding.test.ts` → 6 passed; `events.homePurchase.test.ts` → 16 passed.

## Notes for the next iteration

- **#153** should: change `HomePurchaseEvent.downPaymentAccountId → downPaymentSourceIds: string[]`; build the *selected* ordered source list (resolving each id's balance at the event month) instead of "all liquid buckets"; feed it to `drainSources`; and use the returned `draws` to emit one ordered account transfer per drawn source in `homePurchase.apply`. The gate wording ("Counted toward the down payment: …") should then list the *selected* sources, not every liquid account.
- **#154** (One-Time Spend) reuses `drainSources` verbatim for its cash-only hard-block and outflow.
- `drainSources` already returns per-source `draws`, so neither slice needs to re-derive who-paid-what.
