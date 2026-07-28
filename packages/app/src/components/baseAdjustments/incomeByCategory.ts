/**
 * Monthly income graph data, the income-side companion to {@link import("./perLineBudget")}.
 *
 * Bands are the engine's per-source flows (`ProjectionMonthFlows.incomeSources`), not tax
 * buckets, so each band names *which* job pays and *which* account a draw drains. Banding by
 * `incomeByCategoryCents` (a tax classification) collapsed two jobs into one band.
 */

import type { IncomeSourceCategory, ProjectionSeries } from "@finley/engine";

export interface IncomeSourceBand {
  readonly id: string;
  readonly label: string;
  /** Drives band colour and display order. */
  readonly category: IncomeSourceCategory;
  /**
   * Which member this band pays — the label names the kind of income, not the earner, so
   * two people's benefits are otherwise indistinguishable. Absent on household sources.
   */
  readonly ownerId?: string;
}

export interface IncomeMonthRow {
  readonly month: number;
  /** Realized cash, pre-tax and pre-deferral. */
  readonly centsBySource: Readonly<Record<string, number>>;
  /**
   * The engine's per-source `netCashFlowCents` (cash inflow − deferral − tax) read straight
   * through; re-deriving it in the app silently dropped savings-interest's tax. SIGNED — a
   * source whose deductions exceed its inflow is genuinely negative; only the stacked band
   * clamps at 0, never here.
   */
  readonly netCentsBySource: Readonly<Record<string, number>>;
  readonly totalCents: number;
  /** Σ of `netCentsBySource`. */
  readonly takeHomeCents: number;
  /**
   * Obligations the income must cover: expenses + scheduled liability payments (the
   * waterfall's `sharedObligationCents`). 0 only on a flow-free snapshot.
   */
  readonly spendingNeedCents: number;
}

export interface IncomeChartData {
  readonly rows: readonly IncomeMonthRow[];
  /** Only the sources that carry money somewhere, in display order. */
  readonly sources: readonly IncomeSourceBand[];
  /** First month with no income AND no savings drawdown, which a solvent plan never hits. */
  readonly firstMonthWithNoIncome: number | null;
  readonly firstSavingsDrawdownMonth: number | null;
  /** First `ProjectionMonth.isInsolvent` month. */
  readonly firstInsolventMonth: number | null;
}

export type IncomeMode = "simple" | "advanced";

/**
 * `takeHome` (default) is each source's cash after its own tax and pre-tax deferral, the
 * only basis comparable to the spending-need line; `gross` is the pre-tax paycheck.
 */
export type IncomeBasis = "takeHome" | "gross";

/**
 * Stacking order (bottom → top): genuine income kinds at the base, then the "living off
 * savings" family as one contiguous group, so Simple's one collapsed band and Advanced's
 * several read the same way. Unrecognised categories sort to the end.
 */
const CATEGORY_ORDER: readonly IncomeSourceCategory[] = [
  "wages",
  "governmentRetirementBenefit",
  "savingsInterest",
  "ordinaryIncome",
  "capitalGains",
  "taxExempt",
  "savingsDrawdown",
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category as IncomeSourceCategory);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * One row per flowed month. Every entry in `months` is processed now — the flow-free "now" is
 * `series.opening`, outside this loop — so month 0 is the first row. Sources carrying nothing
 * across the whole horizon are dropped rather than shown as empty bands.
 */
