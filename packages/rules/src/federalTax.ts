import type { Cents, TaxCategory } from "@finley/engine";
import {
  federalTaxTables,
  LTCG_RATE_15,
  LTCG_RATE_20,
  SS_TIER_1_THRESHOLD_CENTS,
  SS_TIER_2_THRESHOLD_CENTS,
  SS_TIER_1_SHARE,
  SS_MAX_SHARE,
  type OrdinaryBracket,
} from "./federalTaxTables";

// The legislated tables and constants now live in ./federalTaxTables; re-exported here
// so the `rules` barrel (index.ts) keeps resolving them through ./federalTax unchanged.
export {
  federalTaxTables,
  FEDERAL_TAX_BASE_YEAR,
  FEDERAL_TAX_ASSUMPTIONS,
  type FederalTaxTables,
  type OrdinaryBracket,
} from "./federalTaxTables";
// The per-category attribution seams now live in ./federalTaxAttribution (which reads the
// core federalTaxParts exported below). Re-exported here so the `rules` barrel and
// federalTax.test.ts keep resolving them through ./federalTax unchanged. annualizeByCategory
// is imported back for the monthly scalar seam computeFederalTaxCents.
import { annualizeByCategory } from "./federalTaxAttribution";
export {
  federalAnnualTaxByCategoryCents,
  computeFederalTaxByCategoryCents,
} from "./federalTaxAttribution";

/**
 * US federal income tax for a SINGLE FILER (§5.3 seam 1) — the real policy behind
 * the engine's {@link import("@finley/engine").Jurisdiction.computeTaxCents} seam.
 *
 * This is the `rules`-side plug the engine calls once per person to turn a map of
 * per-{@link TaxCategory} taxable amounts into tax owed. It models the four things
 * that make US federal tax not-a-flat-rate for a single filer:
 *
 *   1. **Progressive ordinary brackets** — `wages` and `ordinaryIncome` (plus the
 *      taxable slice of the government benefit) climb the 10→37% bracket stack.
 *   2. **Standard deduction** — a flat exclusion off ordinary income first, then
 *      any unused remainder off capital gains (the deduction "stacks down").
 *   3. **Capital-gains preference** — `capitalGains` is taxed at the preferential
 *      0/15/20% rates, STACKED on top of ordinary taxable income (the gains fill
 *      the brackets left above ordinary income, not from zero).
 *   4. **Government-benefit inclusion** — only a portion of a `governmentRetire-
 *      mentBenefit` (US: Social Security) is taxable, set by the provisional-income
 *      formula (0 / up-to-50% / up-to-85%). `taxExempt` income is never taxed but
 *      DOES count toward provisional income, so it can pull the benefit into range.
 *
 * The engine hands MONTHLY per-category slices (it calls the seam each month). Tax
 * brackets are ANNUAL, so {@link computeFederalTaxCents} annualizes the slice
 * (×12), runs the annual math, and returns the month's 1/12 share — the standard
 * steady-state withholding approximation. The pure annual math is
 * {@link federalAnnualTaxCents}; the monthly seam is the only thing `index.ts`
 * wires into the jurisdiction.
 *
 * NEUTRALITY (§5.0, from #50): every US constant — brackets, deduction, cap-gains
 * tops, inclusion thresholds — lives HERE, never in `packages/engine/src`. The
 * engine only states neutral per-category gross; this module owns the consequence.
 *
 * Filing status is fixed to SINGLE here (#53). The tax-unit grouping and the
 * MFJ/MFS/HoH tables are #52, which builds a status parameter on top of this.
 *
 * ⚠ Estimates, not advice. The FORMULA is modelled faithfully so the cent-pinned
 * base-year anchors hold, but the forward-indexed figures (and the law itself)
 * WILL drift. All dollar figures are the pinned {@link FEDERAL_TAX_BASE_YEAR}
 * base; later years are indexed forward, earlier years return the base unchanged.
 */

/**
 * The taxable portion of a US government retirement benefit (Social Security) for a
 * SINGLE filer, from the provisional-income formula. `benefitCents` is the annual
 * benefit; `otherProvisionalIncomeCents` is everything else that counts toward
 * provisional income (ordinary income + capital gains + tax-exempt income), NOT
 * including the benefit itself. Half the benefit is added here to form provisional
 * income, then:
 *
 *   • below $25,000  → 0 taxable
 *   • $25,000–$34,000 → min(50% of benefit, 50% of the excess over $25,000)
 *   • above $34,000  → min(85% of benefit, 85% of the excess over $34,000 + the
 *                          tier-1 amount, itself capped at 50% of the $9,000 gap)
 *
 * The thresholds are fixed in statute (not indexed) — see the constants above.
 */
