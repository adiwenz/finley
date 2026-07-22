/**
 * Simulation report — the engine's complete, self-describing, JSON-serializable
 * account of a single run. This is the "headless Finley" output: hand it a
 * {@link HouseholdSimInput} and a {@link Jurisdiction} and get back everything the
 * simulator knows — the resolved inputs echoed for the record, plus a per-month
 * table carrying ages, balances (stocks), and cash flows (rates), including derived
 * government retirement benefit income. A consumer needs no engine internals to render, export,
 * or diff a run; the app's debug panel is just one such consumer.
 *
 * Everything here is plain data (no class instances, no functions), so
 * `JSON.stringify(report)` round-trips losslessly.
 */

import type { Cents } from "../money";
import type { GrowthSegmentView, SimCashFlowSeries } from "../cashFlowSeries";
import type { Jurisdiction } from "../jurisdiction";
import type { SimGoal } from "../goal";
import { AmortizingLoan, RevolvingCard } from "../liability";
import { simulateHousehold } from "./simulate";
import type {
  HouseholdSimInput,
  LiabilityPaymentRecord,
  ProjectionSeries,
} from "./simulate.types";
import type { SharedContributionScheme, SurplusDestination } from "./waterfall";

/** A household member as echoed in the report. `birthYear`/`benefitClaimingAge` null when unmodelled. */
export interface ReportPerson {
  readonly id: string;
  readonly name: string;
  readonly birthYear: number | null;
  readonly benefitClaimingAge: number | null;
  /** Age at the run's start year (startYear − birthYear); null without a birth year. */
  readonly ageAtStart: number | null;
}

/** An asset account's opening configuration (the rate is the one in effect at month 0). */
export interface ReportAccount {
  readonly id: string;
  readonly ownerId: string;
  readonly liquid: boolean;
  /** The {@link TaxCategory} withdrawals produce — the neutral tax-behavior echo. */
  readonly withdrawalCategory: string;
  readonly openingBalanceCents: Cents;
  /** Annual return in force at month 0. See {@link rateSchedule} for later changes. */
  readonly annualRate: number;
  /** Every rate change over the run, ascending by `startMonth`; one entry for a flat rate. */
  readonly rateSchedule: readonly { readonly startMonth: number; readonly annualRate: number }[];
}

export interface ReportLiability {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly openingBalanceCents: Cents;
  readonly startMonth: number;
  readonly apr: number;
  readonly termMonths: number | null;
  readonly creditLimitCents: Cents | null;
}

export interface ReportProperty {
  readonly id: string;
  readonly ownerId: string;
  readonly startMonth: number;
  readonly endMonth: number | null;
  readonly openingValueCents: Cents;
  readonly appreciationAnnualRate: number;
}

/**
 * An income source as echoed in the report. Series are sampled — not fully
 * serialized — because the authoritative month-by-month figures live in each
 * {@link ReportMonth}'s `incomeByCategoryCents`; `monthlyCentsAtStart` is a
 * convenience sample of the source at month 0.
 */
export interface ReportIncomeSource {
  readonly ownerId: string;
  /** Human-facing name of the stream ("Income", "Income · job-1"); null when unnamed. */
  readonly label: string | null;
  readonly taxCategory: string;
  /** Pre-tax deferral fraction if this source carries a retirement plan (§5.5), else null. */
  readonly deferralFraction: number | null;
  /** Employer match as a fraction of the deferral (§5.5); null without a plan. */
  readonly employerMatchFraction: number | null;
  readonly fundAccountId: string | null;
  readonly monthlyCentsAtStart: Cents;
  /**
   * The RAISE RATE: annual growth in force at month 0 (0 for a `fixed` stream).
   * See {@link growthSchedule} for changes later in the run.
   */
  readonly annualGrowthRate: number;
  /** How that rate is derived — `fixed`, `inflationLinked`, `customRate`, `salaryCompound`. */
  readonly growthMode: string;
  /** Every growth change over the run, ascending by `startMonth`; one entry for a flat rate. */
  readonly growthSchedule: readonly GrowthSegmentView[];
}

