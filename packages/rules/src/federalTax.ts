import type { Cents, TaxCategory, ModelAssumption } from "@finley/engine";

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

// ── Legislated base-year constants (one place, disclaimed — §5.4) ──────────────
//
// Single-filer figures pinned to 2026 (projected inflation-adjusted brackets,
// standard deduction, and long-term capital-gains bracket tops). Sources are the
// published IRS inflation adjustments / Tax Foundation 2026 projections. Every
// dollar figure below is authoritative for {@link FEDERAL_TAX_BASE_YEAR} and
// indexed forward by {@link ASSUMED_ANNUAL_INDEXING_RATE} for later years.

/** The calendar year the pinned dollar figures below are authoritative for. */
export const FEDERAL_TAX_BASE_YEAR = 2026;

/** Single-filer standard deduction, 2026 base. */
const BASE_STANDARD_DEDUCTION_CENTS: Cents = 16_100_00;

/**
 * Single-filer ordinary-income brackets, 2026 base — each is the LOWER edge of the
 * band (cents) and the marginal `rate` that applies above it, ascending. The last
 * entry has no upper edge (top marginal rate). Rates are TCJA-era and legislation-
 * set; only the thresholds index forward.
 */
const BASE_ORDINARY_BRACKETS: readonly OrdinaryBracket[] = [
  { lowerCents: 0, rate: 0.1 },
  { lowerCents: 12_400_00, rate: 0.12 },
  { lowerCents: 50_400_00, rate: 0.22 },
  { lowerCents: 105_700_00, rate: 0.24 },
  { lowerCents: 201_775_00, rate: 0.32 },
  { lowerCents: 256_225_00, rate: 0.35 },
  { lowerCents: 640_600_00, rate: 0.37 },
];

/** Top of the 0% long-term capital-gains bracket (single), 2026 base. */
const BASE_LTCG_ZERO_TOP_CENTS: Cents = 49_450_00;
/** Top of the 15% long-term capital-gains bracket (single), 2026 base; above it is 20%. */
const BASE_LTCG_FIFTEEN_TOP_CENTS: Cents = 545_050_00;
/** Preferential long-term capital-gains rates for the two taxed bands. */
const LTCG_RATE_15 = 0.15;
const LTCG_RATE_20 = 0.2;

// ── Social Security inclusion thresholds (single) — NOT indexed by law ─────────
//
// The $25,000 / $34,000 provisional-income thresholds have been FIXED in statute
// since 1984/1993 (never inflation-adjusted), so — unlike the brackets — they are
// deliberately held flat across all years. The share caps (50% / 85%) are the two
// inclusion ceilings the formula steps between.

/** First provisional-income threshold: below it, no benefit is taxable (single). */
const SS_TIER_1_THRESHOLD_CENTS: Cents = 25_000_00;
/** Second provisional-income threshold: above it, up to 85% is taxable (single). */
const SS_TIER_2_THRESHOLD_CENTS: Cents = 34_000_00;
/** Lower inclusion share, applied in the first tier and to the tier gap. */
const SS_TIER_1_SHARE = 0.5;
/** Upper inclusion ceiling — the most of a benefit that can ever be taxed. */
const SS_MAX_SHARE = 0.85;

// ── Forward indexing (mirrors contributionLimits / healthCosts) ────────────────

/**
 * Assumed forward CPI indexing rate for the brackets, standard deduction, and
 * cap-gains tops. Real figures are indexed to inflation and rounded to a
 * legislated increment; the seam context has no year-by-year rate, so this rules-
 * side estimate stands in. ⚠ Estimate — actual indexing is published yearly.
 */
const ASSUMED_ANNUAL_INDEXING_RATE = 0.025;

/** IRS rounding increment for bracket thresholds, the deduction, and cap-gains tops. */
const ROUND_50_CENTS: Cents = 50_00;

/**
 * Index a base-year figure forward to `year`, rounded DOWN to `incrementCents`.
 * Years at or before the base year return the base UNCHANGED — no backward
 * indexing, so the pinned base-year anchors stay cent-exact. Rounding down keeps
 * the result monotonically non-decreasing as the year advances (mirrors
 * `contributionLimits.indexForward` / `healthCosts.indexForward`).
 */
function indexForward(baseCents: Cents, year: number, incrementCents: Cents): Cents {
  const years = year - FEDERAL_TAX_BASE_YEAR;
  if (years <= 0) return baseCents;
  const indexed = baseCents * Math.pow(1 + ASSUMED_ANNUAL_INDEXING_RATE, years);
  return Math.floor(indexed / incrementCents) * incrementCents;
}

/** A single ordinary-income bracket: the lower edge (cents) and its marginal rate. */
export interface OrdinaryBracket {
  readonly lowerCents: Cents;
  readonly rate: number;
}

