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

/**
 * Neutral core of the single-filer federal tax computation: the shared rate math
 * (government-benefit inclusion, ordinary brackets, capital-gains preference) and the
 * {@link federalTaxParts} intermediate that BOTH the scalar seam
 * ({@link import("./federalTax").federalAnnualTaxCents}) and the per-category attribution
 * ({@link import("./federalTaxAttribution").federalAnnualTaxByCategoryCents}) read. Depends
 * only on the legislated tables and imports neither sibling, so both seams share one
 * source of truth.
 */

/**
 * Taxable portion of a US government retirement benefit (Social Security) for a SINGLE filer,
 * from the provisional-income formula. `otherProvisionalIncomeCents` is everything else
 * counting toward provisional income (ordinary + capital gains + tax-exempt), NOT the benefit
 * itself; half the benefit is added here to form provisional income, then:
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

  // Tier-1 fill: ½ of the $9,000 gap → $4,500, or 50% of the benefit if smaller.
  const tierGapFill = Math.min(
    benefit * SS_TIER_1_SHARE,
    (SS_TIER_2_THRESHOLD_CENTS - SS_TIER_1_THRESHOLD_CENTS) * SS_TIER_1_SHARE,
  );
  const taxable = (provisional - SS_TIER_2_THRESHOLD_CENTS) * SS_MAX_SHARE + tierGapFill;
  return Math.round(Math.min(benefit * SS_MAX_SHARE, taxable));
}

/**
 * The four bases the US single-filer computation actually runs on, summed from an arbitrary
 * {@link TaxCategory} map. Negative entries are floored at zero per category.
 */
interface TaxableBases {
  /** Wages — ordinary, and its own attribution weight. */
  wages: Cents;
  /** Non-wage ordinary income: interest, pre-tax withdrawals, everything ordinary but not paid. */
  ordinaryIncome: Cents;
  /** Realized long-term gains, priced at the preferential rates. */
  capitalGains: Cents;
  /** Gross government benefit; only the included slice reaches the brackets. */
  governmentRetirementBenefit: Cents;
  /** Exempt INTEREST: never taxed, but statutorily added back to provisional income. */
  taxExempt: Cents;
}

/**
 * Sort every category in `annualByCategory` into the base it belongs to.
 *
 * EXHAUSTIVE by construction: the `default` arm assigns to `never`, so adding a
 * {@link TaxCategory} fails to compile here until someone decides what it costs. That is the
 * whole point of the switch — a lookup-by-name would silently drop an unrecognised category,
 * which for a tax computation means income that vanishes with nothing raising a hand. Untaxed
 * categories are listed and fall through to no base, so "bears no tax" is a decision on the
 * record rather than an omission.
 */
function taxableBases(annualByCategory: Partial<Record<TaxCategory, Cents>>): TaxableBases {
  const bases: TaxableBases = {
    wages: 0,
    ordinaryIncome: 0,
    capitalGains: 0,
    governmentRetirementBenefit: 0,
    taxExempt: 0,
  };
  for (const [key, value] of Object.entries(annualByCategory)) {
    const category = key as TaxCategory;
    const cents = Math.max(0, value ?? 0);
    switch (category) {
      case "wages":
      case "ordinaryIncome":
      case "capitalGains":
      case "governmentRetirementBenefit":
      case "taxExempt":
        bases[category] += cents;
        break;
      // Bear no tax and enter no base, for two different reasons: `taxedAtAccrual` is a return of
      // principal whose interest was already taxed as `ordinaryIncome` in the year it was
      // credited (taxing it again here would double-count it, and adding it to provisional income
      // would double-count it in the benefit test); `borrow` is loan proceeds, never income.
      case "taxedAtAccrual":
      case "borrow":
        break;
      default: {
        const unhandled: never = category;
        throw new Error(`Unhandled tax category: ${String(unhandled)}`);
      }
    }
  }
  return bases;
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
 * Preferential long-term capital-gains tax on `gainsTaxableCents`, STACKED on top of
 * `ordinaryTaxableCents`: gains fill the 0/15/20% bands remaining ABOVE ordinary taxable
 * income, so a high ordinary income pushes gains into 15/20% even when the gains alone
 * would sit in the 0% band.
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

  // Each band is the slice of [ordinary, top] inside it; below the 0% top pays nothing.
  const zeroBand = Math.max(0, Math.min(top, zeroTopCents) - ordinary);
  const fifteenBand = Math.max(0, Math.min(top, fifteenTopCents) - Math.max(ordinary, zeroTopCents));
  const twentyBand = gains - zeroBand - fifteenBand;
  return fifteenBand * LTCG_RATE_15 + twentyBand * LTCG_RATE_20;
}

/**
 * The two rate-regime pieces of a single-filer annual tax plus the per-category weights the
 * attribution ({@link import("./federalTaxAttribution").federalAnnualTaxByCategoryCents})
 * splits each across. ONE internal so the two seams cannot drift: the scalar is exactly
 * `round(ordinaryTaxCents + gainsTaxCents)`, and the attribution reuses these same figures,
 * so the split provably sums back to it.
 */
export interface FederalTaxParts {
  /** Progressive ordinary tax on wages + other ordinary income + the included benefit slice (float). */
  readonly ordinaryTaxCents: number;
  /** Preferential capital-gains tax on the taxable gains slice, stacked on ordinary (float). */
  readonly gainsTaxCents: number;
  /** Rounded scalar total — identical to what {@link import("./federalTax").federalAnnualTaxCents} returns. */
  readonly totalCents: Cents;
  /**
   * Each ordinary category's contribution to ordinary taxable income BEFORE the standard
   * deduction, which reduces every contributor's share proportionally.
   */
  readonly ordinaryWeights: {
    readonly wages: number;
    readonly ordinaryIncome: number;
    readonly governmentRetirementBenefit: number;
  };
}

/**
 * Runs the pieces once: benefit inclusion → ordinary brackets (after the standard
 * deduction) → capital-gains preference.
 */
export function federalTaxParts(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): FederalTaxParts {
  const tables = federalTaxTables(year);
  const {
    wages,
    ordinaryIncome: ordinaryOther,
    capitalGains: gains,
    governmentRetirementBenefit: benefit,
    taxExempt,
  } = taxableBases(annualByCategory);

  const ordinaryNonBenefit = wages + ordinaryOther;

  // 1. Government-benefit inclusion. Provisional income is all other income reaching AGI
  //    (ordinary + capital gains) plus tax-exempt interest — never taxed itself, but it
  //    still counts toward the benefit test.
  //
  //    Cash interest DOES belong here, and reaches it as `ordinaryIncome` in the year it is
  //    credited — the 1099-INT. What stays out is the later DRAWDOWN of that balance
  //    (`taxedAtAccrual`), which is the same money a second time: principal the household has
  //    finished paying tax on. Counting both would test one dollar of interest twice.
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
    // Only the included benefit slice enters the ordinary base, so it — not the gross
    // benefit — is the weight.
    ordinaryWeights: { wages, ordinaryIncome: ordinaryOther, governmentRetirementBenefit: taxableBenefit },
  };
}