export interface ReportExpenseSource {
  readonly ownerId: string;
  /** Human-facing name of the line ("Expenses", "Healthcare", a budget line's label); null when unnamed. */
  readonly label: string | null;
  readonly monthlyCentsAtStart: Cents;
  /** Annual escalation in force at month 0 — general CPI, or a line's own rate (e.g. health). */
  readonly annualGrowthRate: number;
  /** How that rate is derived — `fixed`, `inflationLinked`, `customRate`, `salaryCompound`. */
  readonly growthMode: string;
  /** Every growth change over the run, ascending by `startMonth`; one entry for a flat rate. */
  readonly growthSchedule: readonly GrowthSegmentView[];
}

/** The resolved inputs the run consumed, echoed back for the record. */
export interface ReportInputs {
  readonly horizonMonths: number;
  /** `horizonMonths / 12` — the run length in years, for a human-facing config view. */
  readonly horizonYears: number;
  readonly startYear: number;
  /** Calendar year of the final simulated month (`startYear + ⌊horizonMonths/12⌋`). */
  readonly endYear: number;
  /** General CPI: the rate that drives inflation-linked series and the real/nominal split. */
  readonly annualInflationRate: number;
  /**
   * The COLA rate actually applied to the government retirement benefit (§5.4) —
   * the plan's `benefitColaRate` when set, else general CPI. RESOLVED, so a reader
   * never has to re-apply the fallback; `benefitColaRateIsExplicit` says which it was.
   */
  readonly benefitColaRate: number;
  /** Whether {@link benefitColaRate} was authored rather than inherited from CPI. */
  readonly benefitColaRateIsExplicit: boolean;
  readonly sharedScheme: SharedContributionScheme;
  readonly surplusDestination: SurplusDestination;
  readonly persons: readonly ReportPerson[];
  readonly accounts: readonly ReportAccount[];
  readonly liabilities: readonly ReportLiability[];
  readonly properties: readonly ReportProperty[];
  readonly incomeSources: readonly ReportIncomeSource[];
  readonly expenseSources: readonly ReportExpenseSource[];
  readonly goals: readonly SimGoal[];
}

/**
 * One row of the accumulation table: the household's stocks and flows at `month`.
 * `year` and `ageByPerson` are the human-facing time axes derived from the run's
 * `startYear` and each person's birth year.
 */
export interface ReportMonth {
  readonly month: number;
  readonly year: number;
  /** Integer age this calendar year (year − birthYear), per person with a birth year. */
  readonly ageByPerson: Readonly<Record<string, number>>;
  /** Null once the plan is insolvent (§5.1) — see {@link ProjectionMonth}. */
  readonly netWorthNominalCents: Cents | null;
  readonly netWorthRealCents: Cents | null;
  readonly accountBalancesCents: Readonly<Record<string, Cents>>;
  readonly liabilityBalancesCents: Readonly<Record<string, Cents>>;
  readonly propertyValuesCents: Readonly<Record<string, Cents>>;
  /** Gross income this month by tax category (`wages`, `governmentRetirementBenefit`, …). Empty at month 0. */
  readonly incomeByCategoryCents: Readonly<Record<string, Cents>>;
  readonly totalIncomeCents: Cents;
  readonly governmentRetirementBenefitCents: Cents;
  /** Tax charged this month through the §5.3 jurisdiction seam, all persons summed. */
  readonly taxCents: Cents;
  readonly expensesCents: Cents;
  readonly liabilityPaymentsCents: Cents;
  readonly liabilityPaymentRecords: Readonly<Record<string, LiabilityPaymentRecord>>;
  readonly isInsolvent: boolean;
}

/**
 * The union of keys that appear across the run, so a consumer can lay out table
 * columns without scanning every row. Each list is stable-ordered by first
 * appearance.
 */
