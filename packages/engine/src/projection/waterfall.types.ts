import type { Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
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

/** One income source's contribution to a single month (resolved from a series). */
export interface IncomeSourceMonth {
  readonly ownerId: string;
  /**
   * Cash this source injects INTO the allocation waterfall. The whole payment for wages,
   * benefit, RMD, and draws; 0 for an accrued-interest booking, whose cash already sits in
   * the balance (re-placing it would double-credit the account).
   */
  readonly waterfallInflowCents: Cents;
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
   * Employee payroll tax (US: FICA) charged on a person's CUMULATIVE year-to-date earned
   * income by category — the person's reconciled ANNUAL LIABILITY, not per-employer
   * withholding (see {@link import("../jurisdiction/jurisdiction").Jurisdiction.computePayrollTaxCents}).
   * Charged as the DIFFERENCE between the seam on the year-to-date total after this month's
   * earnings and before them, so a capped component (OASDI's wage base) binds on cumulative
   * earnings rather than annualized monthly slices — exact for a lumpy earner, unchanged for
   * a level one. The FULL pre-deferral gross is the base: a 401(k) deferral cuts income tax
   * but never payroll tax. Absent → no payroll tax charged. Which categories are earned is
   * the seam's call, keeping `wages`-vs-`ordinaryIncome` policy out of the engine.
   */
  readonly computePayrollTaxCents?: (
    annualEarnedByCategory: Partial<Record<TaxCategory, Cents>>,
  ) => Cents;
  /**
   * {@link computePayrollTaxCents} broken out per {@link TaxCategory} — REQUIRED whenever
   * `computePayrollTaxCents` is present (runtime-enforced), so the waterfall can attribute
   * each incremental payroll-tax charge back to the income source that generated it, the
   * same way {@link computeTaxByCategoryCents} backs {@link taxBySourceCents}.
   */
  readonly computePayrollTaxByCategoryCents?: (
    annualEarnedByCategory: Partial<Record<TaxCategory, Cents>>,
  ) => Partial<Record<TaxCategory, Cents>>;
  /**
   * This person's ESTIMATED federal income-tax payment for this month — an even twelfth of the
   * year's estimated liability, already priced by the caller ({@link
   * import("./federalIncomeTax").estimatedPaymentForMonth}). Deducted from take-home like any
   * other withholding.
   *
   * A FIXED figure, deliberately not a function of this month's income: income tax is annual,
   * and the waterfall sees one month. Absent → no income tax charged.
   */
  readonly estimatedIncomeTaxCents?: (personId: string) => Cents;
  /**
   * A person's year-to-date earned gross by category BEFORE this month — the base the
   * cumulative payroll figure builds on. Absent → nothing earned yet this year. Only
   * consulted when {@link computePayrollTaxCents} is present.
   */
  readonly priorEarnedByPersonCents?: (
    personId: string,
  ) => Partial<Record<TaxCategory, Cents>>;
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
   * The federal income tax charged this month, summed across persons: Σ of the ESTIMATED
   * installments {@link WaterfallInput.estimatedIncomeTaxCents} supplied, never a figure this
   * waterfall priced. The liability itself is annual — {@link taxableByPersonCents} is what a
   * caller folds into the year's running accumulator, and December reconciles the two.
   */
  readonly taxCents: Cents;
  /**
   * Employee payroll tax (FICA) charged this month, summed across persons — the reconciled
   * annual liability accrued this month, not per-employer withholding. Already removed from
   * take-home alongside income tax; 0 when no {@link WaterfallInput.computePayrollTaxCents}
   * is supplied. Kept a SEPARATE line from {@link taxCents} because its base (pre-deferral
   * gross) and category set (earned income only) differ, and so the income-tax attribution
   * invariants stay untouched.
   */
  readonly payrollTaxCents: Cents;
  /**
   * Payroll tax per income SOURCE, keyed like {@link taxBySourceCents} (`sourceId` falling
   * back to tax category). Each category's incremental charge is apportioned by earned
   * weight PER PERSON — mirroring {@link taxBySourceCents} — so the share of the
   * person-level payroll-tax charge attributed to this income source is distinguishable from
   * a partner's. `{}` when no payroll tax was charged, else Σ === `payrollTaxCents` (see
   * {@link assertPayrollTaxAttributionReconciles}).
   */
  readonly payrollTaxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * This month's pre-deferral earned gross by category, per person — the caller folds it
   * into its year-to-date accumulator so next month's {@link
   * WaterfallInput.priorEarnedByPersonCents} is current. A person with no income is absent.
   */
  readonly earnedThisMonthByPersonCents: ReadonlyMap<string, TaxableByCategory>;
  /** Always `{}`: the caller priced the installment, so it owns the split — see {@link taxCents}. */
  readonly taxByCategoryCents: Partial<Record<TaxCategory, Cents>>;
  /** Always `{}` — see {@link taxByCategoryCents}. */
  readonly taxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * This month's taxable income by {@link TaxCategory}, per person — POST-deferral. NOT the
   * base of {@link taxCents}, which is an installment on the whole year's estimate: the caller
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
