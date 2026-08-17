# Issue #122 — Income-by-source books the whole asset sale as capital-gains income

## Overview

A brokerage withdrawal during decumulation reported its ENTIRE gross draw as capital-gains
income, instead of splitting it into the realized gain (income) and the returned cost basis
(savings drawdown). The withdrawal engine (`buildWithdrawalSources`) already computed the
authoritative split — `principalCents`/`realizedGainCents` on each `DecumulationDrawResult` —
but the reporting layer (`buildFlows`) never read it: the `IncomeSourceMonth` pushed for a
decumulation draw carried no `cashInflowCents` override, so the reporting fallback
(`cashInflowCents ?? waterfallInflowCents`) banded the FULL gross under the account's tax
category. The fix makes the reporting layer consume the existing split rather than re-derive
it, mirroring the pattern already used for explicit event funding (`fundingDrawStep.ts`).

Retirement-account withdrawals are unaffected: those accounts carry no basis, so
`realizedGainCents` already equals the full gross for them, and the split is a no-op.

## RGR Verification Details

**RED** — observed the bug live via `npx tsx repl.ts` before writing anything: a brokerage
account grown to a 50% unrealized-gain fraction, decumulated for $4,000, reported
`flows.cashFlowIncomeByCategoryCents.capitalGains = $4,000` (should be $2,000) with no
`savings-drawdown` band at all. Pinned that observation as two failing tests in
`withdrawal.test.ts` (`describe("Decumulation reporting splits realized gain from returned
principal (#122)")`):
- a mixed gain/principal draw asserting the $2,000/$2,000 split,
- a basis-only draw asserting zero capital-gains income and the full amount as drawdown.

Both failed exactly as predicted against the pre-fix code (`expected 400000 to be 200000` /
`expected 300000 to be +0`).

**GREEN** — two small edits (below) turned both red tests green, and a third pre-existing
test (retirement-account withdrawal reporting, unaffected) passed unmodified throughout,
confirming the fix is category-agnostic rather than special-casing brokerage accounts.

**REFACTOR** — none needed; the diff is already minimal and follows the established
`fundingDrawStep.ts` pattern. One pre-existing test in `estateSettlement.test.ts` derived a
"gross drawn" figure from `cashInflowCents`, which happened to equal the gross only because
of this same bug; it was updated to derive gross from the now-correct ground truth (basis
reduction + the now-accurate `capitalGains` band) instead — the assertion's intent is
unchanged, only how it computes the independent expected value.

## Key Decisions & Why

- **Only touch the reporting boundary, not the withdrawal engine.** `decumulationDraws`
  already carries the authoritative `principalCents`/`realizedGainCents` split (computed once,
  from the jurisdiction's basis-return policy). The issue explicitly forbids re-deriving it in
  `buildFlows()`, so the fix threads the existing figures through instead.
- **`waterfallInflowCents` stays the full gross.** It funds the waterfall's obligation
  coverage this month (no gross-up, the whole draw is spendable cash) — that must not change.
  Only `cashInflowCents` (the reporting-only field `buildFlows` already falls back from) is set
  to `gainCents`, so the capital-gains band shows only the gain while the full amount still
  funds spending.
- **Principal is not banded per-account.** Following the `fundingDraw.principalDrawdownCents`
  precedent, `principalCents` across this month's `decumulationDraws` is summed into one
  `decumulationPrincipalCents` and folded into the same pooled `savings-drawdown` total already
  passed to `buildFlows` (alongside the liquid-buffer drawdown and any explicit-funding
  principal) — one drawdown band, not a new per-account category.
- **No category branching.** Since basis is only ever tracked for taxable brokerage accounts,
  `realizedGainCents` already equals the full draw for every other account type (retirement,
  cash, tax-exempt) — so the same code path correctly leaves those unaffected without checking
  `withdrawalCategory` anywhere.

## Changes Made

- `packages/engine/src/projection/withdrawal.ts` — `buildWithdrawalSources` now sets
  `cashInflowCents: gainCents` on each decumulation `IncomeSourceMonth`, so `buildFlows` bands
  only the realized gain as income for that source.
- `packages/engine/src/projection/simulate.ts` — sums `principalCents` across
  `withdrawal.decumulationDraws` into a new `decumulationPrincipalCents`, folded into the
  savings-drawdown total passed to `buildFlows` alongside the pre-existing liquid-buffer and
  explicit-funding-principal terms.
- `packages/engine/src/projection/withdrawal.test.ts` — new
  `describe("Decumulation reporting splits realized gain from returned principal (#122)")`
  with three tests (mixed split, basis-only, retirement-income unaffected); extended the local
  `account`/`expense` test helpers with optional `annualRate`/`startMonth` params (both default
  to prior behavior) needed to grow an account's balance past its basis before decumulating.
- `packages/engine/src/projection/estateSettlement.test.ts` — updated one test whose
  `grossDrawnCents` figure was (unknowingly) reading the bug; now derives gross from basis
  reduction plus the corrected `capitalGains` band.

## Verification & Testing

- `npx vitest run packages/engine/src/projection/withdrawal.test.ts` — 35 passed (3 new).
- Targeted regression sweep (`reportFlows`, `simulate.*`, `estateSettlement`) — all green.
- `npm run typecheck` — 0 errors.
- `npm run check` (purity + typecheck + full Vitest, engine + rules + app) — green:
  **146 test files, 2023 tests passed | 45 todo**.
