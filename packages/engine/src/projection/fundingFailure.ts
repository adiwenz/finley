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
  type FundingSourceState,
  type TaxableByOwner,
} from "./fundingDrawStep";
import { getEligibleFundingSources, type FundingTreatment } from "./fundingEligibility";

/**
 * A household account as the classifier reads it: an account funding source plus its eligibility
 * fact. The pool it classifies against is asset accounts today; credit joins it in a later slice.
 */
export interface EligibleAccountState extends AccountFundingSource {
  readonly liquid: boolean;
}

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

  // Largest balance first — the ordering `sourcesAt` reports and the picker shows, so the pool is
  // priced exactly as the user would draw it. A copy of the base per pricing keeps each probe
  // independent: the alternatives are each "what if you drew THIS instead", not a running total.
  const pool = [...getEligibleFundingSources(treatment, accounts)].sort(
    (a, b) => b.balanceCents - a.balanceCents,
  );
  const priceOf = (sources: readonly FundingSourceState[], amountCents: Cents) =>
    resolveOrderedFundingDraw(amountCents, sources, jurisdiction, ctx, copyTaxable(taxableByOwner));

  const wholePool = priceOf(pool, requiredCents);
  if (wholePool.shortfallCents <= 0) {
    // Eligible money covers the obligation — the selection is the problem, not the balance. Offer
    // every eligible account the user didn't already name, at its full net-of-tax available.
    const selected = new Set(selectedSourceIds);
    const alternativeSources = pool
      .filter((a) => !selected.has(a.id) && a.balanceCents > 0)
      .map((a) => ({ accountId: a.id, availableCents: priceOf([a], a.balanceCents).netDeliveredCents }));
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
