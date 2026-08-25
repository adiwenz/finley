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
 * WHOSE
 *
 * Either side can be cut to one member, and the two sides are cut differently because they are
 * differently attributable. An inflow band BELONGS to whoever receives it — a paycheque, a
 * benefit, a tax refund — so a person's stack is a subset of the household's bands. An outflow
 * band is a household line whose per-person amount is a separate figure the engine states
 * ({@link CashFlowMonthRow.outflowCentsByBandByPerson}): the same band id, a different number,
 * plus {@link SHARED_SPENDING_BAND_ID} for the shared lines, which have no per-person amount at
 * all. Nothing here derives a person's share from the household's total.
 *
 * Bands are the engine's own facts — per-source flows (`ProjectionMonthFlows.incomeSources`) and
 * per-obligation costs (`ProjectionMonthFlows.obligations`), each already labelled and
 * categorized. This chart is never a statement of taxable income, and the two genuinely differ:
 * a home down payment's realized gain is taxed and appears in neither.
 */

import type { IncomeSourceCategory, ProjectionSeries } from "@finley/engine";
import { apportionDisplayCents, toDisplayCents } from "./displayShares";
import { yearOf } from "../../format";

/**
 * The tax refund's band. Not an engine income source: the refund is a settlement, and the engine
 * reports it as one. Its own category, because it is neither wages, a benefit nor a draw — and
 * because a refund is the one inflow that arrives from the outflow side of the chart.
 */
export const TAX_REFUND_BAND_ID = "tax-refund";
export const TAX_REFUND_CATEGORY = "taxRefund";
export const TAX_REFUND_LABEL = "Tax refund";

/**
 * One refund band per FILER. The household files as separate single filers, so an April in which
 * one partner is refunded and the other owes is two facts, not one net figure — and the refunded
 * partner is the only person whose cut of the chart may show the money arriving.
 */
export function refundBandId(personId: string): string {
  return `${TAX_REFUND_BAND_ID}:${personId}`;
}

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

/**
 * One person's share of what the household spends together, drawn ONLY in that person's cut.
 *
 * A shared budget line has no per-person amount and never will — the household spends $2,400 on
 * rent, not $1,400 of Alex's rent — so a person's stack cannot carry the line itself. What it
 * carries is the engine's own figure for what that person was CHARGED
 * (`obligationChargedByPersonCents` less their own obligations), which is how the household
 * FUNDS its spending under the authored split, stated once rather than split across lines it cannot
 * honestly be split across. Absent from the combined stack, where the real lines are drawn.
 */
export const SHARED_SPENDING_BAND_ID = "spend:shared";
export const SHARED_SPENDING_CATEGORY = "sharedSpending";
const SHARED_SPENDING_BAND: CashFlowBand = {
  id: SHARED_SPENDING_BAND_ID,
  label: "Share of shared spending",
  category: SHARED_SPENDING_CATEGORY,
};

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
  /**
   * The same month's outflows CHARGED to one person, keyed person → band → cents, and the only
   * honest way to cut the outflow side: a band id here means the engine reported that person's
   * own figure for it, never a share derived from the household's.
   *
   * Three of the four kinds are the engine's own per-person facts — each person's withholding
   * and FICA (their income sources' attribution), and their April balance from
   * `taxSettlementByPersonCents`. The fourth is their obligations: the ones charged to them
   * alone at full amount, then {@link SHARED_SPENDING_BAND_ID} for their share of the rest.
   *
   * Σ over people is the household's figure for the tax bands and for a person-owned
   * obligation; the shared band replaces the shared LINES rather than summing with them, so the
   * two sides of the toggle state the same spending differently on purpose. Empty for a
   * projection run before the engine reported any of it.
   */
  readonly outflowCentsByBandByPerson: Readonly<Record<string, Readonly<Record<string, number>>>>;
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
   * The split is how the household FUNDS its spending — each person's authored share of the shared
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
  /**
   * {@link spendingNeedCents} per person — their own obligations plus their share of the shared
   * ones, as the household's authored percentages split them. What makes a person's cut ask "is MY
   * income covering MY share" instead of holding one earner's pay against everything the
   * household spends. Empty for a projection run before the engine reported it.
   */
  readonly spendingNeedCentsByPerson: Readonly<Record<string, number>>;
}