export function buildIncomeChartData(series: ProjectionSeries): IncomeChartData {
  const rows: IncomeMonthRow[] = [];
  const seen = new Map<string, IncomeSourceBand>();
  const order: string[] = [];
  let firstMonthWithNoIncome: number | null = null;
  let firstSavingsDrawdownMonth: number | null = null;
  let firstInsolventMonth: number | null = null;

  for (const m of series.months) {
    const sources = m.flows?.incomeSources;
    if (sources === undefined) continue; // defensive: a flow-free snapshot has no sources

    const centsBySource: Record<string, number> = {};
    const netCentsBySource: Record<string, number> = {};
    let totalCents = 0;
    let takeHomeCents = 0;
    for (const s of sources) {
      if (s.cashInflowCents === 0) continue;
      centsBySource[s.sourceId] = (centsBySource[s.sourceId] ?? 0) + s.cashInflowCents;
      totalCents += s.cashInflowCents;
      netCentsBySource[s.sourceId] = (netCentsBySource[s.sourceId] ?? 0) + s.netCashFlowCents;
      takeHomeCents += s.netCashFlowCents;
      if (!seen.has(s.sourceId)) {
        seen.set(s.sourceId, {
          id: s.sourceId,
          label: s.label,
          category: s.category,
          ...(s.ownerId !== undefined ? { ownerId: s.ownerId } : {}),
        });
        order.push(s.sourceId);
      }
      if (s.category === "savingsDrawdown" && firstSavingsDrawdownMonth === null) {
        firstSavingsDrawdownMonth = m.month;
      }
    }
    if (totalCents === 0 && firstMonthWithNoIncome === null) firstMonthWithNoIncome = m.month;
    if (m.isInsolvent && firstInsolventMonth === null) firstInsolventMonth = m.month;
    const spendingNeedCents = (m.flows?.expensesCents ?? 0) + (m.flows?.liabilityPaymentsCents ?? 0);
    rows.push({ month: m.month, centsBySource, netCentsBySource, totalCents, takeHomeCents, spendingNeedCents });
  }

  const sources = order
    .map((id) => seen.get(id)!)
    // Ties broken by first appearance (already in `order`).
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category));

  return { rows, sources, firstMonthWithNoIncome, firstSavingsDrawdownMonth, firstInsolventMonth };
}

/** Band ids the Simple view collapses onto; wages stay per job. */
const SIMPLE_SOCIAL_SECURITY_ID = "social-security";
const SIMPLE_SAVINGS_INTEREST_ID = "savings-interest";
const SIMPLE_LIVING_OFF_SAVINGS_ID = "living-off-savings";

/**
 * Wages stay per job; savings interest keeps its own band (income the savings EARN, not
 * principal spent); the government benefit collapses per person, since two members claim at
 * their own ages; every drawdown folds into one "Living off savings" band.
 *
 * Interest is matched on the `"savingsInterest"` provenance category, not its id: it is
 * *taxed* as `ordinaryIncome`, shared with pre-tax account draws.
 */
function simpleBandOf(band: IncomeSourceBand): IncomeSourceBand {
  if (band.category === "wages") return band;
  if (band.category === "savingsInterest") {
    return { id: SIMPLE_SAVINGS_INTEREST_ID, label: "Savings interest", category: "savingsInterest" };
  }
  if (band.category === "governmentRetirementBenefit") {
    return {
      id: band.ownerId === undefined ? SIMPLE_SOCIAL_SECURITY_ID : `${SIMPLE_SOCIAL_SECURITY_ID}:${band.ownerId}`,
      label: "Social Security",
      category: "governmentRetirementBenefit",
      ...(band.ownerId !== undefined ? { ownerId: band.ownerId } : {}),
    };
  }
  return { id: SIMPLE_LIVING_OFF_SAVINGS_ID, label: "Living off savings", category: "savingsDrawdown" };
}

function rowCentsFor(row: IncomeMonthRow, basis: IncomeBasis): Readonly<Record<string, number>> {
  return basis === "gross" ? row.centsBySource : row.netCentsBySource;
}

/**
 * Only when two or more benefit bands are on the chart, so a single-earner plan gains no
 * redundant "· Alex". Wage bands already carry the job's own name.
 */
