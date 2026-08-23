/**
 * Monthly CASH FLOW chart data — the money arriving, the money leaving, and the difference.
 *
 * Three views over one household month, and the reason they are separate is arithmetic rather
 * than presentation. Money in and money out are different quantities: netting them per SOURCE
 * means deciding which paycheque a tax bill belongs to, and that decision has no honest answer
 * once a filing settles a whole year at once — April's settlement is attributed proportionally
 * across sources, which sends one band far negative and its neighbours far positive while the
 * total stays right. Bands that can go negative cannot be stacked, so the chart used to clamp
 * them and charge the shortfall back on pro rata, and a household with three equal salaries drew
 * ONE of them carrying the whole month's take-home.
 *
 * Nothing here nets anything per source. An inflow band is cash arriving, always positive. An
 * outflow band is cash leaving, always positive. The net view subtracts one total from the other
 * and draws a single line. No clamp, no haircut, no attribution — the pro-rata machinery this
 * file used to carry is gone, and so is the class of bug it existed to paper over.
 *
 * WHAT COUNTS
 *
 * Inflows are money the household RECEIVES: wages, government benefits, a tax refund. Outflows
 * are money it PAYS: income tax, payroll tax, a settled balance due, every budget line, every
 * debt payment.
 *
 * Moving money between the household's own pockets is neither, so EVERY account withdrawal is
 * absent from the inflow side — cash savings, a brokerage sale, a 401(k) or IRA draw, a required
 * distribution — and so are contributions into them. That is what makes the net line worth reading: it is not
 * balanced to zero by construction (every month's waterfall balances, so a chart of all cash
 * movement would say nothing), it is the household's monthly surplus or shortfall. A positive
 * net is what the month saved — the 401(k) deferral included, since a deferral is a gross wage
 * that was never spent. A negative net is exactly the gap the savings had to cover.
 *
 * Savings INTEREST is absent for the same reason: it is credited into the account that earned
 * it and nothing arrives for the month to spend. Banding it counted the same dollar twice, once
 * entering the account and again inside the draw that later took it out.
 *
 * Bands are the engine's own facts — per-source flows (`ProjectionMonthFlows.incomeSources`) and
 * per-obligation costs (`ProjectionMonthFlows.obligations`), each already labelled and
 * categorized. This chart is never a statement of taxable income, and the two genuinely differ:
 * a home down payment's realized gain is taxed and appears in neither.
 */

import type { IncomeSourceCategory, ProjectionSeries } from "@finley/engine";

/**
 * The tax refund's band. Not an engine income source: the refund is a settlement, and the engine
 * reports it as one. Its own category, because it is neither wages, a benefit nor a draw — and
 * because a refund is the one inflow that arrives from the outflow side of the chart.
 */
export const TAX_REFUND_BAND_ID = "tax-refund";
export const TAX_REFUND_CATEGORY = "taxRefund";
export const TAX_REFUND_LABEL = "Tax refund";

/**
 * Tax outflow bands. Simple draws {@link TAX_BAND_ID} alone; Advanced splits it three ways,
 * which is the split the tax chart below already makes and the one a reader asks for first —
 * withholding is a rate, FICA is a different tax, and a settlement is last year's arithmetic
 * landing in this month.
 */
export const TAX_BAND_ID = "tax";
export const TAX_INCOME_BAND_ID = "tax:income";
export const TAX_PAYROLL_BAND_ID = "tax:payroll";
export const TAX_SETTLEMENT_BAND_ID = "tax:settlement";
/** Every tax band's category, so the palette treats them as one family. */
export const TAX_OUTFLOW_CATEGORY = "tax";

/** Which of the three the chart is drawing. */
export type CashFlowView = "inflows" | "outflows" | "net";

export type CashFlowMode = "simple" | "advanced";

/** Retained under its old name for the chart's local state; the views are the new axis. */
export type IncomeMode = CashFlowMode;

/**
 * One stackable band, on either side of the chart. `category` drives colour and stacking order
 * and is an {@link IncomeSourceCategory} on the inflow side, an obligation category or {@link
 * TAX_OUTFLOW_CATEGORY} on the outflow side — deliberately widened to `string` rather than
 * unioned, since the two sides never share a band list.
 */
