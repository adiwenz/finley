import type { Cents, ModelAssumption, WageWithholdingRequest } from "@finley/engine";
import { federalTaxTables, type OrdinaryBracket } from "./federalTaxTables";

/**
 * US federal INCOME-TAX WITHHOLDING on wages, SINGLE FILER — IRS Publication 15-T, Worksheet 1A
 * (Percentage Method Tables for Automated Payroll Systems) plus the supplemental-wage rules of
 * Publication 15 §7.
 *
 * This is the `rules` side of {@link import("@finley/engine").Jurisdiction.computeWageWithholdingCents},
 * and it is a DIFFERENT question from {@link import("./federalTax").federalAnnualTaxCents}. That one
 * prices a whole year of every kind of income and is authoritative. This one answers what a payroll
 * system takes out of ONE paycheck knowing nothing but that paycheck, the employee's Form W-4, and
 * how many paychecks the year holds. The gap between the two is the refund or balance due, which is
 * the entire reason both exist.
 *
 * Two methods, because payroll really uses two:
 *
 *  • REGULAR wages → {@link regularWageWithholdingCents}, the Worksheet 1A annualize-and-price
 *    method. Annualizing is what makes withholding causal: the period's own wage is projected
 *    across the year, so a raise changes this paycheck and no earlier one, and a paycheck that
 *    never arrives withholds nothing rather than being made up later.
 *  • SUPPLEMENTAL wages (a bonus) → {@link supplementalWageWithholdingCents}. Never annualized:
 *    treating a bonus as recurring is exactly the error the flat method exists to avoid.
 *
 * Sitting across both, {@link multipleJobsAdjustmentCents} corrects for the one thing no single
 * employer can see — the person's OTHER concurrent jobs — prospectively, from the period the job
 * mix changes onward.
 *
 * NEUTRALITY: every US constant lives HERE or in {@link federalTaxTables}, never in
 * `packages/engine/src`.
 *
 * ⚠ Estimates, not advice.
 */

/**
 * Worksheet 1A line 1g — subtracted from annualized wages when the Step 2 checkbox is NOT checked.
 * Frozen at 2019's two-withholding-allowance figure ($4,300 × 2) and, unlike the standard
 * deduction it partners, never indexed since. Its counterpart is baked into the rate schedule
 * below, so the two together always subtract exactly one standard deduction.
 */
const STEP_2_UNCHECKED_ALLOWANCE_CENTS: Cents = 8_600_00;

/**
 * Flat rate for supplemental wages under the optional method (Pub 15 §7). Legislation-set at
 * the third ordinary bracket's rate and held across years.
 */
export const SUPPLEMENTAL_WAGE_RATE = 0.22;

/**
 * Cumulative supplemental wages from ONE employer above which the excess is withheld at
 * {@link SUPPLEMENTAL_WAGE_EXCESS_RATE} — mandatory, not optional. Fixed in statute at $1,000,000
 * and never indexed.
 */
export const SUPPLEMENTAL_WAGE_EXCESS_THRESHOLD_CENTS: Cents = 1_000_000_00;

/** The top ordinary rate; applies to supplemental wages past the threshold above. */
export const SUPPLEMENTAL_WAGE_EXCESS_RATE = 0.37;

/**
 * The Form W-4 an employer withholds against. Every field is an annual figure except
 * {@link extraWithholdingPerPeriodCents}, which the form itself states per pay period.
 *
 * Not authored anywhere yet — {@link defaultW4Configuration} derives one from the scenario. It is
 * a named shape rather than a handful of parameters so that exposing advanced settings later is a
 * UI change and a single plumbing point, not a re-derivation of the withholding math.
 */