function withEarnerNames(
  sources: readonly IncomeSourceBand[],
  personNames: ReadonlyMap<string, string>,
): readonly IncomeSourceBand[] {
  const owners = new Set(
    sources
      .filter((s) => s.category === "governmentRetirementBenefit")
      .map((s) => s.ownerId)
      .filter((id): id is string => id !== undefined),
  );
  if (owners.size < 2) return sources;
  return sources.map((s) => {
    if (s.category !== "governmentRetirementBenefit" || s.ownerId === undefined) return s;
    const name = personNames.get(s.ownerId);
    return name === undefined ? s : { ...s, label: `${s.label} · ${name}` };
  });
}

/**
 * The engine reports one interest band per cash account, labelled by the account's name.
 * Prefix it (`Savings interest: Cash savings`) only when two or more are on the chart, so a
 * single account reads as the plain band Simple shows.
 */
function qualifySavingsInterestNames(
  sources: readonly IncomeSourceBand[],
): readonly IncomeSourceBand[] {
  const interest = sources.filter((s) => s.category === "savingsInterest");
  if (interest.length === 0) return sources;
  return sources.map((s) => {
    if (s.category !== "savingsInterest") return s;
    return interest.length === 1
      ? { ...s, label: "Savings interest" }
      : { ...s, label: `Savings interest: ${s.label}` };
  });
}

/**
 * `advanced` keeps every source its own band; `simple` collapses via {@link simpleBandOf}.
 * The returned rows' `centsBySource` carries whichever {@link IncomeBasis} was chosen, so
 * the chart renders it without knowing which; `totalCents` is recomputed to match.
 */
export function incomeBandsForMode(
  data: IncomeChartData,
  mode: IncomeMode,
  basis: IncomeBasis = "takeHome",
  personNames: ReadonlyMap<string, string> = new Map(),
): { readonly sources: readonly IncomeSourceBand[]; readonly rows: readonly IncomeMonthRow[] } {
  if (mode === "advanced") {
    const rows = data.rows.map((r) => {
      const centsBySource = rowCentsFor(r, basis);
      const totalCents = Object.values(centsBySource).reduce((s, c) => s + c, 0);
      return { ...r, centsBySource, totalCents };
    });
    return { sources: qualifySavingsInterestNames(withEarnerNames(data.sources, personNames)), rows };
  }

  const bandForSource = new Map<string, IncomeSourceBand>();
  const collapsed = new Map<string, IncomeSourceBand>();
  const order: string[] = [];
  for (const s of data.sources) {
    const band = simpleBandOf(s);
    bandForSource.set(s.id, band);
    if (!collapsed.has(band.id)) {
      collapsed.set(band.id, band);
      order.push(band.id);
    }
  }
  const sources = withEarnerNames(
    order.map((id) => collapsed.get(id)!).sort((a, b) => categoryRank(a.category) - categoryRank(b.category)),
    personNames,
  );

  const rows = data.rows.map((r) => {
    const centsBySource: Record<string, number> = {};
    let totalCents = 0;
    for (const [srcId, cents] of Object.entries(rowCentsFor(r, basis))) {
      const bandId = bandForSource.get(srcId)?.id ?? srcId;
      centsBySource[bandId] = (centsBySource[bandId] ?? 0) + cents;
      totalCents += cents;
    }
    return { ...r, centsBySource, totalCents };
  });
  return { sources, rows };
}

/** 1-based, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/** A one-line summary for the a11y label, or `null` when income covers spending throughout. */
export function describeIncomeGap(data: IncomeChartData): string | null {
  if (data.firstSavingsDrawdownMonth !== null) {
    return (
      `From Year ${yearOf(data.firstSavingsDrawdownMonth)} you're living off savings — ` +
      `the drawdown band is spending covered by cash, not income.`
    );
  }
  if (data.firstMonthWithNoIncome !== null) {
    return (
      `No cash coming in and no savings left from Year ${yearOf(data.firstMonthWithNoIncome)} — ` +
      `nothing is covering spending here.`
    );
  }
  return null;
}
