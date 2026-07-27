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
import type { FundingReason } from "../ledger/transfers";

/** A per-owner map of taxable amount by {@link TaxCategory} (mirrors the withdrawal channel). */
export type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;
/** The month's taxable base, per owner — the marginal-tax context a funding gross-up differences over. */
export type TaxableByOwner = Map<string, TaxableByCategory>;

/**
 * Backstop on the gross-up climb — the same guard, for the same reason, as {@link
 * import("./withdrawal").buildWithdrawalSources}: a pathological non-converging seam must
 * stop rather than spin. A realistic draw converges in about a dozen steps; the loop exits
 * the moment it reaches its fixed point, so this bound is only met by seams that never do.
 */
const GROSS_UP_ITERATIONS = 1_000;

/**
 * The reporting-provenance prefix each {@link FundingReason} stamps on the `sourceId` of the
 * bands its draw produces: `<prefix>:<accountId>` for the realized-gain band and
 * `<prefix>-tax:<accountId>` for the net-neutral source that carries its tax. This is the one
 * place a draw's *reason* becomes a *name* — the resolution itself (balances, gross-up, basis,
 * tax) is reason-blind, so a new money-out event (One-Time Spend, #154) names its own bands by
 * adding one line here rather than reporting under the down payment's name. Exhaustive by
 * type: a new reason without a prefix fails the typecheck instead of silently going unnamed.
 */
const REPORT_PREFIX: Record<FundingReason, string> = {
  homeDownPayment: "downpayment",
};

/** One resolved source of an ordered funding draw — the balances/basis it drew against. */
export interface FundingSourceState {
  readonly id: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly balanceCents: Cents;
  readonly basisCents: Cents;
  readonly label?: string;
}

/** What one source actually delivered when an ordered draw was resolved against it. */
export interface ResolvedFundingSource {
  readonly id: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly label?: string;
  /** Sold from the account (grossed up over its own tax). */
  readonly grossCents: Cents;
  /** The realized, taxable gain within `grossCents`. */
  readonly gainCents: Cents;
  /** The marginal capital-gains tax the gain induced, over the running owner base. */
  readonly taxCents: Cents;
  /** Returned principal — `grossCents − gainCents`. */
  readonly principalCents: Cents;
  /** What reached the purchase — `grossCents − taxCents`. */
  readonly netDeliveredCents: Cents;
}

/** The outcome of resolving an ordered funding draw: per-source draws plus the totals. */
export interface OrderedFundingDrawResult {
  readonly perSource: readonly ResolvedFundingSource[];
  /** Σ of `netDeliveredCents` — what the sources genuinely fund toward the amount. */
  readonly netDeliveredCents: Cents;
  /** Uncovered remainder — `max(0, amount − netDelivered)`. Positive means the sources fall short. */
  readonly shortfallCents: Cents;
}

/** The month's per-owner taxable base, from its already-resolved (non-funding) income sources. */
export function buildTaxableByOwner(sources: readonly IncomeSourceMonth[]): TaxableByOwner {
  const taxableByOwner: TaxableByOwner = new Map();
  for (const src of sources) {
    let map = taxableByOwner.get(src.ownerId);
    if (map === undefined) {
      map = {};
      taxableByOwner.set(src.ownerId, map);
    }
    const amount = src.taxableCents ?? src.waterfallInflowCents;
    if (amount !== 0) map[src.taxCategory] = (map[src.taxCategory] ?? 0) + amount;
  }
  return taxableByOwner;
}

/** A plain, serializable snapshot of a taxable-by-owner map (for the flow view / gate seam). */
export function toTaxableRecord(taxableByOwner: TaxableByOwner): Record<string, TaxableByCategory> {
  const record: Record<string, TaxableByCategory> = {};
  for (const [ownerId, byCategory] of taxableByOwner) record[ownerId] = { ...byCategory };
  return record;
}