export interface CashFlowBand {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  /**
   * Which member this band pays — the label names the kind of income, not the earner, so two
   * people's benefits are otherwise indistinguishable. Absent on household bands.
   */
  readonly ownerId?: string;
}

export interface CashFlowMonthRow {
  readonly month: number;
  /** Cash arriving, per inflow band. Never negative. */
  readonly inflowCentsByBand: Readonly<Record<string, number>>;
  /** Cash leaving, per outflow band. Never negative. */
  readonly outflowCentsByBand: Readonly<Record<string, number>>;
  readonly inflowTotalCents: number;
  readonly outflowTotalCents: number;
  /**
   * `inflowTotalCents − outflowTotalCents`. SIGNED, and the only figure on this chart that may
   * be: positive is what the month saved, negative is what it had to draw. Never stacked, which
   * is why it is allowed to be honest.
   */
  readonly netCents: number;
  /**
   * {@link netCents} per person — the engine's own `netCashFlowByPersonCents` with each person's
   * pre-tax deferral added back, since this chart counts a deferral as money the month kept.
   * Σ over this map is {@link netCents} exactly whenever the household covered its obligations,
   * so a reader toggling between Combined and a person is never shown money that appears or
   * vanishes.
   *
   * The split is how the household FUNDS its spending — `sharedScheme`'s share of the shared
   * obligations — not who authored which budget line, because no budget line has an author.
   * Empty for a projection run before the engine reported it.
   */
  readonly netCentsByPerson: Readonly<Record<string, number>>;
  /**
   * Obligations the income must cover: expenses + scheduled liability payments (the waterfall's
   * `sharedObligationCents`). 0 only on a flow-free snapshot. This is the outflow total LESS
   * tax, and it stays a field of its own because the inflow view plots it as the "is it enough"
   * line.
   */
  readonly spendingNeedCents: number;
}

export interface CashFlowChartData {
  readonly rows: readonly CashFlowMonthRow[];
  /** Only the bands that carry money somewhere, in display order. */
  readonly inflowBands: readonly CashFlowBand[];
  readonly outflowBands: readonly CashFlowBand[];
  /** First month with no inflow at all AND no savings drawdown, which a solvent plan never hits. */
  readonly firstMonthWithNoIncome: number | null;
  readonly firstSavingsDrawdownMonth: number | null;
  /** First `ProjectionMonth.isInsolvent` month. */
  readonly firstInsolventMonth: number | null;
  /** Everyone the engine reported a net figure for, in first-appearance order. */
  readonly netOwners: readonly string[];
}

/**
 * Inflow stacking order (bottom → top): the household's own earnings first, then what it is
 * paid, then what a filing hands back. Unrecognised categories sort to the end.
 */
const INFLOW_CATEGORY_ORDER: readonly string[] = [
  "wages",
  "governmentRetirementBenefit",
  "ordinaryIncome",
  "capitalGains",
  "taxExempt",
  "taxedAtAccrual",
  TAX_REFUND_CATEGORY,
];

/**
 * Outflow stacking order (bottom → top): tax at the base because it is taken before the
 * household sees the money, then what it must spend, then what it chooses to, then what it owes.
 */
const OUTFLOW_CATEGORY_ORDER: readonly string[] = [
  TAX_OUTFLOW_CATEGORY,
  "needs",
  "healthcare",
  "wants",
  "savings",
  "debtService",
  "other",
];

function rankIn(order: readonly string[], category: string): number {
  const i = order.indexOf(category);
  return i === -1 ? order.length : i;
}

