import type { Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { WageWithholdingRequest } from "../jurisdiction/jurisdiction";
import type { SourceTaxable, TaxableByCategory } from "./taxAttribution";
import type { IncomeSourceCategory } from "./simulate.types";
import type { SimGoal } from "../goal/goal";

/** The employer-sponsored savings plan a job carries — presence makes it deferral-eligible. */
export interface PlanDescriptor {
  /** Fraction of THIS job's gross deferred pre-tax (0..1). */
  readonly deferralFraction: number;
  /** Person-owned account the deferral (and any match) funds. */
  readonly fundAccountId: string;
  /**
   * Fraction of the amount actually deferred (0.5 = a 50% match). Employer money: never out
   * of take-home, and does NOT share the employee-deferral cap.
   */
  readonly employerMatchFraction?: number;
}

/**
 * What ONE wage source has paid a person so far this calendar year, as that source's own payroll
 * would hold it. The unit both payroll-tax withholding and supplemental-wage banding accumulate
 * in, because each employer applies every cap, threshold and band to its OWN wages.
 *
 * Used two ways with the same shape: as a running year-to-date total, and as one month's delta
 * onto it ({@link WaterfallResult.sourceYearToDateDeltas}).
 */
export interface SourceYearToDate {
  /** PRE-deferral earned gross by category — the payroll-tax base. */
  readonly earnedByCategory: TaxableByCategory;
  /** Supplemental (one-off) wages, for a jurisdiction that bands its supplemental rate. */
  readonly supplementalWagesCents: Cents;
  /** Federal income tax withheld, which a jurisdiction may condition its supplemental method on. */
  readonly wageWithholdingCents: Cents;
  /**
   * POST-deferral wages this source was withheld against — the income-tax base, so distinct from
   * {@link earnedByCategory}, which a pre-tax deferral never reduces. Summed across a person's
   * sources it is the year's wage total an employee-side correction measures against.
   */
  readonly withholdingWagesCents: Cents;
  /**
   * The category {@link withholdingWagesCents} was paid in, so a person's sources can be rolled up
   * per category without the engine deciding which of them are wages. Absent on an empty total.
   */
  readonly taxCategory?: TaxCategory;
}

/** A person's whole year to date in ONE tax category, across every source that has paid them. */
export interface PersonWageYearToDate {
  /** POST-deferral wages, including sources that have since stopped paying. */
  readonly wagesCents: Cents;
  /** Income tax withheld against them, by all of those sources. */
  readonly withholdingCents: Cents;
}

/** One person's income-tax withholding for a month, with the splits the tax chart bands on. */
export interface PersonWithholding {
  readonly totalCents: Cents;
  /** Σ === {@link totalCents} — the categories the withheld-against paycheques were paid in. */
  readonly byCategoryCents: TaxableByCategory;
  /** Σ === {@link totalCents}, keyed by source. */
  readonly bySourceCents: Readonly<Record<string, Cents>>;
}

/** One income source's contribution to a single month (resolved from a series). */
export interface IncomeSourceMonth {
  readonly ownerId: string;
  /**
   * Cash this source injects INTO the allocation waterfall. The whole payment for wages,
   * benefit, RMD, and draws; 0 for an accrued-interest booking, whose cash already sits in
   * the balance (re-placing it would double-credit the account).
   */
  readonly waterfallInflowCents: Cents;
  /**
   * The slice of {@link waterfallInflowCents} that is a ONE-OFF payment rather than this
   * source's recurring rate of pay — a bonus. Absent → the whole payment is recurring.
   *
   * It is ordinary wage income and the year's liability makes no distinction, but WITHHOLDING
   * does: a payroll system annualizes recurring pay and must not annualize a bonus, or one
   * month's windfall would be withheld against as though every remaining month would repeat it.
   * Splitting it here is what lets the jurisdiction apply its supplemental method.
   */
  readonly supplementalCents?: Cents;
  readonly taxCategory: TaxCategory;
  /**
   * Reporting provenance: never affects allocation or tax owed, only how results are keyed
   * and named. `sourceId` is a stable machine key (job id, draw's account id,
   * `benefit:<person>`) keying {@link WaterfallResult.taxBySourceCents} and the flow view
   * ({@link import("./reportFlows").buildFlows}); `label` is its human name. Absent →
   * keyed/named by tax category.
   */
  readonly sourceId?: string;
  readonly label?: string;
  /** Present → eligible for pre-tax deferral (step 1). Absent → post-deferral. */
  readonly planDescriptor?: PlanDescriptor;
  /**
   * The taxable base when it is NOT the full gross: a returned-basis fund withdrawal books
   * only its **gain** (the whole gross still pays out as take-home), and an accrued-interest
   * booking books its interest here with `waterfallInflowCents` 0. Absent → the full gross
   * is taxable (wages, benefit, RMD, pre-tax draws).
   */
  readonly taxableCents?: Cents;
  /**
   * Realized cash paid to the household, for the cash-flow report. Differs from
   * `waterfallInflowCents` only for an accrued-interest booking, where this is the interest
   * genuinely received and the inflow is 0. Absent → `waterfallInflowCents`.
   */
  readonly cashInflowCents?: Cents;
  /**
   * OVERRIDES the tax-category axis for display/grouping
   * ({@link import("./simulate.types").ProjectionCashFlowIncomeSource.category}). Savings interest
   * sets `"savingsInterest"` so the UI groups it without parsing source ids, even though it
   * is taxed as `ordinaryIncome` (where it still buckets in the taxable rollup). Absent →
   * reports under its {@link taxCategory}.
   */
  readonly reportCategory?: IncomeSourceCategory;
}

/** Lever 2: how much each person contributes to shared obligations (step 3). */
export type SharedContributionScheme = "proportional" | "even";

/** Lever 4: where leftover cash lands once every goal is funded. */
export type SurplusDestination =
  | { readonly kind: "idle" }
  | { readonly kind: "swept"; readonly accountId: string };

export interface WaterfallInput {
  readonly personIds: readonly string[];
  readonly incomeSources: readonly IncomeSourceMonth[];
  /** Shared obligations this month: expenses + scheduled liability payments. */
  readonly sharedObligationCents: Cents;
  readonly sharedScheme: SharedContributionScheme;
  readonly surplusDestination: SurplusDestination;
  readonly goals: readonly SimGoal[];
  /**
   * Standing contribution lines, already in priority order and post-tax. A COMMITTED outflow:
   * the full amount always lands (from the pool after dated goal paces, before `asap` goals),
   * and what the pool cannot cover is borrowed — so an unaffordable contribution makes the plan
   * unfinanceable rather than silently shrinking. Absent → none.
   */
  readonly contributions?: readonly { readonly accountId: string; readonly monthlyCents: Cents }[];
  /**
   * The absolute month being allocated (0 = "now"). Sets each dated goal's
   * `monthsRemaining = targetDate − nowMonth` for the sinking-fund pace. Absent → 0.
   */
  readonly nowMonth?: number;
  /**
   * A goal fund account's monthly growth rate, for the growth-aware pace. Absent (or
   * returning 0) → a flat even spread over the months remaining.
   */
  readonly goalFundMonthlyRate?: (accountId: string) => number;
  /** Current (beginning-of-step) balance of any account — goal need is target − this. */
  readonly accountBalanceCents: (accountId: string) => Cents;
  /** The default liquid account — the `idle` surplus destination. Null if none. */
  readonly liquidAccountId: string | null;
  /**
   * A person's REMAINING annual deferral room this month (limit minus what they have
   * already deferred this year). `Infinity` = uncapped.
   */
  readonly remainingDeferralRoomCents: (personId: string) => number;
  /**
   * Federal income tax WITHHELD from one wage source's pay this period — the jurisdiction's
   * paycheck-level seam ({@link
   * import("../jurisdiction/jurisdiction").Jurisdiction.computeWageWithholdingCents}).
   *
   * Called once per source, on this period's pay plus what the year has already paid and withheld.
   * Every input is past or present, which is the whole causality guarantee: a raise, a cut, a
   * bonus, a missing paycheck or a job starting moves this month's figure and no earlier one, and
   * non-wage income (a withdrawal, a realized gain) is answered with zero. Absent → nothing is
   * withheld and the year's whole liability settles on filing.
   */
  readonly computeWageWithholdingCents?: (request: WageWithholdingRequest) => Cents;
  /**
   * How many pay periods the year holds — the annualization factor the withholding seam projects
   * one period's wage across. Twelve, because a compiled income series resolves one figure per
   * MONTH and a month is therefore the finest paycheck this model has.
   */
  readonly payPeriodsPerYear: number;
  /**
   * Pay periods left in the tax year, THIS month included — 12 in January, 1 in December. The
   * horizon a jurisdiction has to spread a prospective mid-year correction over.
   */
  readonly periodsRemainingInTaxYear: number;
  /**
   * One wage source's year-to-date facts BEFORE this month, as its own employer would hold them:
   * cumulative earned gross by category, supplemental wages already paid, and income tax already
   * withheld. Absent → the source has paid nothing yet this year.
   *
   * PER SOURCE, not per person, because that is the boundary real payroll works at — see
   * {@link computePayrollWithholdingCents}.
   */
  readonly priorSourceYearToDate?: (personId: string, sourceKey: string) => SourceYearToDate;
  /**
   * The same year-to-date facts rolled up ACROSS a person's sources in one category — what the
   * EMPLOYEE knows and no single employer does. Sources that have already stopped paying are
   * included, which is what lets a correction made in July account for a job that ran to June.
   * Absent → the person has been paid nothing yet this year.
   */
  readonly priorPersonWageYearToDate?: (
    personId: string,
    taxCategory: TaxCategory,
  ) => PersonWageYearToDate;
  /**
   * Employee payroll tax (US: FICA) withheld by ONE wage source, on THAT SOURCE's cumulative
   * year-to-date earned income by category (see {@link
   * import("../jurisdiction/jurisdiction").Jurisdiction.computePayrollWithholdingCents}).
   * Charged as the DIFFERENCE between the seam after this month's earnings and before them, so a
   * capped component (a wage base) binds on cumulative earnings rather than on annualized monthly
   * slices — exact for a lumpy earner, unchanged for a level one.
   *
   * The FULL pre-deferral gross is the base: a 401(k) deferral cuts income tax but never payroll
   * tax. Which categories are earned is the seam's call, keeping `wages`-vs-`ordinaryIncome`
   * policy out of the engine. Absent → no payroll tax charged.
   */
  readonly computePayrollWithholdingCents?: (
    sourceCumulativeEarnedByCategory: Partial<Record<TaxCategory, Cents>>,
  ) => Cents;
  /**
   * {@link computePayrollWithholdingCents} broken out per {@link TaxCategory} — REQUIRED
   * whenever it is present (runtime-enforced), so the waterfall can attribute each incremental
   * payroll-tax charge back to the income category that generated it.
   */
  readonly computePayrollWithholdingByCategoryCents?: (
    sourceCumulativeEarnedByCategory: Partial<Record<TaxCategory, Cents>>,
  ) => Partial<Record<TaxCategory, Cents>>;
  /**
   * The prior tax year's settled balance falling due this month, per person — signed, positive
   * due, negative a refund. Charged through the same channel as this month's withholding, so a
   * balance is docked from take-home and forces decumulation exactly as withholding does, while a
   * refund raises take-home and lands wherever an ordinary surplus lands.
   *
   * A FIXED figure the caller priced from a CLOSED year; the waterfall never derives it. Absent,
   * or in any month but the filing month → 0.
   */
  readonly settlementCashCents?: (personId: string) => Cents;
  /**
   * REMAINING annual room under ONE plan's combined deposit limit — that limit minus the
   * deferral AND match already banked into the plan this year. `Infinity` = uncapped.
   *
   * Per plan, not per person, so a second job brings its own full room. `personId` still
   * comes through because the jurisdiction may band the limit on age. Contrast
   * {@link remainingDeferralRoomCents}, which IS per person — the employee's own deferral is
   * shared across every plan they hold.
   *
   * Bounds the match only: the deferral is already clamped by
   * {@link remainingDeferralRoomCents} before this applies.
   */
  readonly remainingCombinedDepositRoomCents: (personId: string, planKey: string) => number;
}

export interface WaterfallResult {
  /**
   * The federal income-tax CASH this month, summed across persons: the wage withholding this
   * waterfall computed per source, plus (in the filing month only) the prior year's settled
   * balance the caller supplied. Signed only through that balance — a refund large enough can
   * make the month's income tax negative, which is take-home rather than a charge.
   *
   * NOT the year's liability, and not an instalment of it. {@link taxableByPersonCents} is what
   * a caller folds into the year's accumulator, and the year's close reconciles the two.
   */
  readonly taxCents: Cents;
  /**
   * The wage-withholding slice of {@link taxCents} — this month's withholding alone, excluding
   * any settled balance. What the caller credits against the CURRENT year's liability; the
   * settlement pays a different year's and must never be credited here.
   */
  readonly wageWithholdingCents: Cents;
  /**
   * {@link wageWithholdingCents} per income SOURCE, keyed like {@link payrollTaxBySourceCents}.
   * EXACT, not apportioned: each figure is what that one source's own paycheck withheld, because
   * withholding is computed per source in the first place.
   */
  readonly wageWithholdingBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * The same withholding split per PERSON, with its own category and source breakdowns — what the
   * caller credits against that person's year. Structurally a
   * {@link import("./federalIncomeTax").FederalTaxPayment}, stated structurally so the waterfall
   * keeps knowing nothing about the year-level accounting that consumes it. A person whose
   * paycheques withheld nothing is absent.
   */
  readonly wageWithholdingByPerson: ReadonlyMap<string, PersonWithholding>;
  /**
   * Employee payroll tax (FICA) withheld this month, summed across persons — per SOURCE, as a
   * real employer withholds it, so a person holding two jobs has each cap applied twice and the
   * year's filing squares up the difference. Already removed from take-home alongside income tax;
   * 0 when no {@link WaterfallInput.computePayrollWithholdingCents} is supplied. Kept a SEPARATE
   * line from {@link taxCents} because its base (pre-deferral gross) and category set (earned
   * income only) differ.
   */
  readonly payrollTaxCents: Cents;
  /**
   * Payroll tax per income SOURCE, keyed like {@link wageWithholdingBySourceCents} (`sourceId`
   * falling back to tax category). Each source's incremental charge apportioned across the
   * categories it earned in. `{}` when no payroll tax was charged, else Σ === `payrollTaxCents`
   * (see {@link assertPayrollTaxAttributionReconciles}).
   */
  readonly payrollTaxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * This month's year-to-date-advancing payroll facts per wage SOURCE, per person — the caller
   * folds each into its accumulator so next month's {@link WaterfallInput.priorSourceYearToDate}
   * is current. Keyed by person, then by source key. A source that paid nothing is absent.
   */
  readonly sourceYearToDateDeltas: ReadonlyMap<string, ReadonlyMap<string, SourceYearToDate>>;
  /** Always `{}`: the caller owns the category split of the month's tax cash — see {@link taxCents}. */
  readonly taxByCategoryCents: Partial<Record<TaxCategory, Cents>>;
  /** Always `{}` — see {@link taxByCategoryCents}. */
  readonly taxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * This month's taxable income by {@link TaxCategory}, per person — POST-deferral. NOT the
   * base of {@link taxCents}, which is what payroll withheld: the caller
   * folds this into its year-to-date accumulator (mirroring {@link
   * earnedThisMonthByPersonCents}), so the December reconciliation reads the complete year's
   * ACTUAL total regardless of which month each dollar landed in.
   */
  readonly taxableByPersonCents: ReadonlyMap<string, TaxableByCategory>;
  /**
   * The per-SOURCE breakdown behind {@link taxableByPersonCents} — the same POST-deferral
   * taxable amount, but kept per source (job, draw, benefit) instead of collapsed into a
   * category total. The caller folds this into its OWN year-to-date per-source accumulator
   * (mirroring how {@link taxableByPersonCents} folds into the category one), so the December
   * settlement can apportion its per-category bill back to the real sources that produced the
   * year's taxable income — the same average-rate {@link
   * import("./taxAttribution").attributeTaxToSources} apportionment payroll tax already uses
   * monthly, just applied once, annually. A source contributing nothing this month is absent.
   */
  readonly taxableBySourcePersonCents: ReadonlyMap<string, readonly SourceTaxable[]>;
  /**
   * Pre-tax deferral per income SOURCE (keyed like {@link taxBySourceCents}), summed across
   * the household, so a consumer can compute a source's take-home (gross − deferral − tax).
   * A source that defers nothing is absent. Σ === Σ `deferredByPersonCents`.
   */
  readonly deferralBySourceCents: Readonly<Record<string, Cents>>;
  /** Amount actually deferred per person — the caller updates its annual accumulator. */
  readonly deferredByPersonCents: ReadonlyMap<string, Cents>;
  /**
   * Deferral + employer match actually banked per PLAN, keyed like
   * {@link deferralBySourceCents} — what the combined deposit limit is measured against. The
   * caller updates its annual accumulator from this. Σ === Σ `deferredByPersonCents` + total
   * match.
   */
  readonly combinedDepositsByPlanCents: ReadonlyMap<string, Cents>;
  /** Net deposit to add to each account this month (deferrals, match, goals, surplus). */
  readonly accountDepositsCents: ReadonlyMap<string, Cents>;
  /** Household cash shortfall to route through the cascade (0 if none). */
  readonly shortfallCents: Cents;
  /**
   * The slice of {@link shortfallCents} attributable to shared OBLIGATIONS (and unfunded
   * deductions) alone, BEFORE `fundGoalsAndContributions` runs — i.e. `shortfallCents` minus
   * the contribution shortfall. Obligations draw from take-home first and goals only draw
   * the leftover, so this is what remained unfunded at the point obligations were priced,
   * before a single dollar was spent on discretionary saving. A caller attributing the
   * cascade's scarce covering capacity (savings + credit) needs this to fund obligations
   * before contributions, mirroring {@link import("./financialObligation").OBLIGATION_PRIORITY}
   * ranking debt/needs ahead of a goal.
   */
  readonly obligationShortfallCents: Cents;
}
