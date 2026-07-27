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
 * Capital-gains tax is REAL (#153 follow-up). Liquidating an appreciated investment to
 * fund the draw realizes a taxable gain, so the draw is GROSSED UP: it sells enough that
 * the amount left AFTER the tax still covers the down payment, exactly as the decumulation
 * withdrawal grosses up its draw. The realized gain is routed through the single tax
 * chokepoint (`allocateMonth`) as a net-neutral source — it carries the tax slice of the
 * liquidation as cash and books the gain as taxable, so the chokepoint charges precisely
 * that tax and nets zero. The consequence is deliberate: the purchase NO LONGER conserves
 * net worth when funded from an appreciated source — net worth falls by exactly the tax
 * paid, which is what actually happens. A cash source (basis == balance, no gain) realizes
 * no tax and still conserves.
 *
 * Reporting is #122-consistent and unchanged in shape: an investment source's realized
 * GAIN reports as capital-gains income and its returned PRINCIPAL (plus any cash source's
 * whole draw) as a savings drawdown. The gain band is reporting-only (`cashInflowCents`
 * the gain, `waterfallInflowCents` 0); the tax it now bears rides the separate net-neutral
 * source, whose `cashInflowCents` is 0 so it never double-counts as income in the flow view.
 */

import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { TaxCategory } from "../cashFlowSeries";
import type { SimState } from "./runState";
import type { IncomeSourceMonth } from "./waterfall";

/** A per-owner map of taxable amount by {@link TaxCategory} (mirrors the withdrawal channel). */
type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;

/**
 * Backstop on the gross-up climb — the same guard, for the same reason, as {@link
 * import("./withdrawal").buildWithdrawalSources}: a pathological non-converging seam must
 * stop rather than spin. A realistic draw converges in about a dozen steps; the loop exits
 * the moment it reaches its fixed point, so this bound is only met by seams that never do.
 */
const GROSS_UP_ITERATIONS = 1_000;

/**
 * The diagnostic bands and tax routing one month's funding draws produce:
 * - `gainSources` — one capital-gains income band per source that realized a gain
 *   (reporting-only: `waterfallInflowCents` 0, `cashInflowCents` the gain), for {@link
 *   import("./reportFlows").buildFlows};
 * - `principalDrawdownCents` — the returned principal across all sources (a cash source
 *   contributes its whole draw), folded into the `savingsDrawdown` band;
 * - `taxSources` — the net-neutral sources that route each realized gain through the tax
 *   chokepoint, so the gain is actually taxed. Folded into `incomeSources` BEFORE
 *   `allocateMonth`; each carries `waterfallInflowCents` equal to the tax it induces and
 *   `cashInflowCents` 0, so it charges exactly its tax, nets zero, and never shows as income.
 */
export interface FundingDrawReport {
  readonly gainSources: readonly IncomeSourceMonth[];
  readonly principalDrawdownCents: Cents;
  readonly taxSources: readonly IncomeSourceMonth[];
}

/**
 * Resolve every funding draw scheduled at `month`: for each source, sell enough (grossed
 * up over the capital-gains tax the sale induces) that the NET covers its share of the
 * down payment, draining the sources in order and flooring each at what it holds. Mutates
 * `assetBalances` and `basisByAccount` in place, and returns the reporting bands plus the
 * net-neutral tax sources the caller folds into the chokepoint.
 *
 * `priorIncomeSources` are the month's already-resolved income (non-withdrawal +
 * decumulation): the gain's induced tax is differenced over the WHOLE return against this
 * base — the same marginal probe the withdrawal channel uses — so a gain that reads as 0%
 * on its own but drags a benefit into taxability is still sized and taxed correctly.
 *
 * When the sources cannot cover the grossed-up amount the draw simply takes what is there
 * — the §4.5 gate (now sizing on down payment + tax) is the guard that this does not
 * happen on an accepted purchase.
 */
export function resolveFundingDraws(
  state: SimState,
  month: number,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  priorIncomeSources: readonly IncomeSourceMonth[],
): FundingDrawReport {
  const gainSources: IncomeSourceMonth[] = [];
  const taxSources: IncomeSourceMonth[] = [];
  let principalDrawdownCents = 0;

  const computeTaxCents = (taxable: TaxableByCategory): Cents =>
    jurisdiction.computeTaxCents(taxable, ctx);

  // The owner's taxable base this month, seeded from the already-resolved income so the
  // gross-up differences marginal tax over the whole return. Mutated as each source
  // realizes its gain, so a later source in the drain order differences on top of an
  // earlier one — exactly how the withdrawal channel threads its own draws.
  const taxableByOwner = new Map<string, TaxableByCategory>();
  for (const src of priorIncomeSources) {
    let map = taxableByOwner.get(src.ownerId);
    if (map === undefined) {
      map = {};
      taxableByOwner.set(src.ownerId, map);
    }
    const amount = src.taxableCents ?? src.waterfallInflowCents;
    if (amount !== 0) map[src.taxCategory] = (map[src.taxCategory] ?? 0) + amount;
  }

  for (const draw of state.fundingDraws) {
    if (draw.month !== month) continue;
    // `remaining` is the NET down payment still to fund — each source nets its own gross
    // minus tax against it, so the amounts genuinely delivered to the purchase sum to it.
    let remaining = draw.amountCents;
    for (const sourceId of draw.sourceIds) {
      if (remaining <= 0) break;
      const balance = state.assetBalances.get(sourceId) ?? 0;
      if (balance <= 0) continue;
      const account = state.accounts.find((a) => a.id === sourceId);
      if (account === undefined) continue;

      const category = account.taxProfile.withdrawalCategory;
      const basis = Math.max(0, state.basisByAccount.get(sourceId) ?? 0);
      const basisFraction = balance > 0 ? Math.min(1, basis / balance) : 0;
      // The taxable gain of a `gross` draw: the jurisdiction owns the return-of-capital
      // policy (`taxableWithdrawalCents`, as the withdrawal channel uses it); absent the
      // seam (null jurisdiction) fall back to the engine's pro-rata basis split, which is
      // exactly the #153 reporting split — so a no-tax run grosses up by nothing and the
      // gain/principal bands are unchanged. Monotone in `gross`, which lets the loop climb.
      const gainOf = (gross: Cents): Cents =>
        jurisdiction.taxableWithdrawalCents?.(
          { grossCents: gross, basisCents: basis, balanceCents: balance, category },
          ctx,
        ) ?? gross - Math.round(gross * basisFraction);

      const base = taxableByOwner.get(account.ownerId) ?? {};
      const withGain = (gross: Cents): TaxableByCategory => ({
        ...base,
        [category]: (base[category] ?? 0) + gainOf(gross),
      });
      const baseTax = computeTaxCents(base);
      const inducedTax = (gross: Cents): Cents => computeTaxCents(withGain(gross)) - baseTax;

      // Gross up: sell enough that `gross − inducedTax(gross)` still covers `remaining`.
      // Least fixed point of `gross = remaining + inducedTax(gross)`, climbed from
      // `remaining` and capped at the balance — the same solve, for the same reason, as the
      // decumulation withdrawal (a rising sequence stops at the cheapest liquidation).
      let gross = Math.min(balance, remaining);
      for (let i = 0; i < GROSS_UP_ITERATIONS; i++) {
        const wanted = remaining + inducedTax(gross);
        // The account cannot cover its own gross-up: take what is there and let the rest of
        // the down payment fall to the next source in the order.
        if (wanted >= balance) {
          gross = balance;
          break;
        }
        if (wanted === gross) break;
        gross = wanted;
      }

      const gain = gainOf(gross);
      const tax = computeTaxCents(withGain(gross)) - baseTax;
      const principal = gross - gain;

      state.assetBalances.set(sourceId, balance - gross);
      state.basisByAccount.set(sourceId, Math.max(0, basis - principal));
      taxableByOwner.set(account.ownerId, withGain(gross));
      // Net delivered to the purchase is `gross − tax`; that is what pays down `remaining`.
      remaining -= gross - tax;
      principalDrawdownCents += principal;

      // Only a positive gain books a capital-gains band — a cash / zero-gain source is pure
      // returned principal and surfaces solely through the savings drawdown.
      if (gain > 0) {
        gainSources.push({
          ownerId: account.ownerId,
          // Reporting-only: buildFlows reads this band, the waterfall never does.
          waterfallInflowCents: 0,
          cashInflowCents: gain,
          taxCategory: category,
          taxableCents: 0,
          sourceId: `downpayment:${sourceId}`,
          label: account.label ?? sourceId,
        });
      }
      // Route the realized gain through the tax chokepoint, net-neutral: the source carries
      // the tax slice of the liquidation as cash (`waterfallInflowCents`) and books the gain
      // as taxable, so `allocateMonth` charges exactly `tax` and nets zero. `cashInflowCents`
      // 0 keeps it out of the income view (the gain is reported via the band above).
      if (tax > 0) {
        taxSources.push({
          ownerId: account.ownerId,
          waterfallInflowCents: tax,
          cashInflowCents: 0,
          taxCategory: category,
          taxableCents: gain,
          sourceId: `downpayment-tax:${sourceId}`,
          label: account.label ?? sourceId,
        });
      }
    }
  }

  return { gainSources, principalDrawdownCents, taxSources };
}