/**
 * Is this the household RECEIVING money, or moving its own between its own pockets?
 *
 * Only the first is an inflow. Every account withdrawal is the second — cash savings, a
 * brokerage sale, a 401(k) or IRA draw, a required distribution — and the engine flags them all
 * (`fromAccountWithdrawal`) precisely because tax category cannot tell them apart: an elective
 * pre-tax draw, an RMD and a freelance series are all `ordinaryIncome`, and only one of them is
 * money from outside the household.
 *
 * The distinction is what makes the net line mean anything. An account is drawn BECAUSE the
 * month came up short, so counting the draw as income nets the shortfall to exactly zero and
 * hides the thing being measured. Excluding every withdrawal makes the net read the same way
 * whichever account funds a retirement — external income less taxes and spending, before any
 * account is opened.
 *
 * The TAX on a taxable withdrawal is untouched by this: it was really paid, and it stays on the
 * outflow side, so a retirement funded from an IRA correctly shows a deeper shortfall than the
 * same retirement funded from after-tax cash.
 *
 * Savings interest is excluded for a different reason: it is credited into the account that
 * earned it and nothing arrives for the month to spend.
 *
 * A drawdown still REGISTERS (the gap summary and the a11y moments name the month savings first
 * opened), it just never bands.
 */
function isReceivedCash(source: {
  readonly category: string;
  readonly fromAccountWithdrawal?: boolean;
}): boolean {
  return source.fromAccountWithdrawal !== true && source.category !== "savingsInterest";
}

/**
 * The month's tax, split the way it was actually PAID rather than the way it was attributed.
 *
 * `taxCents` is this month's withholding plus the prior year's signed settlement, so the
 * settlement has to come back out to recover the withholding — the same subtraction the tax
 * chart makes, and non-negative by construction. A settlement that is a REFUND draws nothing
 * here: it is money arriving, and it bands on the inflow side.
 */
function taxOutflowsOf(flows: {
  readonly taxCents?: number;
  readonly payrollTaxCents?: number;
  readonly taxSettlementCents?: number;
}): { readonly incomeTaxCents: number; readonly payrollTaxCents: number; readonly settlementCents: number } {
  const settlement = flows.taxSettlementCents ?? 0;
  return {
    incomeTaxCents: Math.max(0, (flows.taxCents ?? 0) - settlement),
    payrollTaxCents: Math.max(0, flows.payrollTaxCents ?? 0),
    settlementCents: Math.max(0, settlement),
  };
}

/**
 * One row per flowed month. Every entry in `months` is processed now — the flow-free "now" is
 * `series.opening`, outside this loop — so month 0 is the first row. Bands carrying nothing
 * across the whole horizon are dropped rather than shown as empty.
 */
