/**
 * Monthly tax-paid graph data, sharing the income and per-line budget charts' x-axis and
 * month-selection gesture. Tax is never a budget line — it is netted out of every drawdown at
 * the chokepoint, leaving it implicit in those charts.
 *
 * `taxCents` here is the household's WHOLE tax burden — federal income tax plus employee
 * payroll tax (FICA) — never just one of the two. It STACKS BY INCOME SOURCE, and within a
 * source further splits INCOME TAX from PAYROLL TAX into their own bands: US tax is not
 * linearly separable, so the jurisdiction owns category attribution and the engine splits
 * each kind's tax across its sources by taxable/earned weight into
 * `ProjectionMonthFlows.taxBySourceCents` and `payrollTaxBySourceCents` respectively.
 * Attribution is required of every jurisdiction that charges either tax and enforced to
 * reconcile; a zero-tax plan has no bands.
 *
 * ⚠ The per-source split is proportional (average-rate), not marginal — disclosed as
 * `taxAttributionProportional`.
 *
 * Pure — no charting-library dependency, so unit-testable in node.
 */

import type { IncomeSourceCategory, ProjectionSeries } from "@finley/engine";
import { yearOf } from "../../format";

/** Which tax this band represents — drives its label suffix and colour family. */
export type TaxBandKind = "incomeTax" | "payrollTax";

export interface TaxSourceBand {
  /**
   * The chart's stable dataKey. For an income-tax band this is the engine's source id
   * unchanged (a job's id, an account draw, or a category fallback); a payroll-tax band's id
   * is that SAME source id with a suffix, so the two bands for one source never collide.
   */
  readonly id: string;
  readonly label: string;
  /** Provenance category — drives band colour family and stacking order. */
  readonly category: string;
  /** Income tax or FICA — a source with both charges draws two adjacent bands. */
  readonly kind: TaxBandKind;
}

export interface TaxMonthRow {
  readonly month: number;
  /** Total tax this month — income tax plus payroll tax, Σ of every per-source band. */
  readonly taxCents: number;
  /** Empty when no per-source breakdown is reported. Keyed by {@link TaxSourceBand.id}. */
  readonly centsBySource: Readonly<Record<string, number>>;
}

/** Suffix distinguishing a source's payroll-tax band id from its income-tax id. */
const PAYROLL_BAND_SUFFIX = "::fica";

function payrollBandId(sourceId: string): string {
  return `${sourceId}${PAYROLL_BAND_SUFFIX}`;
}

export interface TaxChartData {
  readonly rows: readonly TaxMonthRow[];
  /**
   * Income sources carrying tax somewhere, in stable stacking order. A source zero across
   * the whole horizon is dropped, so no legend entry is empty.
   */
  readonly sources: readonly TaxSourceBand[];
  /** False for a zero-tax plan, which attributes nothing. */
  readonly hasSourceBreakdown: boolean;
  /** Total nominal tax across the whole horizon. */
  readonly totalCents: number;
  /** The largest single month's tax and the month it falls in. */
  readonly peakMonthlyCents: number;
  readonly peakMonth: number;
  /** False for a null jurisdiction, or an all-exempt plan. */
  readonly hasAnyTax: boolean;
}

/**
 * Labels for a source keyed only by its tax CATEGORY — the engine's fallback key for an
 * untitled source (e.g. a wage stream with no job id).
 */
const TAX_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  wages: "Wages",
  governmentRetirementBenefit: "Social Security",
  ordinaryIncome: "Ordinary income",
  capitalGains: "Capital gains",
  taxedAtAccrual: "Cash savings",
  taxExempt: "Tax-exempt",
};

/** Stacking order (bottom → top) by provenance category, matching the income chart. */
const CATEGORY_ORDER: readonly IncomeSourceCategory[] = [
  "wages",
  "governmentRetirementBenefit",
  "savingsInterest",
  "ordinaryIncome",
  "capitalGains",
  "taxExempt",
  "taxedAtAccrual",
  "savingsDrawdown",
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category as IncomeSourceCategory);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Name a tax source with no income band to borrow a label from — an untitled stream the
 * engine keyed by its bare tax category. (A source with real provenance, e.g. a job or
 * savings interest, appears on the income side and lends its label via the registry.)
 * Display fallback only: it assigns no business meaning — what counts as "savings
 * interest" is the engine's provenance. Unrecognised keeps its id, sorts last.
 */
function bandForTaxOnlyKey(id: string, kind: TaxBandKind): TaxSourceBand {
  const bandId = kind === "payrollTax" ? payrollBandId(id) : id;
  const label = kind === "payrollTax" ? `${id} — FICA` : id;
  const trailing = id.split(":").pop() ?? id;
  if (TAX_CATEGORY_LABELS[trailing]) {
    const base = TAX_CATEGORY_LABELS[trailing]!;
    return { id: bandId, label: kind === "payrollTax" ? `${base} — FICA` : base, category: trailing, kind };
  }
  if (TAX_CATEGORY_LABELS[id]) {
    const base = TAX_CATEGORY_LABELS[id]!;
    return { id: bandId, label: kind === "payrollTax" ? `${base} — FICA` : base, category: id, kind };
  }
  return { id: bandId, label, category: id, kind };
}