/** The full structured single-filer tax tables for a year (§5.4 pattern). */
export interface FederalTaxTables {
  readonly year: number;
  /** Standard deduction (single), indexed to `year`. */
  readonly standardDeductionCents: Cents;
  /** Ordinary brackets (single), lower-edge + marginal rate, ascending, indexed to `year`. */
  readonly ordinaryBrackets: readonly OrdinaryBracket[];
  /** Top of the 0% long-term capital-gains bracket, indexed to `year`. */
  readonly capitalGainsZeroTopCents: Cents;
  /** Top of the 15% long-term capital-gains bracket, indexed to `year`. */
  readonly capitalGainsFifteenTopCents: Cents;
}

/**
 * The single-filer tax tables for `year`: the pinned base-year figures
 * ({@link FEDERAL_TAX_BASE_YEAR}) indexed forward. Rates are held; only the
 * dollar thresholds move.
 */
export function federalTaxTables(year: number): FederalTaxTables {
  return {
    year,
    standardDeductionCents: indexForward(BASE_STANDARD_DEDUCTION_CENTS, year, ROUND_50_CENTS),
    ordinaryBrackets: BASE_ORDINARY_BRACKETS.map((b) => ({
      lowerCents: indexForward(b.lowerCents, year, ROUND_50_CENTS),
      rate: b.rate,
    })),
    capitalGainsZeroTopCents: indexForward(BASE_LTCG_ZERO_TOP_CENTS, year, ROUND_50_CENTS),
    capitalGainsFifteenTopCents: indexForward(BASE_LTCG_FIFTEEN_TOP_CENTS, year, ROUND_50_CENTS),
  };
}

/**
 * User-facing disclosures for the federal-tax simplifications this module makes — the
 * `rules` side of the engine's {@link import("@finley/engine").Jurisdiction.modelAssumptions}
 * seam, co-located by `id` with the code they describe ({@link indexForward} /
 * {@link taxableSocialSecurityCents}), exactly as the engine co-locates its own
 * {@link import("@finley/engine").MODEL_ASSUMPTIONS}. `usJurisdiction` hands these to the
 * report so the "assumptions & simplifications" surface explains why a threshold moves
 * (or doesn't) year to year. ⚠ Estimates, not advice.
 */
