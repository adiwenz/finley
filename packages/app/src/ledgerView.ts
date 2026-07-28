/**
 * Ledger presentation for the life-event timeline. Pure functions over the engine's event
 * ledger — no React, no I/O — so they unit-test in isolation. The household cross-section
 * ("what is active at month M") is the engine's job; see `snapshotAt` in @finley/engine.
 * This only turns ledger data into plain language:
 *  - {@link timelineMarkers}: markers on the shared time axis, one label per event;
 *  - {@link seriesLabel}: the engine's machine-readable series role → snapshot-panel text;
 *  - {@link splitMarkers}: markers partitioned passed/upcoming around the scrubbed month.
 */

import type { Ledger, LifeEvent, SnapshotSeries } from "@finley/engine";
import { formatDollars } from "./format";

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
 * Markers partitioned around the scrubbed month. End-of-month convention: an event at
 * month M has already happened when viewing month M.
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
