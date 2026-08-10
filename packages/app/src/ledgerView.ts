/**
 * Ledger presentation for the life-event timeline. Pure functions over the engine's event
 * ledger — no React, no I/O — so they unit-test in isolation. This only turns ledger data
 * into plain language; the household cross-section ("what is active at month M") is the
 * engine's job, see `snapshotAt` in @finley/engine.
 */

import type { Cents, FundingLookup, Ledger, LifeEvent, ProjectionSeries, SnapshotSeries } from "@finley/engine";
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
    case "OneTimeSpendEvent":
      return {
        label: e.label,
        detail: `${formatDollars(e.amountCents)}, ${e.fundingSourceIds.length} funding source${e.fundingSourceIds.length === 1 ? "" : "s"}`,
      };
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
type OutcomeSource = Pick<ProjectionSeries, "status" | "obligationOutcomes">;

/**
 * Every authoring event the projection did not simply execute, keyed by its own id — the blocking
 * purchase and every purchase authored after it. Read straight off each {@link ObligationOutcome}'s
 * `sourceEventId`, which the engine mirrors from the obligation it classified — the app never parses
 * `obligationId`'s spelling to recover the event that spawned it. Only obligation-bearing purchases
 * carry a `sourceEventId` at all, so structural events (a marriage, a child, a separation) and
 * pre-existing holdings are absent and fall through to `executed` with no indicator, exactly as the
 * slice requires. Empty for a run that reached the horizon: nothing stopped, so every event executed.
 */
function eventOutcomes(series: OutcomeSource | undefined): Map<string, MarkerOutcome> {
  const outcomes = new Map<string, MarkerOutcome>();
  if (series === undefined || series.status !== "blocked") return outcomes;
  for (const outcome of Object.values(series.obligationOutcomes)) {
    if (outcome.status === "executed" || outcome.sourceEventId === undefined) continue;
    outcomes.set(outcome.sourceEventId, outcome.status);
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

/** One eligible account the household could re-point funding to, with its net-of-tax available. */
export interface AlternativeSourceView {
  /** The account's human label, resolved from the funding pool — falls back to its id. */
  readonly label: string;
  readonly availableCents: Cents;
}

/**
 * The soft-warning's content. Everything shared sits on the base; the failure `kind` decides which
 * remedy the copy states — re-point the funding (money exists elsewhere) versus no eligible
 * account can cover it (which is NOT insolvency).
 */
export type BlockedWarningView = {
  /** The blocking event in the household's own words ("Bought a home"), not the obligation's id. */
  readonly eventLabel: string;
  /** The month it was scheduled for — {@link ProjectionSeries.blockedAtMonth}. */
  readonly month: number;
  /** The funding gap, net of the capital-gains tax liquidating the named sources owes. */
  readonly shortfallCents: Cents;
} & (
  | {
      readonly kind: "funding-configuration";
      /** Eligible accounts the user did not select that could cover the obligation. Advisory. */
      readonly alternativeSources: readonly AlternativeSourceView[];
    }
  | { readonly kind: "no-eligible-source-suffices" }
);

/** The projection fields the warning reads — just the block, never a balance or a later month. */
type WarningSource = Pick<ProjectionSeries, "status" | "blockingObligation">;

/**
 * The soft warning shown while a projection is blocked, or `null` when nothing stopped. Named from
 * the AUTHORING event via `sourceEventId`, not the blocking obligation's own `label` — that is an
 * engine-internal band namespace ("downpayment"), whereas the household authored "Bought a home".
 * Same event→outcome join the timeline's indicators use; here it recovers one plain-language name.
 *
 * The month, shortfall, and the funding failure come straight off `blockingObligation` — every
 * figure is the engine's bare, already-post-tax number, never recomputed here. The eligibility
 * verdict and the alternatives are the engine's too; the view's only added work is resolving each
 * alternative's `accountId` to a human label through `funding.sourcesAt` (the same liquid pool the
 * picker shows), falling back to the id when no `funding` handle is supplied (e.g. the snapshot
 * panel, which never renders a funding-configuration alternative).
 */
export function blockedWarning(
  ledger: Ledger,
  series: WarningSource | undefined,
  funding?: Pick<FundingLookup, "sourcesAt">,
): BlockedWarningView | null {
  if (series === undefined || series.status !== "blocked") return null;
  const blocking = series.blockingObligation;
  if (blocking === undefined) return null;
  const event =
    blocking.sourceEventId === undefined
      ? undefined
      : ledger.events.find((e) => e.id === blocking.sourceEventId);
  const base = {
    eventLabel: event !== undefined ? summarizeEvent(event).label : blocking.label,
    month: blocking.month,
    shortfallCents: blocking.shortfallCents,
  };
  const failure = blocking.fundingFailure;
  if (failure.kind === "no-eligible-source-suffices") {
    return { ...base, kind: "no-eligible-source-suffices" };
  }
  const labelById = new Map((funding?.sourcesAt(blocking.month) ?? []).map((s) => [s.id, s.label]));
  return {
    ...base,
    kind: "funding-configuration",
    alternativeSources: failure.alternativeSources.map((a) => ({
      label: labelById.get(a.accountId) ?? a.accountId,
      availableCents: a.availableCents,
    })),
  };
}

/** The projection fields a One-Time Spend soft warning reads — never a balance, only two flags. */
type InsolvencyWarningSource = Pick<ProjectionSeries, "status" | "blockedAtMonth" | "months">;

/** One authored spend whose plan goes insolvent from some month on — a soft warning, never a block. */
export interface OneTimeSpendInsolvencyWarningView {
  readonly eventId: string;
  /** The spend in the household's own words ("New roof"), not the obligation's report band. */
  readonly eventLabel: string;
  readonly month: number;
  /** The first month, at or after the spend, the plan cannot cover everything it owes. */
  readonly insolventFromMonth: number;
}

/**
 * A post-add **soft warning** (CONTEXT.md's precise term — never a **Nudge**, which proposes a
 * value change; this proposes nothing), one per authored `OneTimeSpendEvent` whose own draw
 * resolved (it is not itself the blocking obligation, and the projection reached its month) but
 * whose plan goes insolvent from some month at or after it. Non-dismissible by construction:
 * nothing here is ever stored — the caller renders one for every entry this returns, each render
 * re-derived from the live projection, so it disappears the moment the condition no longer holds
 * (a smaller amount, a different month, more income) rather than needing to be dismissed.
 *
 * Never fires for a spend the projection never reached (authored after a block) or that IS the
 * block: {@link blockedWarning} already covers that case with its own, distinct copy.
 */
export function oneTimeSpendInsolvencyWarnings(
  ledger: Ledger,
  series: InsolvencyWarningSource | undefined,
): OneTimeSpendInsolvencyWarningView[] {
  if (series === undefined) return [];
  const warnings: OneTimeSpendInsolvencyWarningView[] = [];
  for (const event of ledger.events) {
    if (event.type !== "OneTimeSpendEvent") continue;
    // Never reached, or itself the reason the projection stopped: `blockedWarning` speaks to that.
    if (series.status === "blocked" && series.blockedAtMonth !== undefined && event.month >= series.blockedAtMonth) {
      continue;
    }
    const insolventMonth = series.months.find((m) => m.month >= event.month && m.isInsolvent);
    if (insolventMonth === undefined) continue;
    warnings.push({
      eventId: event.id,
      eventLabel: summarizeEvent(event).label,
      month: event.month,
      insolventFromMonth: insolventMonth.month,
    });
  }
  return warnings;
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