/**
 * Tax chart data from a projection series. One row per flowed month — every entry in `months`
 * now carries flows (the flow-free "now" rides `series.opening`, outside this loop), so the
 * guard below only trips on a defensively-empty snapshot. `taxCents` is the household's WHOLE
 * tax burden (income tax plus payroll tax); Σ of every per-source band equals it exactly, by
 * the engine's enforced attribution contract on each of `taxBySourceCents` and
 * `payrollTaxBySourceCents` individually. The union of sources that ever carry either tax
 * becomes the bands — up to two per source (income tax, payroll tax) — named from the month's
 * `incomeSources` where available.
 */
export function buildTaxChartData(series: ProjectionSeries): TaxChartData {
  const rows: TaxMonthRow[] = [];
  let totalCents = 0;
  let peakMonthlyCents = 0;
  let peakMonth = 0;
  let hasSourceBreakdown = false;
  // Label/category per source id, learned from the income-source flows; a source with no
  // income band falls back to a category label below.
  const registry = new Map<string, { label: string; category: string }>();
  // Band id → its underlying source id and tax kind, in first-appearance order (Map
  // insertion order) — first-appearance is by INCOME-TAX sources, then PAYROLL-TAX sources,
  // then by month, so a source's two bands land adjacent in the legend/stack.
  const bandsSeen = new Map<string, { sourceId: string; kind: TaxBandKind }>();
  const sourceTotals = new Map<string, number>();

  for (const m of series.months) {
    const flows = m.flows;
    if (flows === undefined) continue; // defensive: a flow-free snapshot carries no tax
    for (const s of flows.incomeSources ?? []) {
      if (!registry.has(s.sourceId)) registry.set(s.sourceId, { label: s.label, category: s.category });
    }

    const incomeTaxCents = Math.max(0, flows.taxCents ?? 0);
    const payrollTaxCents = Math.max(0, flows.payrollTaxCents ?? 0);
    const taxCents = incomeTaxCents + payrollTaxCents;
    totalCents += taxCents;
    if (taxCents > peakMonthlyCents) {
      peakMonthlyCents = taxCents;
      peakMonth = m.month;
    }

    // Both breakdowns are always present (`{}` in a month charging none).
    const centsBySource: Record<string, number> = {};
    const addBand = (sourceId: string, kind: TaxBandKind, cents: number | undefined): void => {
      const value = Math.max(0, cents ?? 0);
      if (value === 0) return;
      const bandId = kind === "payrollTax" ? payrollBandId(sourceId) : sourceId;
      hasSourceBreakdown = true;
      centsBySource[bandId] = (centsBySource[bandId] ?? 0) + value;
      sourceTotals.set(bandId, (sourceTotals.get(bandId) ?? 0) + value);
      if (!bandsSeen.has(bandId)) bandsSeen.set(bandId, { sourceId, kind });
    };
    for (const [sourceId, cents] of Object.entries(flows.taxBySourceCents ?? {})) {
      addBand(sourceId, "incomeTax", cents);
    }
    for (const [sourceId, cents] of Object.entries(flows.payrollTaxBySourceCents ?? {})) {
      addBand(sourceId, "payrollTax", cents);
    }
    rows.push({ month: m.month, taxCents, centsBySource });
  }

  const sources: TaxSourceBand[] = [...bandsSeen.entries()]
    .map(([bandId, { sourceId, kind }]) => {
      const known = registry.get(sourceId);
      if (known !== undefined) {
        return {
          id: bandId,
          label: kind === "payrollTax" ? `${known.label} — FICA` : known.label,
          category: known.category,
          kind,
        };
      }
      return bandForTaxOnlyKey(sourceId, kind);
    })
    // Ties keep first-appearance order — sort is stable.
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category));

  return {
    rows,
    sources,
    hasSourceBreakdown,
    totalCents,
    peakMonthlyCents,
    peakMonth,
    hasAnyTax: totalCents > 0,
  };
}

/** Whole dollars, grouped — the chart axis uses `formatDollars` instead. */
function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** One-line summary for the a11y label / status line. `null` when the plan pays no tax. */
export function describeTaxes(data: TaxChartData): string | null {
  if (!data.hasAnyTax) return null;
  return (
    `${dollars(data.totalCents)} in tax over the plan, peaking around ` +
    `${dollars(data.peakMonthlyCents)}/mo in Year ${yearOf(data.peakMonth)}. ` +
    `Federal income and payroll (FICA) tax only.`
  );
}
