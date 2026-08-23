import type { Cents, ModelAssumption } from "@finley/engine";

/**
 * US federal PAYROLL tax (FICA), SINGLE FILER — the rate-and-threshold tables, the
 * per-employer PAYCHECK WITHHOLDING computation, and the annual RECONCILIATION the return
 * performs over it. This is the `rules`-side data behind the engine's payroll seams, which
 * charge tax on EARNED income (wages / self-employment), distinct from the income-tax seam in
 * {@link federalTax}.
 *
 * Three components, employee side only (the employer's matching half is never charged to the
 * worker, so it is never added here):
 *   • OASDI (Social Security) — 6.2% up to an annual taxable maximum; nothing above.
 *   • Medicare — 1.45% on ALL earned income, no cap.
 *   • Additional Medicare — 0.9% surtax past a fixed statutory threshold; employee-only.
 *
 * WITHHOLDING IS PER EMPLOYER, AND THAT IS NOT THE SAME AS WHAT IS OWED. Real payroll applies
 * the wage base and the surtax threshold to the wages IT paid, knowing nothing about the
 * worker's other jobs, which is what {@link payrollWithholdingParts} models. The two components
 * whose annual truth is a COMBINED figure are then squared up on the return
 * ({@link payrollTaxReconciliationCents}) — a real filing step, not a modelling convenience,
 * and the reason a job change or a second job produces an April adjustment here.
 *
 * NEUTRALITY: every US constant lives HERE, never in `packages/engine/src`.
 *
 * ⚠ Estimates, not advice. Dollar figures are the pinned {@link PAYROLL_TAX_BASE_YEAR} base;
 * later years index forward (the wage base by WAGE growth, see {@link AWI_ANNUAL_INDEXING_RATE}),
 * earlier years return the base unchanged.
 */

export const PAYROLL_TAX_BASE_YEAR = 2026;

/**
 * Employee-share statutory rates. The employer matches OASDI and Medicare, but the plan
 * charges only the worker's own share, so the employer half is never added here.
 * Rates are legislation-set and held constant across years — only the wage base moves.
 */
export const OASDI_RATE = 0.062;
export const MEDICARE_RATE = 0.0145;
/** No employer match on the surtax, so this is the whole rate the worker bears. */
export const ADDITIONAL_MEDICARE_RATE = 0.009;

/** SSA 2026 OASDI taxable maximum (a multiple of the $300 statutory rounding increment). */
const BASE_OASDI_WAGE_BASE_CENTS: Cents = 184_500_00;

/**
 * The OASDI taxable maximum indexes to the national Average Wage Index, NOT CPI. AWI has
 * historically outrun CPI by the economy's real wage growth, so reusing the income-tax
 * side's CPI proxy would let the cap drift progressively too low and over-tax high earners
 * further into a decades-long projection — a compounding error, not a rounding one. This
 * rate is the wage-growth stand-in, deliberately higher than {@link federalTax}'s CPI proxy.
 * ⚠ Actual AWI is a published per-year series and will differ.
 */
const AWI_ANNUAL_INDEXING_RATE = 0.035;

/**
 * Additional Medicare threshold (single), fixed in statute since 2013 and — unlike the wage
 * base — NEVER indexed. Held flat across every year, mirroring the Social-Security
 * benefit-inclusion thresholds in {@link federalTaxTables}. As earned income grows, more of
 * it crosses this frozen line over time.
 *
 * ONE threshold, TWO meanings, which is why {@link payrollTaxReconciliationCents} exists: an
 * employer applies it to the wages it alone paid (and is in fact forbidden to consider any
 * other), while the worker owes the surtax on their COMBINED wages above the same figure.
 */
export const ADDITIONAL_MEDICARE_THRESHOLD_CENTS: Cents = 200_000_00;

/** SSA rounds the wage base to a multiple of $300. */
const ROUND_300_CENTS: Cents = 300_00;

/**
 * Index the wage base forward to `year` at the AWI rate, rounded to the NEAREST
 * `incrementCents` — the statutory rule. Years at or before the base year return it
 * UNCHANGED — no backward indexing, so the pinned anchor stays cent-exact.
 *
 * Nearest-rounding stays monotonically non-decreasing here without any downward bias: one
 * year of AWI growth on the wage base is thousands of dollars, an order of magnitude past the
 * $300 increment, so the at-most-half-increment jitter can never outrun a year's growth.
 */