export interface W4Configuration {
  /**
   * Step 2(c). Checked, the employee is telling this employer that the household holds more than
   * one job, and the employer switches to a rate schedule built on half the brackets — so two
   * jobs withholding independently approximate one combined liability instead of each pricing
   * itself as if it were the household's only income.
   */
  readonly multipleJobsCheckbox: boolean;
  /** Step 3, annual — a credit against tax, so it reduces withholding dollar for dollar. */
  readonly dependentCreditsCents: Cents;
  /** Step 4(a), annual non-wage income the employee wants covered by wage withholding. */
  readonly otherIncomeCents: Cents;
  /** Step 4(b), annual deductions beyond the standard deduction. */
  readonly deductionsCents: Cents;
  /** Step 4(c), extra dollars per pay period. */
  readonly extraWithholdingPerPeriodCents: Cents;
}

/**
 * The W-4 assumed for a person the plan has not asked about — the IRS's own default advice, read
 * off the scenario rather than off a form: nothing claimed anywhere, and the multiple-jobs
 * correction the employee is told to make when their household holds more than one job at once,
 * carried on line 4(c) by {@link multipleJobsAdjustmentCents}.
 *
 * NOT Step 2(c). That checkbox halves every bracket, which is only the right answer for two jobs
 * paying roughly the same, and it has no way at all to express a job that started in July. The
 * 4(c) route is what the form's own Multiple Jobs Worksheet and the IRS withholding estimator do
 * instead, and it generalises to any number of jobs of any sizes. The checkbox remains an
 * authorable {@link W4Configuration} field for whoever wants it later; the default never sets it.
 */
export function defaultW4Configuration(
  request: WageWithholdingRequest,
  year: number,
): W4Configuration {
  return {
    multipleJobsCheckbox: false,
    dependentCreditsCents: 0,
    otherIncomeCents: 0,
    deductionsCents: 0,
    extraWithholdingPerPeriodCents: multipleJobsAdjustmentCents(request, year),
  };
}

/** A W-4 claiming nothing at all — the baseline each employer withholds against on its own. */
const UNADJUSTED_W4: W4Configuration = {
  multipleJobsCheckbox: false,
  dependentCreditsCents: 0,
  otherIncomeCents: 0,
  deductionsCents: 0,
  extraWithholdingPerPeriodCents: 0,
};

/**
 * The extra per-period withholding a person needs BECAUSE they hold more than one job at once —
 * the economic result of the W-4 Multiple Jobs Worksheet, computed the way the IRS withholding
 * estimator computes it rather than by reproducing the paper worksheet's lookup tables.
 *
 * Independent employers each price their own wages as if they were the person's only income, so
 * every job after the first is withheld against from the bottom of the brackets a second time.
 * The gap is measured, not approximated:
 *
 *  • What the year is now expected to pay — wages ALREADY paid, plus this period's combined rate
 *    of pay repeated for every period left. Past and present only; no job's future is consulted
 *    beyond the pay it is issuing right now.
 *  • What that year would owe, priced ONCE on the combined wage by the same percentage-method
 *    schedule an employer uses — i.e. what a single employer paying all of it would withhold.
 *  • What the year will ACTUALLY withhold if nothing changes — already withheld, plus every
 *    concurrent employer's own unadjusted figure for every remaining period.
 *
 * The difference, spread over the periods that remain. Because the first two terms are anchored on
 * what has really happened, this self-corrects: a job starting in July asks the rest of the year
 * to make up the whole under-withholding, and a job ending asks for nothing further, WITHOUT ever
 * touching a period already paid. Recomputed from scratch each period, so a raise, a cut, a job
 * gained or a job lost simply changes the next answer.
 *
 * Never negative. Payroll cannot hand money back mid-year; an over-withholding is a refund in
 * April, which is exactly where the model already settles it.
 */