export const FEDERAL_TAX_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: "taxThresholdForwardIndexing",
    text:
      "Federal tax figures — the income-tax brackets, the standard deduction, and the " +
      "0%/15% capital-gains thresholds — are grown forward at an assumed 2.5%/yr (a flat " +
      "stand-in for the IRS's yearly inflation adjustment), not the plan's own inflation " +
      "rate, and then rounded down to the nearest $50 to mirror the way the tax code " +
      "publishes these figures. The tax rates themselves are held constant. Actual figures " +
      "are legislated and published each year and will differ.",
  },
  {
    id: "socialSecurityThresholdsUnindexed",
    text:
      "The income levels that decide how much of your Social Security is taxable " +
      "($25,000 / $34,000 for a single filer) are frozen — held flat in every year — " +
      "because they are fixed in statute and, unlike the tax brackets, have never been " +
      "adjusted for inflation. As other income grows, this means more of your benefit " +
      "becomes taxable over time.",
  },
];

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
interface FederalTaxParts {
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
function federalTaxParts(
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
 * Distribute an integer-cents `totalCents` across `entries` (each a `[category,
 * weight]` pair) IN PROPORTION to the weights, with every share an integer cent and
 * Σ shares === `totalCents` exactly (largest-remainder apportionment: floor each
 * share, then hand the leftover cents to the largest fractional remainders). Zero-
 * weight and zero-share categories are omitted, so the map carries only bands worth
 * drawing. The exact-sum guarantee is what lets the attribution honour the AC
 * "total still equals `computeTaxCents`".
 */
function apportionByWeight(
  totalCents: Cents,
  entries: readonly (readonly [TaxCategory, number])[],
): Partial<Record<TaxCategory, Cents>> {
  const weightSum = entries.reduce((s, [, w]) => s + w, 0);
  if (totalCents <= 0 || weightSum <= 0) return {};

  const shares: { category: TaxCategory; whole: Cents; remainder: number }[] = [];
  let allocated = 0;
  for (const [category, weight] of entries) {
    const exact = (totalCents * weight) / weightSum;
    const whole = Math.floor(exact);
    allocated += whole;
    shares.push({ category, whole, remainder: exact - whole });
  }
  // Hand out the leftover cents, biggest fractional remainder first.
  let leftover = totalCents - allocated;
  shares.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; leftover > 0; i = (i + 1) % shares.length, leftover--) shares[i]!.whole += 1;

  const out: Partial<Record<TaxCategory, Cents>> = {};
  for (const { category, whole } of shares) if (whole > 0) out[category] = whole;
  return out;
}

/**
 * Split a `totalCents` federal-tax figure across the {@link TaxCategory} buckets that
 * bore it, given the computed {@link FederalTaxParts}. ATTRIBUTION METHOD (§5.3, issue
 * #110) — regime-aware proportional-to-taxable:
 *
 *   • The preferential **capital-gains** tax rides the `capitalGains` bucket alone, so
 *     the split respects that gains are taxed at their own 0/15/20% rates rather than
 *     an averaged blend (the interaction #100 turned on).
 *   • The progressive **ordinary** tax is divided among `wages`, `ordinaryIncome`, and
 *     `governmentRetirementBenefit` in proportion to each one's ordinary-taxable weight
 *     (the benefit weighted by its INCLUDED portion only), so the standard deduction
 *     and the bracket climb are shared pro-rata across the ordinary contributors.
 *   • `taxExempt` never bears tax (it is never taxed, only counted for the benefit test).
 *
 * ⚠ LIMITATION (documented, mirrors the withdrawal-seam monotonicity caveat): this is an
 * average-rate attribution WITHIN the ordinary regime — it cannot perfectly capture that
 * the LAST dollar of one category sits in a higher bracket than the first, nor the
 * notch/inclusion effects (a marginal dollar of ordinary income can raise the taxable
 * benefit or push gains out of the 0% band). The split is exact in TOTAL, defensible
 * per bucket, and honest about not being a marginal-incidence decomposition.
 */
function attributeFederalTax(
  totalCents: Cents,
  parts: FederalTaxParts,
): Partial<Record<TaxCategory, Cents>> {
  const w = parts.ordinaryWeights;
  const ordinaryWeightSum = w.wages + w.ordinaryIncome + w.governmentRetirementBenefit;
  const entries: [TaxCategory, number][] = [];
  // Weight each category by the TAX it bore: the ordinary tax split pro-rata by
  // ordinary-taxable weight, the gains tax attributed whole to capital gains.
  if (ordinaryWeightSum > 0) {
    for (const category of ["wages", "ordinaryIncome", "governmentRetirementBenefit"] as const) {
      const taxBorne = (parts.ordinaryTaxCents * w[category]) / ordinaryWeightSum;
      if (taxBorne > 0) entries.push([category, taxBorne]);
    }
  }
  if (parts.gainsTaxCents > 0) entries.push(["capitalGains", parts.gainsTaxCents]);
  return apportionByWeight(totalCents, entries);
}

/**
 * The ANNUAL single-filer federal income tax broken out per {@link TaxCategory}, the
 * per-category analog of {@link federalAnnualTaxCents}. Σ of the returned map equals
 * {@link federalAnnualTaxCents} exactly. See {@link attributeFederalTax} for the
 * attribution method and its limitation. Empty map when no tax is owed.
 */
export function federalAnnualTaxByCategoryCents(
  annualByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Partial<Record<TaxCategory, Cents>> {
  const parts = federalTaxParts(annualByCategory, year);
  return attributeFederalTax(parts.totalCents, parts);
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

/** Annualize a monthly per-category slice (×12) — the input the annual math expects. */
function annualizeByCategory(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
): Partial<Record<TaxCategory, Cents>> {
  const annualByCategory: Partial<Record<TaxCategory, Cents>> = {};
  for (const [category, cents] of Object.entries(monthlyByCategory)) {
    annualByCategory[category as TaxCategory] = (cents ?? 0) * 12;
  }
  return annualByCategory;
}

/**
 * The engine's §5.3 per-category tax seam for the US single filer (issue #110): MONTHLY
 * per-category taxable amounts in → this month's tax split per {@link TaxCategory} out,
 * the per-category analog of {@link computeFederalTaxCents}. Σ of the returned map equals
 * {@link computeFederalTaxCents} for the same slice EXACTLY — the monthly scalar total is
 * apportioned by the annual per-regime weights (the ratios are identical monthly vs.
 * annual), so the breakdown can never disagree with the total the take-home already used.
 * See {@link attributeFederalTax} for the attribution method and its documented limitation.
 * This is the only per-category entry point `index.ts` wires into {@link usJurisdiction}.
 */
export function computeFederalTaxByCategoryCents(
  monthlyByCategory: Partial<Record<TaxCategory, Cents>>,
  year: number,
): Partial<Record<TaxCategory, Cents>> {
  const parts = federalTaxParts(annualizeByCategory(monthlyByCategory), year);
  // Apportion the MONTHLY total (== computeFederalTaxCents) by the annual weights, so
  // Σ(breakdown) === the scalar the waterfall charged, not a separately-rounded figure.
  const monthlyTotal = Math.round(parts.totalCents / 12);
  return attributeFederalTax(monthlyTotal, parts);
}
