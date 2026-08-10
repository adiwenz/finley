/**
 * Classifying a blocked funding draw — the diagnosis the app turns into a repair instruction.
 *
 * When an explicitly-funded obligation's named sources fall short, the projection blocks (see
 * {@link import("./fundingDrawStep").resolveFundingDraws}). This decides WHY: the selected
 * sources fall short but eligible money exists elsewhere (a funding-configuration mistake, not
 * insolvency), or nothing eligible could cover it. The distinction is what tells the household
 * whether to re-point their funding or accept the purchase is out of eligible reach — a household
 * with $2M in retirement and $50k liquid lands in the second case while being obviously wealthy,
 * so the copy this drives must never call it "can't afford."
 *
 * The engine RECOMMENDS and never chooses: {@link FundingFailure.alternativeSources} is advisory,
 * and the actual draw already ran in its named order. Nothing here reorders, substitutes, or
 * liquidates. Availability is priced through the same {@link resolveOrderedFundingDraw} the
 * simulator and the affordability reporter share, so a source's tax is stated identically
 * wherever it is read.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import {
  resolveOrderedFundingDraw,
  type AccountFundingSource,
  type CreditFundingSource,
  type FundingSourceState,
  type TaxableByOwner,
} from "./fundingDrawStep";
import { getEligibleFundingSources, type FundingTreatment } from "./fundingEligibility";

/**
 * An eligible funding candidate as the classifier reads it: a priceable {@link FundingSourceState}
 * plus its eligibility facts. An account carries its balance/basis and is priced as a sale; a
 * credit card carries its owed balance and limit and is priced as a borrow against headroom. The
 * `credit`/`liquid` discriminant is what {@link getEligibleFundingSources} reads to admit a card to
 * the `expense` pool and keep it out of the `asset-acquisition` one.
 */
export type EligibleAccountState =
  | (AccountFundingSource & { readonly liquid: boolean; readonly credit?: false })
  | (CreditFundingSource & { readonly liquid: false; readonly credit: true });

/**
 * Why a funding draw could not be met. Both shapes carry tax and a shortfall, both are net of the
 * capital-gains tax liquidating the sources owes, and NEITHER is insolvency.
 */
export type FundingFailure =
  | {
      readonly kind: "funding-configuration";
      readonly requiredCents: Cents;
      /** What the SELECTED sources delivered, net of tax — the block's `availableCents`. */
      readonly selectedSourcesAvailableCents: Cents;
      readonly selectedSourcesTaxCents: Cents;
      readonly shortfallCents: Cents;
      /** Eligible accounts the user did NOT select, each with its own net-of-tax available. Advisory. */
      readonly alternativeSources: readonly { readonly accountId: string; readonly availableCents: Cents }[];
    }
  | {
      readonly kind: "no-eligible-source-suffices";
      readonly requiredCents: Cents;
      /** What the WHOLE eligible pool delivers, net of tax — still short of `requiredCents`. */
      readonly eligibleAvailableCents: Cents;
      readonly eligibleTaxCents: Cents;
      readonly shortfallCents: Cents;
    };

/** A working copy so each independent pricing probes over the same base without stacking onto it. */
function copyTaxable(taxableByOwner: TaxableByOwner): TaxableByOwner {
  const copy: TaxableByOwner = new Map();
  for (const [ownerId, byCategory] of taxableByOwner) copy.set(ownerId, { ...byCategory });
  return copy;
}

export function classifyFundingFailure(params: {
  readonly treatment: FundingTreatment;
  readonly requiredCents: Cents;
  readonly selectedSourceIds: readonly string[];
  /** The block's own figures for the selected draw, priced in its named order — never recomputed here. */
  readonly selectedSourcesAvailableCents: Cents;
  readonly selectedSourcesTaxCents: Cents;
  /** Every account the household holds at the blocked month, with the balance/basis then in effect. */
  readonly accounts: readonly EligibleAccountState[];
  readonly jurisdiction: Jurisdiction;
  readonly ctx: JurisdictionContext;
  /** The owner taxable base at the blocked draw's seam; each pricing gets its own copy. */
  readonly taxableByOwner: TaxableByOwner;
}): FundingFailure {
  const {
    treatment,
    requiredCents,
    selectedSourceIds,
    selectedSourcesAvailableCents,
    selectedSourcesTaxCents,
    accounts,
    jurisdiction,
    ctx,
    taxableByOwner,
  } = params;

  // What a source can contribute: an account's balance (sold, then grossed down by tax), a card's
  // headroom (limit − owed, clamped ≥0). A card with no entered limit has no bounded capacity and
  // is treated as unavailable here (mirroring the picker disabling it), so it never covers a
  // shortfall nor appears as an alternative — an unbounded card would trivially "fund" everything.
  const capacityOf = (a: EligibleAccountState): Cents =>
    a.credit === true
      ? a.creditLimitCents === null
        ? 0
        : Math.max(0, a.creditLimitCents - a.balanceCents)
      : a.balanceCents;

  // Largest capacity first — the ordering `sourcesAt` reports and the picker shows, so the pool is
  // priced exactly as the user would draw it. Zero-capacity sources (an emptied account, a maxed or
  // limitless card) are dropped: the primitive would skip them anyway, and a limitless card must
  // never be fed to it, since it would borrow the whole remainder. A copy of the base per pricing
  // keeps each probe independent: the alternatives are each "what if you drew THIS instead".
  const pool = [...getEligibleFundingSources(treatment, accounts)]
    .filter((a) => capacityOf(a) > 0)
    .sort((a, b) => capacityOf(b) - capacityOf(a));
  const priceOf = (sources: readonly FundingSourceState[], amountCents: Cents) =>
    resolveOrderedFundingDraw(amountCents, sources, jurisdiction, ctx, copyTaxable(taxableByOwner));

  const wholePool = priceOf(pool, requiredCents);
  if (wholePool.shortfallCents <= 0) {
    // Eligible money covers the obligation — the selection is the problem, not the balance. Offer
    // every eligible source the user didn't already name, at its full available: an account net of
    // tax, a card at its headroom (drawing exactly its capacity, so the borrow is never taxed).
    const selected = new Set(selectedSourceIds);
    const alternativeSources = pool
      .filter((a) => !selected.has(a.id))
      .map((a) => ({ accountId: a.id, availableCents: priceOf([a], capacityOf(a)).netDeliveredCents }));
    return {
      kind: "funding-configuration",
      requiredCents,
      selectedSourcesAvailableCents,
      selectedSourcesTaxCents,
      shortfallCents: Math.max(0, requiredCents - selectedSourcesAvailableCents),
      alternativeSources,
    };
  }

  // Nothing eligible could cover it — the pool, fully liquidated, still falls short net of tax.
  return {
    kind: "no-eligible-source-suffices",
    requiredCents,
    eligibleAvailableCents: wholePool.netDeliveredCents,
    eligibleTaxCents: wholePool.perSource.reduce((sum, s) => sum + s.taxCents, 0),
    shortfallCents: wholePool.shortfallCents,
  };
}