export function multipleJobsAdjustmentCents(
  request: WageWithholdingRequest,
  year: number,
): Cents {
  // One job needs no correction, and only one job carries it for the household.
  if (!request.bearsMultipleJobsAdjustment) return 0;
  const concurrentWagesCents = request.concurrentRegularWagesCents.map((w) => Math.max(0, w));
  if (concurrentWagesCents.length < 2) return 0;
  const remainingPeriods = Math.max(
    1,
    Math.min(request.remainingPayPeriods, request.payPeriodsPerYear),
  );

  const periodWagesCents = concurrentWagesCents.reduce((sum, w) => sum + w, 0);
  const projectedAnnualWagesCents =
    Math.max(0, request.priorPersonWagesCents) + periodWagesCents * remainingPeriods;

  // One "pay period" a year long IS the annual pricing: Worksheet 1A annualizes by the period
  // count, so a count of one prices the wage it is handed, deduction and brackets included.
  const targetAnnualCents = regularWageWithholdingCents(
    projectedAnnualWagesCents,
    1,
    UNADJUSTED_W4,
    year,
  );
  const unadjustedPerPeriodCents = concurrentWagesCents.reduce(
    (sum, wagesCents) =>
      sum + regularWageWithholdingCents(wagesCents, request.payPeriodsPerYear, UNADJUSTED_W4, year),
    0,
  );
  const projectedWithheldCents =
    Math.max(0, request.priorPersonWithholdingCents) + unadjustedPerPeriodCents * remainingPeriods;

  return Math.max(0, Math.round((targetAnnualCents - projectedWithheldCents) / remainingPeriods));
}

/**
 * One row of a Pub 15-T percentage-method rate schedule, in the publication's own shape: tax on
 * everything below `lowerCents`, plus `rate` on the excess over it.
 */
export interface WithholdingBracket {
  readonly lowerCents: Cents;
  readonly baseTaxCents: Cents;
  readonly rate: number;
}

export interface WithholdingRateSchedules {
  readonly year: number;
  /** Used when the Step 2 checkbox is NOT checked. */
  readonly standard: readonly WithholdingBracket[];
  /** Used when it IS checked: the standard schedule with thresholds and tax amounts halved. */
  readonly step2Checkbox: readonly WithholdingBracket[];
}

/**
 * Turn the ordinary brackets into a percentage-method schedule offset by `zeroBandTopCents`, the
 * income that bears no withholding at all. Cumulating the base tax as it goes is what lets the
 * caller price any wage with one comparison instead of walking every bracket.
 */
function buildSchedule(
  brackets: readonly OrdinaryBracket[],
  zeroBandTopCents: Cents,
  divisor: number,
): readonly WithholdingBracket[] {
  // Edges first: the 0% band, then each ordinary bracket lifted above it (and halved for the
  // checkbox schedule). The base tax of a row is the width of every row before it times that
  // row's rate, so it can only be accumulated once all the edges are known.
  const edges = [
    { lowerCents: 0, rate: 0 },
    ...brackets.map((b) => ({
      lowerCents: Math.round((zeroBandTopCents + b.lowerCents) / divisor),
      rate: b.rate,
    })),
  ];
  const schedule: WithholdingBracket[] = [];
  let baseTaxCents = 0;
  edges.forEach((edge, i) => {
    const previous = edges[i - 1];
    if (previous !== undefined) {
      baseTaxCents += Math.round((edge.lowerCents - previous.lowerCents) * previous.rate);
    }
    schedule.push({ ...edge, baseTaxCents });
  });
  return schedule;
}

/**
 * The two single-filer percentage-method schedules for `year`.
 *
 * Both are DERIVED from {@link federalTaxTables} rather than transcribed, because the IRS builds
 * them that way: the standard schedule is the ordinary brackets shifted up by the part of the
 * standard deduction that Worksheet 1A does not already subtract on line 1g, so line 1g and the
 * shift together remove exactly one standard deduction. The checkbox schedule is the standard one
 * with every threshold and tax amount halved, and carries the WHOLE standard deduction because
 * line 1g is zero when the box is checked.
 *
 * Deriving rather than transcribing keeps the withholding tables and the return's brackets from
 * drifting apart as the year indexes forward — a drift the year-end true-up would silently absorb
 * and nobody would ever see.
 */
export function withholdingRateSchedules(year: number): WithholdingRateSchedules {
  const { ordinaryBrackets, standardDeductionCents } = federalTaxTables(year);
  return {
    year,
    standard: buildSchedule(
      ordinaryBrackets,
      standardDeductionCents - STEP_2_UNCHECKED_ALLOWANCE_CENTS,
      1,
    ),
    step2Checkbox: buildSchedule(ordinaryBrackets, standardDeductionCents, 2),
  };
}