export function buildCashFlowChartData(series: ProjectionSeries): CashFlowChartData {
  const rows: CashFlowMonthRow[] = [];
  const inflowSeen = new Map<string, CashFlowBand>();
  const inflowOrder: string[] = [];
  const outflowSeen = new Map<string, CashFlowBand>();
  const outflowOrder: string[] = [];
  const outflowCarriesMoney = new Set<string>();
  let firstMonthWithNoIncome: number | null = null;
  let firstSavingsDrawdownMonth: number | null = null;
  let firstInsolventMonth: number | null = null;
  const netOwners: string[] = [];

  for (const m of series.months) {
    const flows = m.flows;
    if (flows === undefined) continue; // defensive: a flow-free snapshot has no flows to band

    // ——— inflows ———
    const inflowCentsByBand: Record<string, number> = {};
    let inflowTotalCents = 0;
    // Not banded, and tracked only so "nothing at all is covering spending" can stay distinct
    // from "spending is covered by savings" — two very different months that both band nothing.
    let drewOnSavingsCents = 0;
    const addInflow = (band: CashFlowBand, cents: number): void => {
      if (cents <= 0) return;
      inflowCentsByBand[band.id] = (inflowCentsByBand[band.id] ?? 0) + cents;
      inflowTotalCents += cents;
      if (!inflowSeen.has(band.id)) {
        inflowSeen.set(band.id, band);
        inflowOrder.push(band.id);
      }
    };
    for (const s of flows.incomeSources ?? []) {
      if (s.fromAccountWithdrawal === true) {
        drewOnSavingsCents += s.cashInflowCents;
        if (s.cashInflowCents > 0 && firstSavingsDrawdownMonth === null) {
          firstSavingsDrawdownMonth = m.month;
        }
      }
      if (s.cashInflowCents === 0 || !isReceivedCash(s)) continue;
      addInflow(
        {
          id: s.sourceId,
          label: s.label,
          category: s.category as IncomeSourceCategory,
          ...(s.ownerId !== undefined ? { ownerId: s.ownerId } : {}),
        },
        s.cashInflowCents,
      );
    }
    // Money back from last April, arriving whole. Nothing is taken off any other band to make
    // room for it: the inflow side is gross, so no source was ever netted against it.
    addInflow(
      { id: TAX_REFUND_BAND_ID, label: TAX_REFUND_LABEL, category: TAX_REFUND_CATEGORY },
      Math.max(0, -(flows.taxSettlementCents ?? 0)),
    );

    // ——— outflows ———
    const outflowCentsByBand: Record<string, number> = {};
    let outflowTotalCents = 0;
    const addOutflow = (band: CashFlowBand, cents: number, dense = false): void => {
      if (cents === 0 && !dense) return;
      outflowCentsByBand[band.id] = (outflowCentsByBand[band.id] ?? 0) + cents;
      outflowTotalCents += cents;
      if (cents > 0) outflowCarriesMoney.add(band.id);
      if (!outflowSeen.has(band.id)) {
        outflowSeen.set(band.id, band);
        outflowOrder.push(band.id);
      }
    };
    const tax = taxOutflowsOf(flows);
    addOutflow(
      { id: TAX_INCOME_BAND_ID, label: "Income tax", category: TAX_OUTFLOW_CATEGORY },
      tax.incomeTaxCents,
    );
    addOutflow(
      { id: TAX_PAYROLL_BAND_ID, label: "Payroll tax (FICA)", category: TAX_OUTFLOW_CATEGORY },
      tax.payrollTaxCents,
    );
    addOutflow(
      { id: TAX_SETTLEMENT_BAND_ID, label: "Tax settlement", category: TAX_OUTFLOW_CATEGORY },
      tax.settlementCents,
    );
    for (const o of flows.obligations ?? []) {
      // Dense on purpose: a dormant budget line still exists, and a stacked area reads a missing
      // key as a gap rather than a zero, shifting every band above it.
      addOutflow({ id: o.id, label: o.label, category: o.category }, o.amountCents, true);
    }

    if (inflowTotalCents === 0 && drewOnSavingsCents === 0 && firstMonthWithNoIncome === null) {
      firstMonthWithNoIncome = m.month;
    }
    if (m.isInsolvent && firstInsolventMonth === null) firstInsolventMonth = m.month;

    // Per-person net: the engine's SIGNED figure, plus what the month put away for them pre-tax.
    // The deferral has to come back because the inflow side above is GROSS — it bands
    // `cashInflowCents` — so a month that deferred $500 reads as $500 kept on the household
    // line, and a person's line has to agree or the parts stop summing to the whole.
    //
    // `netCashFlowByPersonCents`, never `leftoverByPersonCents`: the latter floors at zero, so a
    // retired household spending $8,900/mo more than it receives would draw both partners flat
    // at $0 under a household line deep underwater.
    const netByPerson = flows.netCashFlowByPersonCents ?? {};
    const deferredByPerson = flows.deferredByPersonCents ?? {};
    const netCentsByPerson: Record<string, number> = {};
    for (const pid of new Set([...Object.keys(netByPerson), ...Object.keys(deferredByPerson)])) {
      netCentsByPerson[pid] = (netByPerson[pid] ?? 0) + (deferredByPerson[pid] ?? 0);
      if (!netOwners.includes(pid)) netOwners.push(pid);
    }

    rows.push({
      month: m.month,
      inflowCentsByBand,
      outflowCentsByBand,
      inflowTotalCents,
      outflowTotalCents,
      netCents: inflowTotalCents - outflowTotalCents,
      netCentsByPerson,
      spendingNeedCents: (flows.expensesCents ?? 0) + (flows.liabilityPaymentsCents ?? 0),
    });
  }

  const inflowBands = inflowOrder
    .map((id) => inflowSeen.get(id)!)
    // Ties broken by first appearance (already in `inflowOrder`).
    .sort((a, b) => rankIn(INFLOW_CATEGORY_ORDER, a.category) - rankIn(INFLOW_CATEGORY_ORDER, b.category));
  const drawnOutflows = outflowOrder.filter((id) => outflowCarriesMoney.has(id));
  const outflowBands = drawnOutflows
    .map((id) => outflowSeen.get(id)!)
    .sort((a, b) => rankIn(OUTFLOW_CATEGORY_ORDER, a.category) - rankIn(OUTFLOW_CATEGORY_ORDER, b.category));

  // A band dropped for never carrying money must not leave zeros behind in the rows, which are
  // also what the a11y table and the hidden test mirrors read.
  const drawn = new Set(drawnOutflows);
  const trimmed =
    drawn.size === outflowOrder.length
      ? rows
      : rows.map((row) => ({
          ...row,
          outflowCentsByBand: Object.fromEntries(
            Object.entries(row.outflowCentsByBand).filter(([id]) => drawn.has(id)),
          ),
        }));

  return {
    rows: trimmed,
    inflowBands,
    outflowBands,
    firstMonthWithNoIncome,
    firstSavingsDrawdownMonth,
    firstInsolventMonth,
    netOwners,
  };
}