export function taxableSocialSecurityCents(
  benefitCents: Cents,
  otherProvisionalIncomeCents: Cents,
): Cents {
  const benefit = Math.max(0, benefitCents);
  if (benefit === 0) return 0;
  const provisional = Math.max(0, otherProvisionalIncomeCents) + benefit * SS_TIER_1_SHARE;

  if (provisional <= SS_TIER_1_THRESHOLD_CENTS) return 0;

  if (provisional <= SS_TIER_2_THRESHOLD_CENTS) {
    return Math.round(
      Math.min(benefit * SS_TIER_1_SHARE, (provisional - SS_TIER_1_THRESHOLD_CENTS) * SS_TIER_1_SHARE),
    );
  }

  // Above the second threshold: 85% of the excess over $34,000, plus the smaller of
  // the tier-1 fill (½ of the $9,000 gap → $4,500) or 50% of the benefit.
  const tierGapFill = Math.min(
    benefit * SS_TIER_1_SHARE,
    (SS_TIER_2_THRESHOLD_CENTS - SS_TIER_1_THRESHOLD_CENTS) * SS_TIER_1_SHARE,
  );
  const taxable = (provisional - SS_TIER_2_THRESHOLD_CENTS) * SS_MAX_SHARE + tierGapFill;
  return Math.round(Math.min(benefit * SS_MAX_SHARE, taxable));
}

/** Progressive tax on `taxableCents` through the ascending marginal `brackets`. */
function ordinaryTaxCents(taxableCents: Cents, brackets: readonly OrdinaryBracket[]): Cents {
  const taxable = Math.max(0, taxableCents);
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const lower = brackets[i].lowerCents;
    if (taxable <= lower) break;
    const upper = i + 1 < brackets.length ? brackets[i + 1].lowerCents : Infinity;
    const bandTop = Math.min(taxable, upper);
    tax += (bandTop - lower) * brackets[i].rate;
  }
  return tax;
}

/**
 * Preferential long-term capital-gains tax on `gainsTaxableCents`, STACKED on top
 * of `ordinaryTaxableCents`: the gains fill the 0/15/20% bands that remain ABOVE
 * ordinary taxable income, so a high ordinary income pushes gains into the 15/20%
 * bands even when the gains alone would sit in the 0% band.
 */
function capitalGainsTaxCents(
  ordinaryTaxableCents: Cents,
  gainsTaxableCents: Cents,
  zeroTopCents: Cents,
  fifteenTopCents: Cents,
): Cents {
  const ordinary = Math.max(0, ordinaryTaxableCents);
  const gains = Math.max(0, gainsTaxableCents);
  if (gains === 0) return 0;
  const top = ordinary + gains;

  // Gains sitting below the 0% top pay nothing; the 15% band runs to its top; the
  // rest is 20%. Each band is the slice of [ordinary, top] inside that band.
  const zeroBand = Math.max(0, Math.min(top, zeroTopCents) - ordinary);
  const fifteenBand = Math.max(0, Math.min(top, fifteenTopCents) - Math.max(ordinary, zeroTopCents));
  const twentyBand = gains - zeroBand - fifteenBand;
  return fifteenBand * LTCG_RATE_15 + twentyBand * LTCG_RATE_20;
}

/**
 * The two rate-regime pieces of a single-filer annual tax computation plus the
 * per-category weights the attribution ({@link federalAnnualTaxByCategoryCents})
 * splits each piece across. Kept as ONE internal so {@link federalAnnualTaxCents}
 * (scalar) and the by-category attribution can never drift: the scalar is exactly
 * `round(ordinaryTaxCents + gainsTaxCents)` and the attribution reuses the same
 * intermediate figures, so the split provably sums back to the scalar.
 */
