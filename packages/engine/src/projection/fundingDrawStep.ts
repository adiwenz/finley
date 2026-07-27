/**
 * Funding draws — the simulation-time resolution of an ordered, cross-account
 * money-out draw (a Home Purchase down payment today; the One-Time Spend event
 * next, #154).
 *
 * The ledger records the INTENT — drain `amountCents` from these sources, in this
 * order — because the per-source split is balance-dependent and the balances only
 * exist once the projection runs (replay carries none). This step is where the split
 * is finally taken: for each draw scheduled at `month` it walks the sources in order,
 * taking as much as each holds before the next (mirroring {@link
 * import("../ledger/funding").drainSources}), reducing the account balance and
 * returning its basis pro-rata — the SAME basis accounting a decumulation draw
 * ({@link import("./withdrawal").buildWithdrawalSources}) and a fixed asset transfer
 * ({@link import("./assetSteps").applyAssetTransfers}) use.
 *
 * It also surfaces the draw in the diagnostic flow view, the wiring the #153/#154
 * design flags as "not free": an investment source's realized GAIN reports as
 * capital-gains income, and its returned PRINCIPAL (plus any cash/liquid source,
 * whose whole draw is principal) reports as a savings drawdown — the same reporting-
 * only, non-taxable treatment the liquid-buffer drawdown and #122 already get. This is
 * a REPORTING channel: unlike the decumulation withdrawal, the gain is not routed
 * through the waterfall/tax seam (a purchase conserves net worth — property + mortgage
 * = price — and taxing the embedded gain would break that conservation), so the bands
 * describe where the money came from without altering the balances the sim computed.
 */

import type { Cents } from "../money";
import type { SimState } from "./runState";
import type { IncomeSourceMonth } from "./waterfall";

/**
 * The diagnostic bands one month's funding draws produce, for {@link
 * import("./reportFlows").buildFlows}:
 * - `gainSources` — one capital-gains income band per source that realized a gain
 *   (reporting-only: `waterfallInflowCents` 0, so it never enters allocation or tax);
 * - `principalDrawdownCents` — the returned principal across all sources (a cash
 *   source contributes its whole draw), folded into the `savingsDrawdown` band.
 */
export interface FundingDrawReport {
  readonly gainSources: readonly IncomeSourceMonth[];
  readonly principalDrawdownCents: Cents;
}

/**
 * Resolve every funding draw scheduled at `month`: drain each `amountCents` from its
 * sources in order (floored at what each holds — a source can never go negative), and
 * report the realized gain vs. returned principal. Mutates `assetBalances` and
 * `basisByAccount` in place. When the sources cannot cover the amount the draw simply
 * takes what is there — the §4.5 gate is the guard that this does not happen on an
 * accepted purchase.
 */
export function applyFundingDraws(state: SimState, month: number): FundingDrawReport {
  const gainSources: IncomeSourceMonth[] = [];
  let principalDrawdownCents = 0;

  for (const draw of state.fundingDraws) {
    if (draw.month !== month) continue;
    let remaining = draw.amountCents;
    for (const sourceId of draw.sourceIds) {
      if (remaining <= 0) break;
      const balance = state.assetBalances.get(sourceId) ?? 0;
      const take = Math.min(Math.max(0, balance), remaining);
      if (take <= 0) continue;

      // Return basis pro-rata: the same split assetSteps / the withdrawal channel use
      // — principal returned is `take × (basis / balance)`, and the GAIN is the rest.
      const basis = Math.max(0, state.basisByAccount.get(sourceId) ?? 0);
      const basisFraction = balance > 0 ? Math.min(1, basis / balance) : 0;
      const principal = Math.round(take * basisFraction);
      const gain = take - principal;

      state.assetBalances.set(sourceId, balance - take);
      state.basisByAccount.set(sourceId, Math.max(0, basis - principal));
      remaining -= take;
      principalDrawdownCents += principal;

      // Only a positive gain books a capital-gains band — a cash / zero-gain source is
      // pure returned principal and surfaces solely through the savings drawdown.
      if (gain > 0) {
        const account = state.accounts.find((a) => a.id === sourceId);
        if (account) {
          gainSources.push({
            ownerId: account.ownerId,
            // Reporting-only: buildFlows reads this band, the waterfall never does.
            waterfallInflowCents: 0,
            cashInflowCents: gain,
            // A brokerage / goal fund draws its gain at `capitalGains`; the report bands
            // it there (its tax category IS its display category, so no override needed).
            taxCategory: account.taxProfile.withdrawalCategory,
            taxableCents: 0,
            sourceId: `downpayment:${sourceId}`,
            label: account.label ?? sourceId,
          });
        }
      }
    }
  }

  return { gainSources, principalDrawdownCents };
}