/** Band ids the Simple view collapses onto; wages stay per job. */
const SIMPLE_SOCIAL_SECURITY_ID = "social-security";

/**
 * Wages stay per job; the government benefit collapses per person, since two members claim at
 * their own ages. There is no "Living off savings" band to collapse onto any more — a drawdown
 * is not an inflow, and the net view is where the gap it fills shows up.
 */
function simpleInflowBandOf(band: CashFlowBand): CashFlowBand {
  if (band.category === "governmentRetirementBenefit") {
    return {
      id: band.ownerId === undefined ? SIMPLE_SOCIAL_SECURITY_ID : `${SIMPLE_SOCIAL_SECURITY_ID}:${band.ownerId}`,
      label: "Social Security",
      category: "governmentRetirementBenefit",
      ...(band.ownerId !== undefined ? { ownerId: band.ownerId } : {}),
    };
  }
  return band;
}

/** Human labels for the categories Simple collapses spending onto. */
const OUTFLOW_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  needs: "Needs",
  wants: "Wants",
  healthcare: "Healthcare",
  savings: "Savings lines",
  debtService: "Debt payments",
  other: "Other spending",
};

/**
 * Every tax band folds into one; every obligation folds onto its category. The three tax bands
 * are one fact split three ways, and the reader who wants that split is the reader who asked for
 * Advanced.
 */
function simpleOutflowBandOf(band: CashFlowBand): CashFlowBand {
  if (band.category === TAX_OUTFLOW_CATEGORY) {
    return { id: TAX_BAND_ID, label: "Taxes", category: TAX_OUTFLOW_CATEGORY };
  }
  return {
    id: `spend:${band.category}`,
    label: OUTFLOW_CATEGORY_LABELS[band.category] ?? "Other spending",
    category: band.category,
  };
}

/**
 * Only when two or more benefit bands are on the chart, so a single-earner plan gains no
 * redundant "· Alex". Wage bands already carry the job's own name.
 */
function withEarnerNames(
  bands: readonly CashFlowBand[],
  personNames: ReadonlyMap<string, string>,
): readonly CashFlowBand[] {
  const owners = new Set(
    bands
      .filter((b) => b.category === "governmentRetirementBenefit")
      .map((b) => b.ownerId)
      .filter((id): id is string => id !== undefined),
  );
  if (owners.size < 2) return bands;
  return bands.map((b) => {
    if (b.category !== "governmentRetirementBenefit" || b.ownerId === undefined) return b;
    const name = personNames.get(b.ownerId);
    return name === undefined ? b : { ...b, label: `${b.label} · ${name}` };
  });
}

/** One month, reduced to the bands the chosen view stacks. */
export interface CashFlowViewRow {
  readonly month: number;
  readonly centsByBand: Readonly<Record<string, number>>;
  readonly totalCents: number;
  readonly netCents: number;
  readonly spendingNeedCents: number;
}

export interface CashFlowViewData {
  readonly bands: readonly CashFlowBand[];
  readonly rows: readonly CashFlowViewRow[];
}

