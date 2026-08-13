/**
 * Monthly income-source chart data, the income-side companion to {@link import("./perLineBudget")}.
 * Prepares the source bands and per-month rows the income chart stacks, and collapses them into
 * Simple and Advanced views ({@link incomeBandsForMode}); the pure-data half of the chart, free
 * of Recharts.
 *
 * Bands are the engine's per-source flows (`ProjectionMonthFlows.incomeSources`), not tax
 * buckets, so each band names *which* job pays and *which* account a draw drains. Banding by
 * `incomeByCategoryCents` (a tax classification) collapsed two jobs into one band.
 */

import { apportionByWeight, type IncomeSourceCategory, type ProjectionSeries } from "@finley/engine";

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
 * Savings interest is NOT a cash flow to the household, and does not band here.
 *
 * It is credited straight into the account that earned it — the balance rises, and nothing
 * arrives for the month to spend (the engine says as much: `waterfallInflowCents` 0). Banding it
 * counts the same dollar twice, once entering the account and again inside the draw that later
 * takes it out: a month drawing $4,130.07 from a fund just credited $13.68 of interest showed
 * $4,143.75 of cash against $4,130.07 the account actually released.
 *
 * The band only ever existed because of a TAX fact — the engine reports accrued return exactly
 * when the jurisdiction taxes it at accrual (`taxAtAccrual`), which is why a savings account's
 * interest gets a band and the retirement account's identical growth does not. That belongs on
 * the tax chart, where interest genuinely is income and is what can pull a benefit into
 * taxability; on a chart whose contract is money that reaches the checking account, it is the
 * same overstatement the take-home basis exists to avoid.
 *
 * Dropped in BOTH bases. Gross reads "raw earning power", which is arguable — but a band that
 * appears and vanishes with a checkbox reads worse than either consistent answer, and the
 * double-count is at its most visible in gross.
 */
function isHouseholdCashFlow(category: string): boolean {
  return category !== "savingsInterest";
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
    // Tax borne by a source this chart does not band (see {@link isHouseholdCashFlow}). The band
    // goes, the tax stays: it was really charged, so dropping it with the band would hand the
    // household back money it actually paid and put the overstatement straight back. Moved onto
    // the bands that remain, the same rule the engine applies to tax stranded on a source that
    // banded no cash at all.
    let droppedHaircutCents = 0;
    for (const s of sources) {
      if (s.cashInflowCents === 0) continue;
      if (!isHouseholdCashFlow(s.category)) {
        droppedHaircutCents += s.cashInflowCents - s.netCashFlowCents;
        continue;
      }
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
    // Pro rata by cash delivered, largest-remainder, so the shares sum to the dropped haircut
    // exactly and the stack still lands on the cent. Only `netCentsBySource` moves — gross is
    // pre-tax by definition and has nothing to redistribute.
    if (droppedHaircutCents !== 0) {
      const shares = apportionByWeight(
        droppedHaircutCents,
        Object.entries(centsBySource).map(([id, cents]) => [id, cents] as const),
      );
      for (const [id, share] of shares) {
        netCentsBySource[id] = (netCentsBySource[id] ?? 0) - share;
        takeHomeCents -= share;
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
const SIMPLE_LIVING_OFF_SAVINGS_ID = "living-off-savings";

/**
 * Wages stay per job; the government benefit collapses per person, since two members claim at
 * their own ages; every drawdown folds into one "Living off savings" band.
 *
 * Savings interest has no case here because it never reaches this far — {@link
 * isHouseholdCashFlow} drops it before banding, as growth credited to an account rather than
 * cash paid to the household.
 */
function simpleBandOf(band: IncomeSourceBand): IncomeSourceBand {
  if (band.category === "wages") return band;
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
    return { sources: withEarnerNames(data.sources, personNames), rows };
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