/**
 * Resolve an ordered funding draw of `amountCents` across `sources`, WITHOUT mutating any
 * account state: sell enough from each source in turn that the NET (after the capital-gains
 * tax the sale induces) covers the remaining amount, flooring each at what it holds. The
 * gain's tax is differenced over `taxableByOwner` and each realized gain is STACKED onto it,
 * so a second taxable source from the same owner is taxed on top of the first — this call
 * MUTATES `taxableByOwner` for that reason (pass a copy to probe without disturbing it).
 *
 * This is the single definition of "what do these sources net toward this amount, after
 * tax?": the simulator calls it and then applies the per-source balance/basis moves and
 * emits the report + tax sources, while the §4.5 affordability gate calls it against the
 * PROJECTED month state to decide accept/block — so the gate blocks exactly when the sim
 * would fall short, under any tax regime (no standalone-rate approximation).
 */
export function resolveOrderedFundingDraw(
  amountCents: Cents,
  sources: readonly FundingSourceState[],
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  taxableByOwner: TaxableByOwner,
): OrderedFundingDrawResult {
  const computeTaxCents = (taxable: TaxableByCategory): Cents =>
    jurisdiction.computeTaxCents(taxable, ctx);

  const perSource: ResolvedFundingSource[] = [];
  let remaining = amountCents;

  for (const source of sources) {
    if (remaining <= 0) break;
    const balance = source.balanceCents;
    if (balance <= 0) continue;
    const { id, ownerId, category, label } = source;
    const basis = Math.max(0, source.basisCents);
    const basisFraction = balance > 0 ? Math.min(1, basis / balance) : 0;
    // The taxable gain of a `gross` draw: the jurisdiction owns the return-of-capital policy
    // (`taxableWithdrawalCents`, as the withdrawal channel uses it); absent the seam (null
    // jurisdiction) fall back to the engine's pro-rata basis split, which is exactly the
    // #153 reporting split — so a no-tax run grosses up by nothing and the gain/principal
    // bands are unchanged. Monotone non-decreasing in `gross`, which lets the loop climb.
    const gainOf = (gross: Cents): Cents =>
      jurisdiction.taxableWithdrawalCents?.(
        { grossCents: gross, basisCents: basis, balanceCents: balance, category },
        ctx,
      ) ?? gross - Math.round(gross * basisFraction);

    const base = taxableByOwner.get(ownerId) ?? {};
    const withGain = (gross: Cents): TaxableByCategory => ({
      ...base,
      [category]: (base[category] ?? 0) + gainOf(gross),
    });
    const baseTax = computeTaxCents(base);
    const inducedTax = (gross: Cents): Cents => computeTaxCents(withGain(gross)) - baseTax;

    // Gross up: sell enough that `gross − inducedTax(gross)` still covers `remaining`. Least
    // fixed point of `gross = remaining + inducedTax(gross)`, climbed from `remaining` and
    // capped at the balance — the same solve, for the same reason, as the decumulation
    // withdrawal (a rising sequence stops at the cheapest liquidation that nets the need).
    let gross = Math.min(balance, remaining);
    for (let i = 0; i < GROSS_UP_ITERATIONS; i++) {
      const wanted = remaining + inducedTax(gross);
      // The account cannot cover its own gross-up: take what is there and let the rest of the
      // amount fall to the next source in the order.
      if (wanted >= balance) {
        gross = balance;
        break;
      }
      if (wanted === gross) break;
      gross = wanted;
    }

    const gain = gainOf(gross);
    const tax = computeTaxCents(withGain(gross)) - baseTax;
    // Stack this gain onto the owner base so the next source from the same owner is taxed on
    // top of it — the marginal context the simulator threads through its own draws.
    taxableByOwner.set(ownerId, withGain(gross));
    const netDelivered = gross - tax;
    remaining -= netDelivered;
    perSource.push({
      id,
      ownerId,
      category,
      label,
      grossCents: gross,
      gainCents: gain,
      taxCents: tax,
      principalCents: gross - gain,
      netDeliveredCents: netDelivered,
    });
  }

  return {
    perSource,
    netDeliveredCents: amountCents - remaining,
    shortfallCents: Math.max(0, remaining),
  };
}

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
 * Resolve every funding draw scheduled at `month` against the live `SimState`: for each
 * source, sell enough (grossed up over the capital-gains tax the sale induces) that the NET
 * covers its share of the amount, draining the sources in order. Applies the balance/basis
 * moves in place and returns the reporting bands plus the net-neutral tax sources the caller
 * folds into the chokepoint. The gross-up itself is {@link resolveOrderedFundingDraw}, the
 * one definition the §4.5 gate shares — so an accepted purchase never lands short here.
 *
 * `taxableByOwner` is the month's already-resolved (non-funding) taxable base — the marginal
 * context the gain's tax is differenced over. It is NOT mutated (a working copy is threaded
 * across draws internally), so the caller may reuse it (e.g. expose it to the flow view).
 */
