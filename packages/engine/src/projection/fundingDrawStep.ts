/**
 * Funding draws — simulation-time resolution of an ordered, cross-account money-out draw.
 *
 * The ledger records only the INTENT — drain `amountCents` from these sources, in this order
 * — because the split is balance-dependent and balances exist only once the projection runs.
 * Here the split is taken, mirroring {@link import("../ledger/funding").drainSources} and the
 * pro-rata basis accounting of {@link import("./withdrawal").buildWithdrawalSources}.
 *
 * Capital-gains tax is REAL: the draw is GROSSED UP so what remains after tax still covers
 * the payment, and the gain routes through the single tax chokepoint (`allocateMonth`) as a
 * net-neutral source. Consequence: funded from an appreciated source a purchase does not
 * conserve net worth, it falls by the tax paid. A cash source (basis == balance) conserves.
 *
 * The realized GAIN reports as capital-gains income, the returned PRINCIPAL as savings
 * drawdown. The gain band is reporting-only (`cashInflowCents` the gain,
 * `waterfallInflowCents` 0); its tax rides the net-neutral source, whose `cashInflowCents`
 * is 0 so it never double-counts.
 */

import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { TaxCategory } from "../cashFlowSeries";
import type { SimState } from "./runState";
import type { IncomeSourceMonth } from "./waterfall";
import type { FundingReason } from "../ledger/transfers";

export type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;
/** The month's taxable base, per owner — the context a gross-up differences tax over. */
export type TaxableByOwner = Map<string, TaxableByCategory>;

/**
 * Backstop on the gross-up climb: a non-converging seam must stop rather than spin. A
 * realistic draw converges in about a dozen steps.
 */
const GROSS_UP_ITERATIONS = 1_000;

/**
 * Reporting-provenance prefix per {@link FundingReason}, stamped on the `sourceId` of its
 * draw's bands: `<prefix>:<accountId>` for the realized-gain band, `<prefix>-tax:<accountId>`
 * for the net-neutral tax source. Resolution is otherwise reason-blind. Exhaustive by type:
 * a reason without a prefix fails the typecheck rather than going unnamed.
 */
const REPORT_PREFIX: Record<FundingReason, string> = {
  homeDownPayment: "downpayment",
};

export interface FundingSourceState {
  readonly id: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly balanceCents: Cents;
  readonly basisCents: Cents;
  readonly label?: string;
}

export interface ResolvedFundingSource {
  readonly id: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly label?: string;
  /** Sold from the account, grossed up over its own tax. */
  readonly grossCents: Cents;
  /** Realized taxable gain within `grossCents`. */
  readonly gainCents: Cents;
  /** Marginal tax the gain induced over the running owner base. */
  readonly taxCents: Cents;
  /** `grossCents − gainCents`. */
  readonly principalCents: Cents;
  /** What reached the purchase — `grossCents − taxCents`. */
  readonly netDeliveredCents: Cents;
}

export interface OrderedFundingDrawResult {
  readonly perSource: readonly ResolvedFundingSource[];
  /** Σ `netDeliveredCents`. */
  readonly netDeliveredCents: Cents;
  /** `max(0, amount − netDelivered)`. Positive means the sources fall short. */
  readonly shortfallCents: Cents;
}

/** Per-owner taxable base from the month's already-resolved (non-funding) income. */
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

/** Serializable snapshot, for the flow view / gate seam. */
export function toTaxableRecord(taxableByOwner: TaxableByOwner): Record<string, TaxableByCategory> {
  const record: Record<string, TaxableByCategory> = {};
  for (const [ownerId, byCategory] of taxableByOwner) record[ownerId] = { ...byCategory };
  return record;
}

/**
 * Resolve an ordered draw of `amountCents` across `sources` WITHOUT mutating account state:
 * sell enough from each in turn that the NET (after the capital-gains tax the sale induces)
 * covers the remainder, floored at what it holds. Tax is differenced over `taxableByOwner`
 * and each gain STACKED onto it, so a second taxable source from the same owner is taxed on
 * top of the first — hence this MUTATES `taxableByOwner` (pass a copy to probe).
 *
 * Shared with the §4.5 affordability gate, which runs it against the projected month state,
 * so the gate blocks exactly when the sim would fall short — under any tax regime.
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
    // Taxable gain of a `gross` draw: the jurisdiction owns return-of-capital policy; absent
    // the seam, fall back to the pro-rata basis split — exactly the reporting split, so a
    // no-tax run grosses up by nothing. Monotone non-decreasing, which lets the loop climb.
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
    // capped at the balance — the same solve as the decumulation withdrawal (a rising
    // sequence stops at the cheapest liquidation that nets the need).
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
 * - `principalDrawdownCents` — returned principal across all sources (a cash source
 *   contributes its whole draw), folded into the `savingsDrawdown` band;
 * - `taxSources` — net-neutral sources routing each realized gain through the tax
 *   chokepoint. Folded into `incomeSources` BEFORE `allocateMonth`; each carries
 *   `waterfallInflowCents` equal to the tax it induces and `cashInflowCents` 0, so it
 *   charges exactly its tax, nets zero, and never shows as income.
 * - `taxableByOwnerAfter` — the per-owner taxable base with THIS MONTH'S DRAWS STACKED IN:
 *   what a further draw at this month would be taxed on top of. The authoring gate reads it
 *   (via `flows`) so a second money-out event in the same month is priced over its sibling's
 *   realized gain, exactly as the simulator prices it.
 */
export interface FundingDrawReport {
  readonly gainSources: readonly IncomeSourceMonth[];
  readonly principalDrawdownCents: Cents;
  readonly taxSources: readonly IncomeSourceMonth[];
  readonly taxableByOwnerAfter: TaxableByOwner;
}

/**
 * Resolve every funding draw scheduled at `month` against the live `SimState`, draining the
 * sources in order and applying the balance/basis moves in place; returns the reporting
 * bands plus the net-neutral tax sources the caller folds into the chokepoint. The gross-up
 * is {@link resolveOrderedFundingDraw}, the one definition the §4.5 gate shares — so an
 * accepted purchase never lands short here.
 *
 * `taxableByOwner` is the month's already-resolved (non-funding) taxable base — the marginal
 * context the gain's tax is differenced over. NOT mutated: a working copy is threaded across
 * draws, stacking each draw's gain onto the next, and comes back as `taxableByOwnerAfter`,
 * what a LATER draw at this month must be priced over.
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

  // A private working copy so consecutive draws stack their gains (as the sim's tax does)
  // while the caller's base map stays pristine for reuse.
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
      // returned principal, surfacing solely through the savings drawdown.
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
      // Route the gain through the tax chokepoint, net-neutral: carries the liquidation's tax
      // slice as cash (`waterfallInflowCents`) and books the gain as taxable, so
      // `allocateMonth` charges exactly `tax` and nets zero. `cashInflowCents` 0 keeps it out
      // of the income view (the gain is reported via the band above).
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

  return { gainSources, principalDrawdownCents, taxSources, taxableByOwnerAfter: working };
}