export interface ReportColumns {
  readonly personIds: readonly string[];
  readonly accountIds: readonly string[];
  readonly liabilityIds: readonly string[];
  readonly propertyIds: readonly string[];
  readonly incomeCategories: readonly string[];
}

export interface SimulationReport {
  readonly inputs: ReportInputs;
  readonly columns: ReportColumns;
  readonly months: readonly ReportMonth[];
  /**
   * Caller-supplied configuration echoed back verbatim (see the `meta` argument of
   * {@link summarizeSimulation}). The engine treats it as an opaque bag — it stays
   * app-agnostic — while giving a consumer one place to round-trip the higher-level,
   * human-authored knobs that its own inputs compiled away (e.g. the app records the
   * full value-editing surface here: life expectancy, retirement age, health config).
   * Absent when the caller supplies none.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

const DEFAULT_START_YEAR = 2026;

/**
 * The growth-rate echo shared by income and expense sources: the rate in force at
 * month 0, the mode that produced it, and the full schedule. One helper so the two
 * source shapes cannot drift in how they report a rate.
 */
function growthEcho(series: SimCashFlowSeries): {
  annualGrowthRate: number;
  growthMode: string;
  growthSchedule: readonly GrowthSegmentView[];
} {
  const schedule = series.growthSchedule();
  return {
    annualGrowthRate: series.growthAnnualRateAt(0),
    growthMode: schedule[0]?.mode ?? "fixed",
    growthSchedule: schedule,
  };
}

function echoInputs(input: HouseholdSimInput): ReportInputs {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  return {
    horizonMonths: input.horizonMonths,
    horizonYears: input.horizonMonths / 12,
    startYear,
    endYear: startYear + Math.floor(input.horizonMonths / 12),
    annualInflationRate: input.annualInflationRate,
    benefitColaRate: input.benefitColaRate ?? input.annualInflationRate,
    benefitColaRateIsExplicit: input.benefitColaRate !== undefined,
    sharedScheme: input.sharedScheme ?? "proportional",
    surplusDestination: input.surplusDestination ?? { kind: "idle" },
    persons: input.persons.map((p) => ({
      id: p.id,
      name: p.name,
      birthYear: p.birthYear ?? null,
      benefitClaimingAge: p.benefitClaimingAge ?? null,
      ageAtStart: p.birthYear === undefined ? null : startYear - p.birthYear,
    })),
    accounts: input.accounts.map((a) => ({
      id: a.id,
      ownerId: a.ownerId,
      liquid: a.liquid,
      withdrawalCategory: a.taxProfile.withdrawalCategory,
      openingBalanceCents: a.openingBalanceCents,
      annualRate: a.getRateAt(0),
      rateSchedule: a.rateSchedule(),
    })),
    liabilities: (input.liabilities ?? []).map((l) => ({
      id: l.id,
      ownerId: l.ownerId,
      kind: l.kind,
      openingBalanceCents: l.openingBalanceCents,
      startMonth: l.startMonth,
      apr: l.apr,
      // The DTO stays flat with explicit nulls (a greppable wire format the debug
      // export echoes verbatim); the kind-split lives only in the derived classes.
      termMonths: l instanceof AmortizingLoan ? l.termMonths : null,
      creditLimitCents: l instanceof RevolvingCard ? l.creditLimitCents : null,
    })),
    properties: (input.properties ?? []).map((p) => ({
      id: p.id,
      ownerId: p.ownerId,
      startMonth: p.startMonth,
      endMonth: p.endMonth,
      openingValueCents: p.openingValueCents,
      appreciationAnnualRate: p.appreciationAnnualRate,
    })),
    incomeSources: input.incomeSeries.map((s) => ({
      ownerId: s.ownerId,
      label: s.label ?? null,
      taxCategory: s.series.taxCategory ?? "ordinaryIncome",
      deferralFraction: s.planDescriptor?.deferralFraction ?? null,
      employerMatchFraction: s.planDescriptor?.employerMatchFraction ?? null,
      fundAccountId: s.planDescriptor?.fundAccountId ?? null,
      monthlyCentsAtStart: s.series.getMonthlyCents(0),
      ...growthEcho(s.series),
    })),
    expenseSources: input.expenseSeries.map((s) => ({
      ownerId: s.ownerId,
      label: s.label ?? null,
      monthlyCentsAtStart: s.series.getMonthlyCents(0),
      ...growthEcho(s.series),
    })),
    goals: input.goals ?? [],
  };
}

/** Ordered union (by first appearance) of the keys present across every `pick(row)`. */
function unionKeys(
  months: readonly ReportMonth[],
  pick: (m: ReportMonth) => Readonly<Record<string, unknown>>,
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const m of months) {
    for (const k of Object.keys(pick(m))) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

/**
 * Assemble a {@link SimulationReport} from a run's resolved input and its
 * {@link ProjectionSeries}. Exposed alongside {@link buildSimulationReport} so a
 * caller that has *already* simulated (the app draws the same series for its chart)
 * can build the report without paying for a second simulation.
 *
 * `meta` is echoed verbatim onto {@link SimulationReport.meta} — the seam for a
 * consumer's higher-level config that the engine's own inputs don't carry.
 */
export function summarizeSimulation(
  input: HouseholdSimInput,
  series: ProjectionSeries,
  meta?: Readonly<Record<string, unknown>>,
): SimulationReport {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const birthYearById = new Map<string, number>();
  for (const p of input.persons) {
    if (p.birthYear !== undefined) birthYearById.set(p.id, p.birthYear);
  }

  const months: ReportMonth[] = series.months.map((m) => {
    const year = startYear + Math.floor(m.month / 12);
    const ageByPerson: Record<string, number> = {};
    for (const [id, birthYear] of birthYearById) ageByPerson[id] = year - birthYear;
    const flows = m.flows;
    return {
      month: m.month,
      year,
      ageByPerson,
      netWorthNominalCents: m.netWorthNominalCents,
      netWorthRealCents: m.netWorthRealCents,
      accountBalancesCents: m.accountBalancesCents,
      liabilityBalancesCents: m.liabilityBalancesCents,
      propertyValuesCents: m.propertyValuesCents,
      incomeByCategoryCents: flows?.incomeByCategoryCents ?? {},
      totalIncomeCents: flows?.totalIncomeCents ?? 0,
      governmentRetirementBenefitCents: flows?.governmentRetirementBenefitCents ?? 0,
      taxCents: flows?.taxCents ?? 0,
      expensesCents: flows?.expensesCents ?? 0,
      liabilityPaymentsCents: flows?.liabilityPaymentsCents ?? 0,
      liabilityPaymentRecords: m.liabilityPaymentRecords,
      isInsolvent: m.isInsolvent,
    };
  });

  const columns: ReportColumns = {
    personIds: input.persons.map((p) => p.id),
    accountIds: unionKeys(months, (m) => m.accountBalancesCents),
    liabilityIds: unionKeys(months, (m) => m.liabilityBalancesCents),
    propertyIds: unionKeys(months, (m) => m.propertyValuesCents),
    incomeCategories: unionKeys(months, (m) => m.incomeByCategoryCents),
  };

  return {
    inputs: echoInputs(input),
    columns,
    months,
    ...(meta !== undefined ? { meta } : {}),
  };
}

/**
 * Run the simulator and produce the complete {@link SimulationReport} — the
 * headless entry point: inputs in, everything out. Prefer {@link summarizeSimulation}
 * when you already hold the run's {@link ProjectionSeries}. `meta` is echoed verbatim.
 */
export function buildSimulationReport(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
  meta?: Readonly<Record<string, unknown>>,
): SimulationReport {
  return summarizeSimulation(input, simulateHousehold(input, jurisdiction), meta);
}