export interface CashFlowChartData {
  readonly rows: readonly CashFlowMonthRow[];
  /** Only the bands that carry money somewhere, in display order. */
  readonly inflowBands: readonly CashFlowBand[];
  readonly outflowBands: readonly CashFlowBand[];
  /** First month with no inflow at all AND no savings drawdown, which a solvent plan never hits. */
  readonly firstMonthWithNoIncome: number | null;
  /**
   * First month the HOUSEHOLD lived off savings: its net cash flow was negative AND somebody drew
   * on an account to close the gap. Both halves are load-bearing.
   *
   * A withdrawal alone says nothing about the household. Two earners splitting the bills 50/50
   * can leave one of them short of their own share every month while the household earns $10,400
   * against $5,400 of spending — one partner sells a fund, the other banks a surplus, and a
   * chart reading the withdrawal alone announced that the household was living off its savings
   * from Year 1. That is a fact about Blake, and it belongs to Blake's view; see
   * {@link firstDrawdownMonthByPerson}.
   *
   * A negative net alone says something, but not this: a month whose gap nothing covered is an
   * unfunded shortfall, not a drawdown, and {@link firstMonthWithNoIncome} and
   * {@link firstInsolventMonth} are what name it.
   */
  readonly firstHouseholdDrawdownMonth: number | null;
  /**
   * Per person, the first month THEIR own income fell short of what they were charged and they
   * drew on their own accounts for the difference — the genuine version of the warning above, at
   * the scope where it is true. Absent for anyone who never had to.
   */
  readonly firstDrawdownMonthByPerson: Readonly<Record<string, number>>;
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
  SHARED_SPENDING_CATEGORY,
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
/**
 * The three tax outflows a month really pays. The April figures are GROSS across the household's
 * members, who file as separate single filers: one partner owing $1,000 while the other is
 * refunded $300 pays $1,000 of tax and receives $300 back, and clamping the −$700 net would draw
 * $0 leaving and $700 arriving — two figures neither person ever saw. The refund is an inflow of
 * its own ({@link refundInflowOf}), never a discount on the bill.
 */
function taxOutflowsOf(flows: {
  readonly taxCents?: number;
  readonly payrollTaxCents?: number;
  readonly taxSettlementCents?: number;
  readonly taxSettlementByPersonCents?: Readonly<Record<string, number>>;
}): { readonly incomeTaxCents: number; readonly payrollTaxCents: number; readonly settlementCents: number } {
  const settlement = flows.taxSettlementCents ?? 0;
  return {
    incomeTaxCents: Math.max(0, (flows.taxCents ?? 0) - settlement),
    payrollTaxCents: Math.max(0, flows.payrollTaxCents ?? 0),
    settlementCents: grossSettlementOf(flows, (c) => c > 0, settlement),
  };
}

/** Money the filing hands BACK, gross across members — see {@link taxOutflowsOf}. */
function refundInflowOf(flows: {
  readonly taxSettlementCents?: number;
  readonly taxSettlementByPersonCents?: Readonly<Record<string, number>>;
}): number {
  return grossSettlementOf(flows, (c) => c < 0, -(flows.taxSettlementCents ?? 0));
}

/**
 * Σ of the members' balances pointing one way. Falls back to clamping the household net when no
 * per-person report is present — identical for a household of one, and for any month whose
 * members all owe or are all refunded.
 */
function grossSettlementOf(
  flows: { readonly taxSettlementByPersonCents?: Readonly<Record<string, number>> },
  keep: (cents: number) => boolean,
  fallbackNetCents: number,
): number {
  const byPerson = Object.values(flows.taxSettlementByPersonCents ?? {});
  if (byPerson.length === 0) return Math.max(0, fallbackNetCents);
  return byPerson.filter(keep).reduce((sum, c) => sum + Math.abs(c), 0);
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
  /** Income source -> its owner, learned as the months go by; see the settlement note below. */
  const ownerBySource = new Map<string, string>();
  let firstMonthWithNoIncome: number | null = null;
  let firstHouseholdDrawdownMonth: number | null = null;
  const firstDrawdownMonthByPerson: Record<string, number> = {};
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
    /** The same, split by whose account it came out of — a drawdown belongs to its owner. */
    const drewByPerson: Record<string, number> = {};
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
        if (s.cashInflowCents > 0 && s.ownerId !== undefined) {
          drewByPerson[s.ownerId] = (drewByPerson[s.ownerId] ?? 0) + s.cashInflowCents;
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
    // Money back from last April, arriving whole and arriving to SOMEBODY. Nothing is taken off
    // any other band to make room for it: the inflow side is gross, so no source was ever netted
    // against it — and a refund banded to the household rather than to the filer vanished from
    // every person's cut, which is the one place a reader goes to ask who got it.
    const settlementByPerson = flows.taxSettlementByPersonCents ?? {};
    if (Object.keys(settlementByPerson).length === 0) {
      // No per-person report (a projection predating one, or a month that settled nothing):
      // the household's clamped net is the whole of the old behaviour.
      addInflow(
        { id: TAX_REFUND_BAND_ID, label: TAX_REFUND_LABEL, category: TAX_REFUND_CATEGORY },
        refundInflowOf(flows),
      );
    } else {
      for (const [personId, cents] of Object.entries(settlementByPerson)) {
        if (cents >= 0) continue; // their filing took money rather than gave it back
        addInflow(
          {
            id: refundBandId(personId),
            label: TAX_REFUND_LABEL,
            category: TAX_REFUND_CATEGORY,
            ownerId: personId,
          },
          -cents,
        );
      }
    }

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

    // --- the same outflows, charged to the person who bore them ---
    const outflowCentsByBandByPerson: Record<string, Record<string, number>> = {};
    const charge = (personId: string, bandId: string, cents: number): void => {
      if (cents <= 0) return;
      const forPerson = (outflowCentsByBandByPerson[personId] ??= {});
      forPerson[bandId] = (forPerson[bandId] ?? 0) + cents;
    };
    // A source's owner is remembered across months because a SETTLED source need not still be
    // paying: last year's job settles this April having stopped in June, and it appears in the
    // attribution with no income source beside it to name its owner.
    for (const s of flows.incomeSources ?? []) {
      if (s.ownerId !== undefined) ownerBySource.set(s.sourceId, s.ownerId);
    }
    const settlementBySource = flows.taxSettlementBySourceCents ?? {};
    for (const [sourceId, cents] of Object.entries(flows.taxBySourceCents ?? {})) {
      // The settlement comes out because it is charged per PERSON below; what is left is the
      // withholding this month's pay really took, which is never negative.
      const owner = ownerBySource.get(sourceId);
      if (owner !== undefined) charge(owner, TAX_INCOME_BAND_ID, cents - (settlementBySource[sourceId] ?? 0));
    }
    for (const [sourceId, cents] of Object.entries(flows.payrollTaxBySourceCents ?? {})) {
      const owner = ownerBySource.get(sourceId);
      if (owner !== undefined) charge(owner, TAX_PAYROLL_BAND_ID, cents);
    }
    // Signed, and only the bills land here: a refund is money arriving and bands on the inflow
    // side, so a person refunded pays no settlement rather than a negative one.
    for (const [personId, cents] of Object.entries(settlementByPerson)) {
      charge(personId, TAX_SETTLEMENT_BAND_ID, cents);
    }
    // Their own obligations in full, then their share of everything else -- the same two terms
    // the waterfall added to get `obligationChargedByPersonCents`, so the difference is exactly
    // the share and never has to be derived from the household's total.
    const ownObligationCents: Record<string, number> = {};
    for (const o of flows.obligations ?? []) {
      // Explicitly-funded obligations draw named accounts rather than anyone's income, so the
      // waterfall charges them to nobody and neither does this.
      if (o.ownerId === undefined || o.funding.kind !== "automatic") continue;
      charge(o.ownerId, o.id, o.amountCents);
      ownObligationCents[o.ownerId] = (ownObligationCents[o.ownerId] ?? 0) + o.amountCents;
    }
    for (const [personId, cents] of Object.entries(flows.obligationChargedByPersonCents ?? {})) {
      charge(personId, SHARED_SPENDING_BAND_ID, cents - (ownObligationCents[personId] ?? 0));
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

    // Resolved here rather than in the source loop above, because whether a withdrawal was the
    // household living off savings or one partner covering their own share is a question about
    // the month's NET, which is not known until both sides are totalled.
    const netCents = inflowTotalCents - outflowTotalCents;
    if (netCents < 0 && drewOnSavingsCents > 0 && firstHouseholdDrawdownMonth === null) {
      firstHouseholdDrawdownMonth = m.month;
    }
    for (const [pid, cents] of Object.entries(drewByPerson)) {
      if (cents > 0 && (netCentsByPerson[pid] ?? 0) < 0 && firstDrawdownMonthByPerson[pid] === undefined) {
        firstDrawdownMonthByPerson[pid] = m.month;
      }
    }

    rows.push({
      month: m.month,
      inflowCentsByBand,
      outflowCentsByBand,
      outflowCentsByBandByPerson,
      inflowTotalCents,
      outflowTotalCents,
      netCents,
      netCentsByPerson,
      spendingNeedCents: (flows.expensesCents ?? 0) + (flows.liabilityPaymentsCents ?? 0),
      spendingNeedCentsByPerson: flows.obligationChargedByPersonCents ?? {},
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
          // The per-person maps key off the same band ids, plus the shared-spending band, which
          // is a person's alone and never appears in the household stack to be drawn from it.
          outflowCentsByBandByPerson: Object.fromEntries(
            Object.entries(row.outflowCentsByBandByPerson).map(([personId, byBand]) => [
              personId,
              Object.fromEntries(
                Object.entries(byBand).filter(
                  ([id]) => drawn.has(id) || id === SHARED_SPENDING_BAND_ID,
                ),
              ),
            ]),
          ),
        }));

  return {
    rows: trimmed,
    inflowBands,
    outflowBands,
    firstMonthWithNoIncome,
    firstHouseholdDrawdownMonth,
    firstDrawdownMonthByPerson,
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
  // Already a collapse, and of the one thing Simple cannot collapse further: a person's share of
  // the shared lines is a single figure precisely because those lines have no per-person split.
  if (band.id === SHARED_SPENDING_BAND_ID) return band;
  return {
    id: `spend:${band.category}`,
    label: OUTFLOW_CATEGORY_LABELS[band.category] ?? "Other spending",
    category: band.category,
  };
}

/**
 * Bands labelled by the KIND of money rather than by the person it reaches: a government benefit,
 * and a tax refund. Two of either on one chart are one legend entry repeated, and the reader
 * cannot tell whose is whose.
 */
const EARNER_NAMED_CATEGORIES: readonly string[] = [
  "governmentRetirementBenefit",
  TAX_REFUND_CATEGORY,
];

/**
 * Only when two or more bands of the same kind are on the chart, so a single-earner plan gains
 * no redundant "· Alex". Wage bands already carry the job's own name.
 */
function withEarnerNames(
  bands: readonly CashFlowBand[],
  personNames: ReadonlyMap<string, string>,
): readonly CashFlowBand[] {
  const named = (b: CashFlowBand) => EARNER_NAMED_CATEGORIES.includes(b.category);
  const owners = new Map<string, Set<string>>();
  for (const b of bands) {
    if (!named(b) || b.ownerId === undefined) continue;
    (owners.get(b.category) ?? owners.set(b.category, new Set()).get(b.category)!).add(b.ownerId);
  }
  if ([...owners.values()].every((o) => o.size < 2)) return bands;
  return bands.map((b) => {
    if (!named(b) || b.ownerId === undefined) return b;
    if ((owners.get(b.category)?.size ?? 0) < 2) return b;
    const name = personNames.get(b.ownerId);
    return name === undefined ? b : { ...b, label: `${b.label} · ${name}` };
  });
}

/**
 * The spending a cut has to cover: the household's whole need, or one person's share of it.
 * A person the engine reported no share for covers nothing — never the household's figure,
 * which would hold one earner's pay against everything the household spends.
 *
 * A person's share is apportioned for DISPLAY ({@link apportionDisplayCents}) rather than handed
 * over raw, so the whole-dollar figures the reader compares between Combined and each person add
 * up. The engine's cents are untouched and nothing here feeds back into one.
 */
function spendingNeedFor(
  row: CashFlowMonthRow,
  ownerId: string | undefined,
  owners: readonly string[],
): number {
  if (ownerId === undefined) return row.spendingNeedCents;
  return shareOf(row.spendingNeedCents, row.spendingNeedCentsByPerson, ownerId, owners);
}

/** One person's display share of a household figure the engine already split to the cent. */
function shareOf(
  totalCents: number,
  byPerson: Readonly<Record<string, number>>,
  ownerId: string,
  owners: readonly string[],
): number {
  const index = owners.indexOf(ownerId);
  if (index < 0) return toDisplayCents(byPerson[ownerId] ?? 0);
  return apportionDisplayCents(
    totalCents,
    owners.map((pid) => byPerson[pid] ?? 0),
  )[index]!;
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
 * `ownerId` cuts the chart down to one person, on all three views. Cash arriving is attributed
 * to whoever receives it; cash leaving is read from {@link
 * CashFlowMonthRow.outflowCentsByBandByPerson}, which the engine states per person rather than
 * this file deriving it. The two sides are cut differently for that reason: an inflow band
 * BELONGS to one person, so the cut is a filter over bands, while an outflow band is a household
 * line whose per-person amount is a separate figure — the same band id, a different number.
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
        const net =
          ownerId === undefined
            ? r.netCents
            : shareOf(r.netCents, r.netCentsByPerson, ownerId, data.netOwners);
        return {
          month: r.month,
          centsByBand: {},
          totalCents: net,
          netCents: net,
          spendingNeedCents: spendingNeedFor(r, ownerId, data.netOwners),
        };
      }),
    };
  }

  const inflows = view === "inflows";
  const all = inflows ? data.inflowBands : data.outflowBands;
  const outflowsForPerson = !inflows && ownerId !== undefined;
  const order = inflows ? INFLOW_CATEGORY_ORDER : OUTFLOW_CATEGORY_ORDER;
  const centsOf = (r: CashFlowMonthRow) =>
    inflows
      ? r.inflowCentsByBand
      : outflowsForPerson
        ? (r.outflowCentsByBandByPerson[ownerId!] ?? {})
        : r.outflowCentsByBand;

  // Cut before collapsing: Simple folds two people's benefits onto one band, so filtering
  // afterwards would have nothing left to filter by. An outflow cut keeps the household's bands
  // that this person was charged something under, plus their share of the shared lines — which
  // is not one of the household's bands, since the household draws those lines themselves.
  const chargedBandIds = outflowsForPerson
    ? new Set(data.rows.flatMap((r) => Object.keys(centsOf(r))))
    : null;
  const sourceBands =
    inflows && ownerId !== undefined
      ? all.filter((b) => b.ownerId === ownerId)
      : chargedBandIds === null
        ? all
        : [...all, SHARED_SPENDING_BAND].filter((b) => chargedBandIds.has(b.id));

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
      netCents:
        ownerId === undefined
          ? r.netCents
          : shareOf(r.netCents, r.netCentsByPerson, ownerId, data.netOwners),
      spendingNeedCents: spendingNeedFor(r, ownerId, data.netOwners),
    };
  });
  // A band nobody can see is not a band. The lists above drop what carried nothing ANYWHERE, at
  // the cent — which still leaves a refund of four cents spread over a lifetime with a legend
  // entry, a flat-zero area, and a "Tax refund $0" row in every reading of the table. The test is
  // the rounding {@link formatDollars} does, the same one the milestone walk compares on, so a
  // band survives exactly when some month of it prints a figure.
  //
  // The cents stay in `centsByBand` and in `totalCents`: the money was real, it is only too small
  // to draw, and dropping it from the totals would make the rows stop adding up to the month.
  const visible = bands.filter((b) =>
    rows.some((r) => toDisplayCents(r.centsByBand[b.id] ?? 0) !== 0),
  );
  return { bands: visible, rows };
}

