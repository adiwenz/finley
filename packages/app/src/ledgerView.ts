/**
 * Ledger presentation for the life-event timeline. Pure functions over the engine's event
 * ledger — no React, no I/O — so they unit-test in isolation. This only turns ledger data
 * into plain language; the household cross-section ("what is active at month M") is the
 * engine's job, see `snapshotAt` in @finley/engine.
 */

import type { Ledger, LifeEvent, ProjectionSeries, SnapshotSeries } from "@finley/engine";
import { formatDollars } from "./format";

export interface EventSummary {
  /** Friendly label. Exactly one per structural change. */
  readonly label: string;
  /** Short specifics for the marker tooltip / list row. */
  readonly detail: string;
}

/** A fractional rate (0.065) as a percent with trailing zeros trimmed ("6.5%"). */
function formatApr(apr: number): string {
  return `${Number((apr * 100).toFixed(2))}%`;
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
    case "HomePurchaseEvent": {
      // One row for the whole purchase now that the mortgage is embedded, not a second "Took out a
      // loan" marker. Lead with price, then the down payment when there is one (a holding draws
      // none), then the financing — or "no mortgage" for a cash buy / a home owned outright.
      const bits = [formatDollars(e.purchasePriceCents)];
      if (e.downPaymentCents > 0) bits.push(`${formatDollars(e.downPaymentCents)} down`);
      bits.push(
        e.mortgage !== undefined
          ? `${formatDollars(e.mortgage.openingBalanceCents)} mortgage at ${formatApr(e.mortgage.apr)}, ${Math.round(e.mortgage.termMonths / 12)} yr`
          : "no mortgage",
      );
      return { label: "Bought a home", detail: bits.join(", ") };
    }
    case "LoanEvent":
      return {
        label: "Took out a loan",
        detail: `${KIND_NOUN[e.kind] ?? e.kind}, ${formatDollars(e.openingBalanceCents)}`,
      };
    case "DebtPayoffEvent":
      return { label: "Paid down debt", detail: formatDollars(e.amountCents) };
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
      return s.seriesType === "income" ? "Income" : "Expense";
  }
}

/**
 * How the projection treated the obligation an event spawned:
 *   - `executed` — its month ran, or it never spawned an obligation (a structural event, a
 *     pre-existing holding) so the stop never concerned it. The timeline shows no indicator.
 *   - `blocked` — this event's down payment could not be funded and stopped the projection.
 *   - `not-reached` — authored after the blocked month, so the simulation stopped before testing it.
 */
export type MarkerOutcome = "executed" | "blocked" | "not-reached";

export interface TimelineMarker extends EventSummary {
  readonly id: string;
  readonly month: number;
  readonly type: LifeEvent["type"];
  readonly outcome: MarkerOutcome;
}

/** The projection fields the timeline reads to classify each event — nothing else of the series. */
type OutcomeSource = Pick<
  ProjectionSeries,
  "status" | "blockingObligation" | "obligationOutcomes"
>;

/**
 * Every authoring event the projection did not simply execute, keyed by its own id — the blocking
 * purchase and every purchase authored after it. Read straight from the engine's `obligationOutcomes`
 * and never re-derived positionally: only obligation-bearing purchases appear there, so structural
 * events (a marriage, a child, a separation) and pre-existing holdings are absent and fall through to
 * `executed` with no indicator, exactly as the slice requires.
 *
 * The outcome map is keyed by obligation id (`<prefix><authoring-event-id>`, `draw:downpayment:home-1`
 * today). Rather than hard-code that spelling, recover `<prefix>` from the one (obligationId,
 * sourceEventId) pair the engine hands us on `blockingObligation` and strip it back off each key — so
 * the join stays on the authoring event and survives a change to the id scheme. Empty for a run that
 * reached the horizon: nothing stopped, so every event executed.
 */
function eventOutcomes(series: OutcomeSource | undefined): Map<string, MarkerOutcome> {
  const outcomes = new Map<string, MarkerOutcome>();
  if (series === undefined || series.status !== "blocked") return outcomes;
  const blocking = series.blockingObligation;
  if (blocking?.sourceEventId === undefined) return outcomes;
  const { obligationId, sourceEventId } = blocking;
  // The obligation id ends with its authoring event id by construction. If that ever fails we can
  // still name the blocking event; we just cannot translate the rest of the map.
  if (!obligationId.endsWith(sourceEventId)) {
    outcomes.set(sourceEventId, "blocked");
    return outcomes;
  }
  const prefix = obligationId.slice(0, obligationId.length - sourceEventId.length);
  for (const [id, outcome] of Object.entries(series.obligationOutcomes)) {
    if (outcome.status === "executed" || !id.startsWith(prefix)) continue;
    outcomes.set(id.slice(prefix.length), outcome.status);
  }
  return outcomes;
}

/**
 * The ledger as plain-language markers, sorted by (month, sequenceNumber). Pass the projection
 * `series` to fold in per-event outcomes — the blocking purchase and every purchase stranded after
 * it; omit it (the snapshot panel's use) and every marker reads `executed`.
 */
export function timelineMarkers(ledger: Ledger, series?: OutcomeSource): TimelineMarker[] {
  const outcomes = eventOutcomes(series);
  return [...ledger.events]
    .sort((a, b) => a.month - b.month || a.sequenceNumber - b.sequenceNumber)
    .map((e) => ({
      id: e.id,
      month: e.month,
      type: e.type,
      outcome: outcomes.get(e.id) ?? "executed",
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
