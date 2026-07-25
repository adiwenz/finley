/**
 * Ledger presentation for the life-event timeline (issue #5, Slice 3b). Pure
 * functions over the engine's event ledger — no React, no I/O — so they are
 * unit-testable in isolation.
 *
 * The household cross-section itself ("what is active at month M") is the
 * engine's job — see `snapshotAt` in @finley/engine. This module only turns
 * ledger data into plain language:
 *  - {@link timelineMarkers}: the ledger as plain-language markers on the
 *    shared time axis (§10.2). Each event maps to exactly one label (§10.3
 *    rule 3).
 *  - {@link seriesLabel}: the engine's machine-readable series role → the
 *    label shown in the snapshot panel.
 *  - {@link splitMarkers}: markers partitioned into passed/upcoming relative
 *    to the scrubbed month (§10.8 peripheral hints).
 */

import type {
  HouseholdLiability,
  HouseholdSeries,
  Ledger,
  LifeEvent,
  SnapshotSeries,
} from "@finley/engine";
import { SYNTHETIC_CARD_ID } from "@finley/engine";
import { formatDollars } from "./format";

// ─── Plain-language event summaries (§10.3 rule 3: one label = one change) ─────

export interface EventSummary {
  /** Friendly label. Exactly one per structural change. */
  readonly label: string;
  /** Short specifics for the marker tooltip / list row. */
  readonly detail: string;
}

const KIND_NOUN: Record<string, string> = {
  mortgage: "mortgage",
  auto: "auto loan",
  studentLoan: "student loan",
  creditCard: "credit card",
};

/**
 * Plain-language name per liability id — what a debt is called wherever it is *shown*
 * spending money (the budget graph's debt bands). A liability's own id is a machine key
 * ("loan-student"), and the kind is the only human fact the model carries, so the label
 * is built from the kind: "Student loan payment". Two debts of the same kind are
 * numbered in ledger order rather than made indistinguishable.
 *
 * The engine's synthetic shortfall card (§5.1) is never in the household's authored
 * liabilities — it is minted by the simulator when spending outruns everything — so it
 * gets its own entry here: the household is genuinely paying it, and a chart that hid it
 * would understate what the month costs.
 */
export function liabilityLabels(
  liabilities: readonly HouseholdLiability[],
): Record<string, string> {
  const countByKind: Record<string, number> = {};
  const totalByKind: Record<string, number> = {};
  for (const l of liabilities) totalByKind[l.kind] = (totalByKind[l.kind] ?? 0) + 1;

  const labels: Record<string, string> = { [SYNTHETIC_CARD_ID]: "Credit card payment" };
  for (const l of liabilities) {
    const noun = KIND_NOUN[l.kind] ?? l.kind;
    const n = (countByKind[l.kind] = (countByKind[l.kind] ?? 0) + 1);
    const suffix = (totalByKind[l.kind] ?? 0) > 1 ? ` ${n}` : "";
    // "student loan" → "Student loan payment 2"
    labels[l.id] = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} payment${suffix}`;
  }
  return labels;
}

export function summarizeEvent(e: LifeEvent): EventSummary {
  switch (e.type) {
    case "RelationshipEvent":
      return { label: "Partnered", detail: `${e.person.name} joins the household` };
    case "ChildEvent":
      return {
        label: "Had a child",
        detail:
          e.annualCostCents > 0
            ? `${e.childName}, ${formatDollars(e.annualCostCents)}/yr`
            : e.childName,
      };
    case "SeparationEvent": {
      const bits: string[] = [];
      if (e.alimonyMonthlyCents > 0)
        bits.push(`alimony ${formatDollars(e.alimonyMonthlyCents)}/mo`);
      if (e.childSupportMonthlyCents > 0)
        bits.push(`child support ${formatDollars(e.childSupportMonthlyCents)}/mo`);
      return { label: "Separated", detail: bits.join(", ") || "no support" };
    }
    case "HomePurchaseEvent":
      return {
        label: "Bought a home",
        detail: `${formatDollars(e.purchasePriceCents)}, ${formatDollars(e.downPaymentCents)} down`,
      };
    case "LoanEvent":
      return {
        label: "Took out a loan",
        detail: `${KIND_NOUN[e.kind] ?? e.kind}, ${formatDollars(e.openingBalanceCents)}`,
      };
    case "DebtPayoffEvent":
      return { label: "Paid down debt", detail: formatDollars(e.amountCents) };
    case "BudgetItemStartEvent":
      return {
        label: e.seriesType === "income" ? "Added income" : "Added an expense",
        detail: `${formatDollars(e.monthlyCents)}/mo`,
      };
    case "BudgetItemEndEvent":
      return { label: "Ended an item", detail: e.seriesId };
  }
}

// ─── Series labels (engine role → snapshot-panel text) ────────────────────────

export function seriesLabel(s: Pick<SnapshotSeries, "role" | "seriesType">): string {
  switch (s.role) {
    case "primaryIncome":
      return "Job income";
    case "alimony":
      return "Alimony";
    case "childSupport":
      return "Child support";
    case "childCost":
      return "Child cost";
    case "base":
    case "budgetItem":
      return s.seriesType === "income" ? "Income" : "Expense";
  }
}

/**
 * One non-budget-line spending stream as a chart band: what to call it, and what it
 * costs at a given month. A function rather than a precomputed array because the chart
 * asks month by month over whatever horizon it draws.
 */
export interface SpendingBand {
  readonly id: string;
  readonly label: string;
  readonly monthlyCentsAt: (month: number) => number;
}

/**
 * Spending that is real but is not a budget line: health care (a standing plan input,
 * §5.4) and anything the timeline added (a child's cost, alimony, an expense event).
 * Each is a compiled series, so its amount at a month is asked of the very object the
 * simulator charged — no re-derivation of growth or spans in the UI.
 *
 * Budget-line series are excluded: the graph already draws those from the engine's
 * per-line report, and drawing them twice would double the household's spending.
 */
export function nonLineSpending(series: readonly HouseholdSeries[]): SpendingBand[] {
  return series
    .filter((s) => s.seriesType === "expense" && s.lineId === undefined)
    .map((s) => ({
      id: s.id,
      label: s.label ?? seriesLabel(s),
      monthlyCentsAt: (month: number) => s.series.getMonthlyCents(month),
    }));
}

// ─── Timeline markers ─────────────────────────────────────────────────────────

export interface TimelineMarker extends EventSummary {
  readonly id: string;
  readonly month: number;
  readonly type: LifeEvent["type"];
}

/** The ledger as plain-language markers, sorted by (month, sequenceNumber). */
export function timelineMarkers(ledger: Ledger): TimelineMarker[] {
  return [...ledger.events]
    .sort((a, b) => a.month - b.month || a.sequenceNumber - b.sequenceNumber)
    .map((e) => ({
      id: e.id,
      month: e.month,
      type: e.type,
      ...summarizeEvent(e),
    }));
}

/**
 * Markers partitioned around the scrubbed month, end-of-month convention:
 * an event at month M has already happened when viewing month M (§10.8).
 */
export function splitMarkers(
  ledger: Ledger,
  month: number,
): { passed: TimelineMarker[]; upcoming: TimelineMarker[] } {
  const markers = timelineMarkers(ledger);
  return {
    passed: markers.filter((m) => m.month <= month),
    upcoming: markers.filter((m) => m.month > month),
  };
}