/** Tentative annual withholding on an adjusted annual wage, per the schedule's own rows. */
function scheduleTaxCents(
  schedule: readonly WithholdingBracket[],
  adjustedAnnualWageCents: Cents,
): Cents {
  let row = schedule[0]!;
  for (const candidate of schedule) {
    if (adjustedAnnualWageCents >= candidate.lowerCents) row = candidate;
    else break;
  }
  return Math.max(
    0,
    row.baseTaxCents + Math.round((adjustedAnnualWageCents - row.lowerCents) * row.rate),
  );
}

/**
 * Worksheet 1A, steps 1–4: the income tax withheld from ONE pay period's REGULAR wages.
 *
 * `periodWagesCents` is the period's taxable wages — already net of pre-tax deferral, which
 * reduces income-tax withholding even though it never reduces FICA.
 *
 * The annualization in step 1 is the whole mechanism: this paycheck is assumed to repeat for the
 * rest of the year, priced as a year, and divided back down. That assumption is wrong for any
 * lumpy earner, and deliberately so — it is what makes the answer depend on THIS paycheck alone.
 * A raise, a cut, a job starting or ending, a month paid nothing: each simply changes the wage
 * that gets annualized, from that period forward, and nothing reaches back to re-withhold a
 * period already paid.
 *
 * Never negative: a Step 3 credit larger than the tentative withholding zeroes the paycheck's
 * withholding rather than paying the employee a credit the employer does not owe.
 */
export function regularWageWithholdingCents(
  periodWagesCents: Cents,
  payPeriodsPerYear: number,
  w4: W4Configuration,
  year: number,
): Cents {
  if (payPeriodsPerYear <= 0) return 0;
  const schedules = withholdingRateSchedules(year);

  // Step 1 — the adjusted annual wage amount (lines 1a–1i).
  const annualWageCents = Math.max(0, periodWagesCents) * payPeriodsPerYear;
  const allowanceCents = w4.multipleJobsCheckbox ? 0 : STEP_2_UNCHECKED_ALLOWANCE_CENTS;
  const adjustedAnnualWageCents = Math.max(
    0,
    annualWageCents + w4.otherIncomeCents - w4.deductionsCents - allowanceCents,
  );

  // Step 2 — tentative withholding, from the schedule the checkbox selects.
  const schedule = w4.multipleJobsCheckbox ? schedules.step2Checkbox : schedules.standard;
  const tentativeAnnualCents = scheduleTaxCents(schedule, adjustedAnnualWageCents);

  // Steps 3 and 4 — credits come off annually and are then spread, extra withholding is already
  // per period. Rounding once, at the end, keeps twelve identical paychecks summing to the annual
  // figure rather than accumulating twelve separate roundings.
  const afterCreditsCents = Math.max(0, tentativeAnnualCents - w4.dependentCreditsCents);
  return Math.max(
    0,
    Math.round(afterCreditsCents / payPeriodsPerYear) + w4.extraWithholdingPerPeriodCents,
  );
}

/**
 * Income tax withheld from SUPPLEMENTAL wages — a bonus — paid in one period, by whichever of the
 * two Pub 15 §7 methods the employer is actually allowed to use.
 *
 * FLAT METHOD (the common case): {@link SUPPLEMENTAL_WAGE_RATE} on the bonus, with the excess over
 * {@link SUPPLEMENTAL_WAGE_EXCESS_THRESHOLD_CENTS} of cumulative supplemental wages from this
 * employer taxed at {@link SUPPLEMENTAL_WAGE_EXCESS_RATE} instead. Permitted only where the
 * employer has withheld income tax from the employee's regular wages — hence
 * `priorRegularWithholdingCents`, the year-to-date figure this employer has actually withheld,
 * including the current period.
 *
 * AGGREGATE METHOD (the fallback, for a bonus paid where no regular wages have been withheld
 * against): withhold on the combined regular-plus-supplemental period wage and subtract what the
 * regular wage alone would have taken. The subtraction is what stops the bonus from being read as
 * a permanent pay rise — the annualization applies to both figures and cancels out of the
 * difference.
 *
 * Neither method looks at any OTHER period's supplemental wages except through the cumulative
 * threshold, so a bonus never alters the withholding on the regular wages around it.
 */
