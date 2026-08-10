/**
 * One-Time Spend: a dated, source-directed cash outflow, funded from named accounts (liquid or
 * credit) in a chosen drain order. Unlike a home purchase's down payment, authoring never refuses
 * on affordability — a shortfall blocks the PROJECTION instead, at the event's own month.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";
import { removeProjectionTransaction } from "./revise";
import { runProjection } from "../facade/projectionRun";

/** A one-time, source-directed spend — see {@link import("../ledger/eventTypes").OneTimeSpendEvent}. */
export interface SpendOnceInput {
  readonly month: number;
  readonly label: string;
  /** NOMINAL at `month` — priced by the user, not grown from today's dollars. */
  readonly amountCents: number;
  /** Accounts (or a named credit card) drained in this order. */
  readonly fundingSourceIds: readonly string[];
}

/**
 * Author the spend. Answers with the minted `"spend-N"` id. Never refused for affordability —
 * only for a source that does not exist — so the event always lands; the household learns of a
 * shortfall from the projection blocking at its month, not from a refusal here.
 */
export function applyOneTimeSpend(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: SpendOnceInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "spend");
  return {
    state: appendEvent(
      state,
      jurisdiction,
      {
        id,
        type: "OneTimeSpendEvent",
        month: input.month,
        label: input.label,
        amountCents: input.amountCents,
        fundingSourceIds: input.fundingSourceIds,
      },
      nextSeq,
    ),
    result: id,
  };
}

/**
 * A post-add, whole-month-feasibility read: this spend cleared its own funding gate (it is not
 * blocked), but realizing its sources' gains — or simply spending down the accounts decumulation
 * would otherwise have reached later — widens the automatic gap and pushes the plan into
 * insolvency sooner than it would have gone without it. Advisory, never a block: the household's
 * remedies for a funding shortfall (another account, a smaller amount, a different month) do not
 * address this, so silence would be as wrong as blocking.
 *
 * Derived from the projection {@link state} already carries — the spend must already be on the
 * ledger — by re-running it once WITHOUT the event and comparing where each run first goes
 * insolvent. `null` when the spend is not on the ledger, was itself blocked (a different, harder
 * warning), or the plan was already heading to insolvency at least as early without it.
 */
export interface SpendInsolvencyNudge {
  readonly eventId: string;
  readonly insolventFromMonth: number;
}

export function oneTimeSpendInsolvencyNudge(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  eventId: string,
): SpendInsolvencyNudge | null {
  const event = state.scenario.ledger.events.find(
    (e) => e.id === eventId && e.type === "OneTimeSpendEvent",
  );
  if (event === undefined) return null;

  const withEvent = runProjection(state, jurisdiction);
  if (withEvent.firstInsolventMonth === null) return null;
  // A blocked draw already carries its own, harder warning — never pile a second one on top.
  const outcome = withEvent.series.obligationOutcomes[`draw:${event.id}`];
  if (outcome !== undefined && outcome.status === "blocked") return null;

  let without: ProjectionState;
  try {
    without = removeProjectionTransaction(state, jurisdiction, eventId);
  } catch {
    return null;
  }
  const withoutEvent = runProjection(without, jurisdiction);
  if (
    withoutEvent.firstInsolventMonth !== null &&
    withoutEvent.firstInsolventMonth <= withEvent.firstInsolventMonth
  ) {
    return null;
  }
  return { eventId, insolventFromMonth: withEvent.firstInsolventMonth };
}