/**
 * A one-line summary for the a11y label and the visible hint, SCOPED to the view it sits under —
 * or `null` when that view has no gap to describe.
 *
 * The combined view speaks for the household and only about the household: it says "living off
 * savings" when the household's own cash flow went negative and savings closed the gap, and says
 * nothing merely because one partner sold a fund. A person's view speaks for that person, and the
 * sentence it gets is a different claim in different words — their income did not stretch to
 * their share, which is true of them and not of the household around them.
 */
export function describeCashFlowGap(
  data: CashFlowChartData,
  ownerId?: string,
  personName?: string,
): string | null {
  if (ownerId !== undefined) {
    const month = data.firstDrawdownMonthByPerson[ownerId];
    if (month === undefined) return null;
    const who = personName?.trim() || "This person";
    return (
      `From Year ${yearOf(month)} ${who} covers their share from personal savings — ` +
      `their own income doesn't stretch to it. That is theirs alone, not the household's total.`
    );
  }
  if (data.firstHouseholdDrawdownMonth !== null) {
    return (
      `From Year ${yearOf(data.firstHouseholdDrawdownMonth)} you're living off savings — ` +
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

/**
 * The household's headline is a household claim, so it cannot also carry "and Blake, personally,
 * is covering their share out of savings" — a fact about one member that the combined total does
 * not show and can even contradict, since the household can be comfortably positive while one
 * person inside it is not.
 *
 * Said BESIDE the headline rather than instead of it, and only in the combined view: a person's
 * own cut already leads with their claim, and repeating it under itself says nothing twice.
 * `null` when nobody is drawing down, which is the ordinary case.
 */
export function describePersonalDrawdowns(
  data: CashFlowChartData,
  personNames: ReadonlyMap<string, string>,
): string | null {
  const drawing = Object.entries(data.firstDrawdownMonthByPerson)
    .filter(([id]) => personNames.get(id) !== undefined)
    .sort((a, b) => a[1] - b[1]);
  if (drawing.length === 0) return null;
  const clauses = drawing.map(
    ([id, month]) => `${personNames.get(id) ?? id} from Year ${yearOf(month)}`,
  );
  const who =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
  return (
    `Within it, ${who} ${drawing.length === 1 ? "covers their" : "cover their"} own share from ` +
    `personal savings — that is theirs alone, not the household's total.`
  );
}