export interface FederalTaxParts {
  /** Progressive ordinary tax on wages + other ordinary income + the included benefit slice (float). */
  readonly ordinaryTaxCents: number;
  /** Preferential capital-gains tax on the taxable gains slice, stacked on ordinary (float). */
  readonly gainsTaxCents: number;
  /** Rounded scalar total — identical to what {@link federalAnnualTaxCents} returns. */
  readonly totalCents: Cents;
  /**
   * The ordinary-taxable weight each ordinary category contributed, BEFORE the
   * standard deduction (which reduces every contributor's share proportionally):
   * `wages`, `ordinaryIncome`, and the taxable portion of the government benefit.
   * These weight how {@link ordinaryTaxCents} is divided among the three.
   */
  readonly ordinaryWeights: {
    readonly wages: number;
    readonly ordinaryIncome: number;
    readonly governmentRetirementBenefit: number;
  };
}

/**
 * The shared core both the scalar seam and the per-category attribution read. Runs
 * the four pieces once — government-benefit inclusion → ordinary brackets (after the
 * standard deduction) → capital-gains preference — and returns the two rate-regime
 * tax figures, their rounded sum, and the ordinary-taxable weights.
 */
export function federalTaxParts(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): FederalTaxParts {
  const tables = federalTaxTables(year);
  const wages = Math.max(0, annualByCategory.wages ?? 0);
  const ordinaryOther = Math.max(0, annualByCategory.ordinaryIncome ?? 0);
  const gains = Math.max(0, annualByCategory.capitalGains ?? 0);
  const benefit = Math.max(0, annualByCategory.governmentRetirementBenefit ?? 0);
  const taxExempt = Math.max(0, annualByCategory.taxExempt ?? 0);

  const ordinaryNonBenefit = wages + ordinaryOther;

  // 1. Government-benefit inclusion. Provisional income is all other income that
  //    reaches AGI (ordinary + capital gains) plus tax-exempt interest — the last
  //    is never taxed itself but still counts toward the benefit test (§5.4).
  const taxableBenefit = taxableSocialSecurityCents(benefit, ordinaryNonBenefit + gains + taxExempt);

  // 2. Standard deduction: off ordinary income first, remainder off capital gains.
  const ordinaryTaxableGross = ordinaryNonBenefit + taxableBenefit;
  const deduction = tables.standardDeductionCents;
  const ordinaryTaxable = Math.max(0, ordinaryTaxableGross - deduction);
  const deductionRemainder = Math.max(0, deduction - ordinaryTaxableGross);
  const gainsTaxable = Math.max(0, gains - deductionRemainder);

  // 3. Ordinary brackets on ordinary taxable; 4. preferential rates on the gains,
  //    stacked on top of ordinary taxable income.
  const ordinaryTax = ordinaryTaxCents(ordinaryTaxable, tables.ordinaryBrackets);
  const gainsTax = capitalGainsTaxCents(
    ordinaryTaxable,
    gainsTaxable,
    tables.capitalGainsZeroTopCents,
    tables.capitalGainsFifteenTopCents,
  );

  return {
    ordinaryTaxCents: ordinaryTax,
    gainsTaxCents: gainsTax,
    totalCents: Math.round(ordinaryTax + gainsTax),
    // The included benefit slice — not the whole benefit — is what actually enters
    // the ordinary base, so it (not the gross benefit) is the attribution weight.
    ordinaryWeights: { wages, ordinaryIncome: ordinaryOther, governmentRetirementBenefit: taxableBenefit },
  };
}

/**
 * The pure ANNUAL single-filer federal income tax for a map of per-category taxable
 * amounts (annual cents). Orchestrates the four pieces: government-benefit
 * inclusion → ordinary brackets (after the standard deduction) → capital-gains
 * preference (deduction remainder stacked down onto gains, gains stacked up onto
 * ordinary). The monthly engine seam is {@link computeFederalTaxCents}.
 */
export function federalAnnualTaxCents(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  return federalTaxParts(annualByCategory, year).totalCents;
}

/**
 * The engine's §5.3 tax seam for the US single filer: MONTHLY per-category taxable
 * amounts in → this month's tax in cents out. Brackets are annual, so the monthly
 * slice is annualized (×12), taxed, and the month's 1/12 share returned — the
 * steady-state withholding approximation the projection runs each month. This is
 * the only entry point `index.ts` wires into {@link usJurisdiction}.
 */
export function computeFederalTaxCents(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Cents {
  return Math.round(federalAnnualTaxCents(annualizeByCategory(monthlyByCategory), year) / 12);
}