function indexWageBaseForward(baseCents: Cents, year: number, incrementCents: Cents): Cents {
  const years = year - PAYROLL_TAX_BASE_YEAR;
  if (years <= 0) return baseCents;
  const indexed = baseCents * Math.pow(1 + AWI_ANNUAL_INDEXING_RATE, years);
  return Math.round(indexed / incrementCents) * incrementCents;
}

/** Single-filer payroll-tax tables for one year; only the wage base is indexed. */
export interface PayrollTaxTables {
  readonly year: number;
  readonly oasdiWageBaseCents: Cents;
  readonly oasdiRate: number;
  readonly medicareRate: number;
  readonly additionalMedicareRate: number;
  readonly additionalMedicareThresholdCents: Cents;
}

/**
 * {@link PAYROLL_TAX_BASE_YEAR} figures resolved for `year`. The wage base grows by AWI; the
 * rates and the Additional Medicare threshold are held flat.
 */
export function payrollTaxTables(year: number): PayrollTaxTables {
  return {
    year,
    oasdiWageBaseCents: indexWageBaseForward(BASE_OASDI_WAGE_BASE_CENTS, year, ROUND_300_CENTS),
    oasdiRate: OASDI_RATE,
    medicareRate: MEDICARE_RATE,
    additionalMedicareRate: ADDITIONAL_MEDICARE_RATE,
    additionalMedicareThresholdCents: ADDITIONAL_MEDICARE_THRESHOLD_CENTS,
  };
}

/** The three employee-side payroll components for a year, plus their sum. */
export interface PayrollTaxParts {
  readonly oasdiCents: Cents;
  readonly medicareCents: Cents;
  readonly additionalMedicareCents: Cents;
  readonly totalCents: Cents;
}

/**
 * Employee-side FICA WITHHELD from wages paid by ONE employer, given that employer's cumulative
 * year-to-date wages for the person. Every real payroll system computes exactly this, and it is
 * the only figure a paycheck can carry: an employer knows its own wages and nothing else.
 *
 * The engine feeds the cumulative total and charges the DIFFERENCE month to month, so each
 * capped or banded component binds on the running total rather than on an annualized monthly
 * slice — a level earner is unaffected either way, a lumpy one would be mis-capped every month.
 * Monotone non-decreasing in `employerCumulativeWagesCents`, so that difference is never a credit.
 *
 * WHERE THIS DIFFERS FROM WHAT IS OWED, and why the difference is correct rather than a bug:
 *
 *  • OASDI stops at the wage base for THIS employer. A person with two jobs, or one who changes
 *    jobs mid-year, therefore has the base applied twice and can have more Social Security
 *    withheld than they owe. That is what really happens; the excess comes back as a credit on
 *    the return ({@link payrollTaxReconciliationCents}), not as a smaller paycheck deduction.
 *  • Additional Medicare is withheld on THIS employer's wages past the threshold. An employer is
 *    required to ignore the employee's other wages, so a two-job worker over the threshold in
 *    total but under it at each job has none withheld — and squares up on Form 8959 instead.
 *  • Medicare itself is uncapped and so never needs reconciling: it is the same 1.45% whether
 *    read per employer or combined.
 *
 * Negative wages are clamped to zero at the boundary: there is no such thing as negative payroll
 * tax, so malformed input yields no charge rather than a credit against other tax.
 */
export function payrollWithholdingParts(
  employerCumulativeWagesCents: Cents,
  year: number,
): PayrollTaxParts {
  const t = payrollTaxTables(year);
  const wagesCents = Math.max(0, employerCumulativeWagesCents);
  const oasdiCents = Math.round(Math.min(wagesCents, t.oasdiWageBaseCents) * t.oasdiRate);
  const medicareCents = Math.round(wagesCents * t.medicareRate);
  const surtaxBase = Math.max(0, wagesCents - t.additionalMedicareThresholdCents);
  const additionalMedicareCents = Math.round(surtaxBase * t.additionalMedicareRate);
  return {
    oasdiCents,
    medicareCents,
    additionalMedicareCents,
    totalCents: oasdiCents + medicareCents + additionalMedicareCents,
  };
}

/** Scalar total behind {@link payrollWithholdingParts} — one employer's cumulative FICA withheld. */
export function payrollWithholdingCents(employerCumulativeWagesCents: Cents, year: number): Cents {
  return payrollWithholdingParts(employerCumulativeWagesCents, year).totalCents;
}

