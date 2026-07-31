/**
 * Simulation report: a {@link HouseholdSimInput} plus a {@link Jurisdiction} in, resolved inputs
 * echoed back and a per-month table of ages, balances and cash flows out.
 *
 * All plain data (no class instances, no functions), so `JSON.stringify` round-trips losslessly.
 */

import type { Cents } from "../money";
import type { GrowthSegmentView, SimCashFlowSeries } from "../cashFlowSeries";
import type { Jurisdiction } from "../jurisdiction";
import type { SimGoal } from "../goal";
import { AmortizingLoan, RevolvingCard } from "../liability";
import { simulateHousehold } from "./simulate";
import { MODEL_ASSUMPTIONS, type ModelAssumption } from "./assumptions";
import type {
  HouseholdSimInput,
  LiabilityPaymentRecord,
  ProjectionSeries,
} from "./simulate.types";
import type { SharedContributionScheme, SurplusDestination } from "./waterfall";

/** Null fields are unmodelled. */
export interface ReportPerson {
  readonly id: string;
  readonly name: string;
  readonly birthYear: number | null;
  readonly benefitClaimingAge: number | null;
  /** startYear − birthYear; null without a birth year. */
  readonly ageAtStart: number | null;
}

export interface ReportAccount {
  readonly id: string;
  readonly ownerId: string;
  readonly liquid: boolean;
  readonly withdrawalCategory: string;
  readonly openingBalanceCents: Cents;
  /** Annual return in force at month 0; see {@link rateSchedule} for later changes. */
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
 * Series are sampled, not serialized: the authoritative month-by-month figures live in each
 * {@link ReportMonth}'s `incomeByCategoryCents`; `monthlyCentsAtStart` samples month 0.
 */
export interface ReportIncomeSource {
  readonly ownerId: string;
  /** Human-facing name ("Income · job-1"); null when unnamed. */
  readonly label: string | null;
  readonly taxCategory: string;
  /** Pre-tax deferral fraction if this source carries a retirement plan, else null. */
  readonly deferralFraction: number | null;
  /** Employer match as a fraction of the deferral; null without a plan. */
  readonly employerMatchFraction: number | null;
  readonly fundAccountId: string | null;
  readonly monthlyCentsAtStart: Cents;
  /** Annual growth in force at month 0 (0 for a `fixed` stream). */
  readonly annualGrowthRate: number;
  /** How that rate is derived — `fixed`, `inflationLinked`, `customRate`, `salaryCompound`. */
  readonly growthMode: string;
  /** Every growth change, ascending by `startMonth`; one entry for a flat rate. */
  readonly growthSchedule: readonly GrowthSegmentView[];
}

export interface ReportExpenseSource {
  readonly ownerId: string;
  /** Human-facing name ("Healthcare", a budget line's label); null when unnamed. */
  readonly label: string | null;
  readonly monthlyCentsAtStart: Cents;
  /** Annual escalation in force at month 0 — general CPI, or a line's own rate (e.g. health). */
  readonly annualGrowthRate: number;
  /** As {@link ReportIncomeSource.growthMode}. */
  readonly growthMode: string;
  /** As {@link ReportIncomeSource.growthSchedule}. */
  readonly growthSchedule: readonly GrowthSegmentView[];
}

export interface ReportInputs {
  readonly horizonMonths: number;
  /** `horizonMonths / 12`. */
  readonly horizonYears: number;
  readonly startYear: number;
  /** Calendar year of the final simulated month (`startYear + ⌊horizonMonths/12⌋`). */
  readonly endYear: number;
  /** General CPI: the rate that drives inflation-linked series and the real/nominal split. */
  readonly annualInflationRate: number;
  /** Already resolved (`benefitColaRate` ?? general CPI) — do not re-apply the fallback. */
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

export interface ReportMonth {
  readonly month: number;
  readonly year: number;
  /** Integer age this calendar year (year − birthYear), per person with a birth year. */
  readonly ageByPerson: Readonly<Record<string, number>>;
  /** Null once the plan is insolvent — see {@link ProjectionMonth}. */
  readonly netWorthNominalCents: Cents | null;
  readonly netWorthRealCents: Cents | null;
  readonly accountBalancesCents: Readonly<Record<string, Cents>>;
  readonly liabilityBalancesCents: Readonly<Record<string, Cents>>;
  readonly propertyValuesCents: Readonly<Record<string, Cents>>;
  /** Gross income this month by tax category (`wages`, `governmentRetirementBenefit`, …). Empty at month 0. */
  readonly incomeByCategoryCents: Readonly<Record<string, Cents>>;
  readonly totalIncomeCents: Cents;
  readonly governmentRetirementBenefitCents: Cents;
  /** Tax charged through the jurisdiction seam, summed over persons. */
  readonly taxCents: Cents;
  /**
   * Employee payroll tax (US: FICA) withheld this month, summed over persons — a separate
   * line from {@link taxCents} (earned income only, on pre-deferral gross). 0 at month 0 and
   * whenever the jurisdiction charges none.
   */
  readonly payrollTaxCents: Cents;
  /** `{}` when no tax, else Σ === `taxCents`; absent only for the flow-free month 0. */
  readonly taxByCategoryCents?: Readonly<Record<string, Cents>>;
  /**
   * Keyed by each source's reporting id, so a job's tax is named rather than collapsed into
   * `wages`. Same presence rule and Σ invariant as {@link taxByCategoryCents}.
   */
  readonly taxBySourceCents?: Readonly<Record<string, Cents>>;
  /** This month's pre-tax deferral by income source; absent when none deferred. */
  readonly deferralBySourceCents?: Readonly<Record<string, Cents>>;
  readonly expensesCents: Cents;
  readonly liabilityPaymentsCents: Cents;
  readonly liabilityPaymentRecords: Readonly<Record<string, LiabilityPaymentRecord>>;
  readonly isInsolvent: boolean;
}

/**
 * Every key appearing anywhere in the run, ordered by first appearance, so a consumer can lay
 * out table columns without scanning every row.
 */
export interface ReportColumns {
  readonly personIds: readonly string[];
  readonly accountIds: readonly string[];
  readonly liabilityIds: readonly string[];
  readonly propertyIds: readonly string[];
  readonly incomeCategories: readonly string[];
  /** The stacked tax chart's bands. Empty when the jurisdiction reports no per-category breakdown. */
  readonly taxCategories: readonly string[];
  /** Source ids that ever bore tax — the per-job chart's bands. */
  readonly taxSources: readonly string[];
}

export interface SimulationReport {
  readonly inputs: ReportInputs;
  readonly columns: ReportColumns;
  readonly months: readonly ReportMonth[];
  /** Engine {@link MODEL_ASSUMPTIONS} then the jurisdiction's, each declared where embodied. */
  readonly assumptions: readonly ModelAssumption[];
  /**
   * Echoed back verbatim, opaque to the engine — the one place to round-trip knobs its inputs
   * compiled away (the app records life expectancy, retirement age, health config here).
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

const DEFAULT_START_YEAR = 2026;

/** Shared by income and expense sources so the two cannot drift. */
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
      // Flat DTO with explicit nulls; the kind-split lives only in the derived classes.
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
 * Exposed alongside {@link buildSimulationReport} so a caller that already simulated avoids a
 * second run. Pass `jurisdiction` to add its disclosures to the engine's.
 */
export function summarizeSimulation(
  input: HouseholdSimInput,
  series: ProjectionSeries,
  meta?: Readonly<Record<string, unknown>>,
  jurisdiction?: Jurisdiction,
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
      payrollTaxCents: flows?.payrollTaxCents ?? 0,
      taxByCategoryCents: flows?.taxByCategoryCents,
      taxBySourceCents: flows?.taxBySourceCents,
      deferralBySourceCents: flows?.deferralBySourceCents,
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
    taxCategories: unionKeys(months, (m) => m.taxByCategoryCents ?? {}),
    taxSources: unionKeys(months, (m) => m.taxBySourceCents ?? {}),
  };

  return {
    inputs: echoInputs(input),
    columns,
    months,
    assumptions: [...MODEL_ASSUMPTIONS, ...(jurisdiction?.modelAssumptions ?? [])],
    ...(meta !== undefined ? { meta } : {}),
  };
}

/** Prefer {@link summarizeSimulation} when you already hold the run's {@link ProjectionSeries}. */
export function buildSimulationReport(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
  meta?: Readonly<Record<string, unknown>>,
): SimulationReport {
  return summarizeSimulation(input, simulateHousehold(input, jurisdiction), meta, jurisdiction);
}