/**
 * Fold the data for one view. `net` stacks nothing — it carries no bands at all, and the chart
 * draws {@link CashFlowViewRow.netCents} as a single signed series. `advanced` keeps every band;
 * `simple` collapses via {@link simpleInflowBandOf} / {@link simpleOutflowBandOf}.
 *
 * `ownerId` cuts the chart down to one person, on the INFLOW and NET views. Cash arriving is
 * attributed to whoever receives it, and the engine reports what each person had left once
 * their share of the household's obligations was paid. Cash LEAVING is still not attributable:
 * every budget line compiles under the primary person whoever it is really for (see {@link
 * CashFlowBand.ownerId}), so a per-person outflow stack would draw the primary paying for the
 * whole household and the partner paying almost nothing. The OUTFLOW view therefore ignores it.
 */
export function cashFlowBandsForView(
  data: CashFlowChartData,
  view: CashFlowView,
  mode: CashFlowMode = "simple",
  personNames: ReadonlyMap<string, string> = new Map(),
  ownerId?: string,
): CashFlowViewData {
  if (view === "net") {
    return {
      bands: [],
      rows: data.rows.map((r) => {
        // A person with no reported figure draws 0 rather than the household's line, which
        // would silently show them the whole household's net under their own name.
        const net = ownerId === undefined ? r.netCents : (r.netCentsByPerson[ownerId] ?? 0);
        return {
          month: r.month,
          centsByBand: {},
          totalCents: net,
          netCents: net,
          spendingNeedCents: r.spendingNeedCents,
        };
      }),
    };
  }

  const inflows = view === "inflows";
  const all = inflows ? data.inflowBands : data.outflowBands;
  // Cut before collapsing: Simple folds two people's benefits onto one band, so filtering
  // afterwards would have nothing left to filter by.
  const sourceBands =
    inflows && ownerId !== undefined ? all.filter((b) => b.ownerId === ownerId) : all;
  const order = inflows ? INFLOW_CATEGORY_ORDER : OUTFLOW_CATEGORY_ORDER;
  const centsOf = (r: CashFlowMonthRow) => (inflows ? r.inflowCentsByBand : r.outflowCentsByBand);

  const bandForSource = new Map<string, CashFlowBand>();
  const collapsed = new Map<string, CashFlowBand>();
  const collapsedOrder: string[] = [];
  for (const b of sourceBands) {
    const band =
      mode === "advanced" ? b : inflows ? simpleInflowBandOf(b) : simpleOutflowBandOf(b);
    bandForSource.set(b.id, band);
    if (!collapsed.has(band.id)) {
      collapsed.set(band.id, band);
      collapsedOrder.push(band.id);
    }
  }
  const bands = withEarnerNames(
    collapsedOrder
      .map((id) => collapsed.get(id)!)
      .sort((a, b) => rankIn(order, a.category) - rankIn(order, b.category)),
    personNames,
  );

  const rows = data.rows.map((r) => {
    const centsByBand: Record<string, number> = {};
    let totalCents = 0;
    for (const [sourceId, cents] of Object.entries(centsOf(r))) {
      const bandId = bandForSource.get(sourceId)?.id;
      if (bandId === undefined) continue; // a band dropped for carrying nothing anywhere
      centsByBand[bandId] = (centsByBand[bandId] ?? 0) + cents;
      totalCents += cents;
    }
    return {
      month: r.month,
      centsByBand,
      totalCents,
      netCents: r.netCents,
      spendingNeedCents: r.spendingNeedCents,
    };
  });
  return { bands, rows };
}

/** 1-based, for a human-facing "Year N" label. */
function yearOf(month: number): number {
  return Math.floor(month / 12) + 1;
}

/** A one-line summary for the a11y label, or `null` when income covers spending throughout. */
export function describeCashFlowGap(data: CashFlowChartData): string | null {
  if (data.firstSavingsDrawdownMonth !== null) {
    return (
      `From Year ${yearOf(data.firstSavingsDrawdownMonth)} you're living off savings — ` +
      `net cash flow turns negative and the gap comes out of what you've saved.`
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