/**
 * The FICA adjustment the RETURN makes over a year of per-employer withholding — signed, positive
 * owed, negative refunded. `wagesByEmployerCents` is each employer's whole-year wages for one
 * person; the order does not matter and a single-employer year always reconciles to exactly zero.
 *
 * Only the two components whose annual truth is a COMBINED figure appear here, and each is a real
 * line on a real return rather than a tidying-up of the model:
 *
 *  • EXCESS SOCIAL SECURITY (Schedule 3) — withholding applied the wage base once per employer, so
 *    a person with two jobs can be over the single combined cap. Whatever was withheld above
 *    `wageBase × 6.2%` is a refundable credit. Never a debit: an employer that under-withheld
 *    OASDI owes it itself, and the employee is not billed for it on their return.
 *  • ADDITIONAL MEDICARE (Form 8959) — the 0.9% surtax is owed on combined wages past the
 *    threshold but was withheld on each employer's wages past it separately. The difference goes
 *    either way: a two-job worker over the line only in aggregate owes the whole surtax in April,
 *    and a single-job worker who also crossed it gets nothing back because there is nothing to
 *    correct.
 *
 * Ordinary Medicare is deliberately absent — uncapped and unbanded, it needs no reconciliation,
 * and putting it through one would move cash between months for no reason in the tax law.
 */
export function payrollTaxReconciliationCents(
  wagesByEmployerCents: readonly Cents[],
  year: number,
): Cents {
  const t = payrollTaxTables(year);
  const wages = wagesByEmployerCents.map((w) => Math.max(0, w));

  const oasdiWithheldCents = wages.reduce(
    (sum, w) => sum + Math.round(Math.min(w, t.oasdiWageBaseCents) * t.oasdiRate),
    0,
  );
  const oasdiOwedCents = Math.round(
    Math.min(
      wages.reduce((sum, w) => sum + w, 0),
      t.oasdiWageBaseCents,
    ) * t.oasdiRate,
  );
  const excessOasdiCreditCents = Math.max(0, oasdiWithheldCents - oasdiOwedCents);

  const combinedWagesCents = wages.reduce((sum, w) => sum + w, 0);
  const surtaxOwedCents = Math.round(
    Math.max(0, combinedWagesCents - t.additionalMedicareThresholdCents) *
      t.additionalMedicareRate,
  );
  const surtaxWithheldCents = wages.reduce(
    (sum, w) =>
      sum +
      Math.round(
        Math.max(0, w - t.additionalMedicareThresholdCents) * t.additionalMedicareRate,
      ),
    0,
  );

  return surtaxOwedCents - surtaxWithheldCents - excessOasdiCreditCents;
}

/**
 * User-facing disclosures for this module's payroll-tax simplifications — the `rules` side of
 * {@link import("@finley/engine").Jurisdiction.modelAssumptions}, co-located by `id` with the
 * code they describe. Exported for the engine payroll seam to concatenate onto the jurisdiction
 * once it charges FICA; kept out of the live `usJurisdiction` set until then so the report never
 * discloses a tax the model is not yet applying.
 */
export const PAYROLL_TAX_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: "payrollTaxPerEmployerWithholding",
    text:
      "Social Security and Medicare (FICA) are taken out of each paycheck the way a real " +
      "employer takes them: each job applies the Social Security wage cap and the Additional " +
      "Medicare threshold to the wages that job alone paid, because an employer is not allowed " +
      "to look at your other jobs. If you hold two jobs, or change jobs mid-year, that can " +
      "withhold more Social Security than you actually owe — the excess comes back as a credit " +
      "when you file, in April of the following year, exactly as it does in real life. The " +
      "0.9% Additional Medicare Tax is squared up the same way, and can go either direction.",
  },
  {
    id: "oasdiWageBaseWageIndexed",
    text:
      "The Social-Security wage cap — the ceiling above which the 6.2% Social-Security tax " +
      "stops (Medicare's 1.45% continues) — is grown forward at an assumed 3.5%/yr. That is " +
      "faster than the rate used for the income-tax brackets, because this cap by law tracks " +
      "average WAGES, which tend to rise faster than prices. Using the slower price rate would " +
      "let the cap fall behind over a long plan and overstate the Social-Security tax on higher " +
      "earners. The actual cap is announced each year and will differ.",
  },
  {
    id: "additionalMedicareThresholdUnindexed",
    text:
      "The $200,000 income level where the extra 0.9% Additional Medicare Tax kicks in is " +
      "frozen — held flat in every year — because it is fixed in statute and has never been " +
      "adjusted for inflation. As earnings grow, more of them fall above this line over time.",
  },
];