export function supplementalWageWithholdingCents(
  request: WageWithholdingRequest,
  w4: W4Configuration,
  year: number,
): Cents {
  const supplementalCents = Math.max(0, request.supplementalWagesCents);
  if (supplementalCents <= 0) return 0;

  if (request.priorRegularWithholdingCents > 0) {
    const priorSupplementalCents = Math.max(0, request.priorSupplementalWagesCents);
    const cumulativeCents = priorSupplementalCents + supplementalCents;
    const excessCents = Math.max(0, cumulativeCents - SUPPLEMENTAL_WAGE_EXCESS_THRESHOLD_CENTS);
    // Only the part of THIS payment sitting above the threshold takes the higher rate; a payment
    // that straddles it is split, and one made after an earlier payment already crossed it is
    // wholly above.
    const atExcessRateCents = Math.min(supplementalCents, excessCents);
    return (
      Math.round(atExcessRateCents * SUPPLEMENTAL_WAGE_EXCESS_RATE) +
      Math.round((supplementalCents - atExcessRateCents) * SUPPLEMENTAL_WAGE_RATE)
    );
  }

  const regularCents = Math.max(0, request.regularWagesCents);
  const combined = regularWageWithholdingCents(
    regularCents + supplementalCents,
    request.payPeriodsPerYear,
    w4,
    year,
  );
  const regularOnly = regularWageWithholdingCents(regularCents, request.payPeriodsPerYear, w4, year);
  return Math.max(0, combined - regularOnly);
}

/**
 * The whole of one pay period's federal income-tax withholding for one wage source: the regular
 * wages priced by Worksheet 1A, plus the supplemental wages priced by their own method.
 *
 * Kept as one entry point so the engine never has to know that a bonus is withheld differently
 * from a salary — it states what a source paid this period and gets back what payroll would take.
 */
export function wageWithholdingCents(
  request: WageWithholdingRequest,
  year: number,
  w4: W4Configuration = defaultW4Configuration(request, year),
): Cents {
  const regular = regularWageWithholdingCents(
    request.regularWagesCents,
    request.payPeriodsPerYear,
    w4,
    year,
  );
  // The flat method's eligibility test asks whether this employer has withheld against regular
  // wages AT ALL this year, so this period's own regular withholding counts toward it.
  const supplemental = supplementalWageWithholdingCents(
    { ...request, priorRegularWithholdingCents: request.priorRegularWithholdingCents + regular },
    w4,
    year,
  );
  return regular + supplemental;
}

/**
 * User-facing disclosures for this module's withholding simplifications — the `rules` side of
 * {@link import("@finley/engine").Jurisdiction.modelAssumptions}, co-located by `id` with the code
 * they describe.
 */
export const WAGE_WITHHOLDING_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: "w4AssumedDefault",
    text:
      "Because the plan does not ask you to fill in a Form W-4, one is assumed: filing single, " +
      "claiming no dependents, and no deductions beyond the standard one. Whenever you hold more " +
      "than one job at once, the plan assumes you do what the form asks and top up the " +
      "withholding on your highest-paying job to cover the tax your employers cannot see between " +
      "them — recalculated whenever a job starts, stops or changes pay, and never applied to a " +
      "paycheque you have already been paid. If your real W-4 differs, your paycheques will " +
      "differ too, and your refund or bill in April moves by the same amount in the opposite " +
      "direction. The total tax for the year is unaffected either way.",
  },
  {
    id: "supplementalFlatRate",
    text:
      "A bonus has tax withheld at the flat 22% rate employers commonly use for one-off " +
      "payments, rather than at your own tax rate. If you earn well above or below that rate, " +
      "the difference is corrected when you file — a bonus is fully taxed as ordinary income " +
      "either way, and only the timing of the cash changes.",
  },
];