export function resolveFundingDraws(
  state: SimState,
  month: number,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  taxableByOwner: TaxableByOwner,
): FundingDrawReport {
  const gainSources: IncomeSourceMonth[] = [];
  const taxSources: IncomeSourceMonth[] = [];
  let principalDrawdownCents = 0;

  // Thread a private working copy across this month's draws so consecutive draws stack their
  // gains (as the sim's tax does) while the caller's base map stays pristine for reuse.
  const working: TaxableByOwner = new Map();
  for (const [ownerId, byCategory] of taxableByOwner) working.set(ownerId, { ...byCategory });

  for (const draw of state.fundingDraws) {
    if (draw.month !== month) continue;
    // Resolve the ordered draw against the live balances/basis, then apply what it took.
    const sources: FundingSourceState[] = [];
    for (const sourceId of draw.sourceIds) {
      const account = state.accounts.find((a) => a.id === sourceId);
      if (account === undefined) continue;
      sources.push({
        id: sourceId,
        ownerId: account.ownerId,
        category: account.taxProfile.withdrawalCategory,
        balanceCents: state.assetBalances.get(sourceId) ?? 0,
        basisCents: Math.max(0, state.basisByAccount.get(sourceId) ?? 0),
        label: account.label ?? sourceId,
      });
    }
    const { perSource } = resolveOrderedFundingDraw(
      draw.amountCents,
      sources,
      jurisdiction,
      ctx,
      working,
    );
    // What this draw's bands call themselves — its reason, not the caller's event.
    const prefix = REPORT_PREFIX[draw.reason];

    for (const s of perSource) {
      if (s.grossCents <= 0) continue;
      state.assetBalances.set(s.id, (state.assetBalances.get(s.id) ?? 0) - s.grossCents);
      state.basisByAccount.set(
        s.id,
        Math.max(0, (state.basisByAccount.get(s.id) ?? 0) - s.principalCents),
      );
      principalDrawdownCents += s.principalCents;

      // Only a positive gain books a capital-gains band — a cash / zero-gain source is pure
      // returned principal and surfaces solely through the savings drawdown.
      if (s.gainCents > 0) {
        gainSources.push({
          ownerId: s.ownerId,
          // Reporting-only: buildFlows reads this band, the waterfall never does.
          waterfallInflowCents: 0,
          cashInflowCents: s.gainCents,
          taxCategory: s.category,
          taxableCents: 0,
          sourceId: `${prefix}:${s.id}`,
          label: s.label ?? s.id,
        });
      }
      // Route the realized gain through the tax chokepoint, net-neutral: the source carries
      // the tax slice of the liquidation as cash (`waterfallInflowCents`) and books the gain
      // as taxable, so `allocateMonth` charges exactly `tax` and nets zero. `cashInflowCents`
      // 0 keeps it out of the income view (the gain is reported via the band above).
      if (s.taxCents > 0) {
        taxSources.push({
          ownerId: s.ownerId,
          waterfallInflowCents: s.taxCents,
          cashInflowCents: 0,
          taxCategory: s.category,
          taxableCents: s.gainCents,
          sourceId: `${prefix}-tax:${s.id}`,
          label: s.label ?? s.id,
        });
      }
    }
  }

  return { gainSources, principalDrawdownCents, taxSources };
}
