/**
 * One-Time Spend: a dated, source-directed cash outflow the household funds from named accounts
 * in a chosen order — the transaction that authors one, and the post-add nudge that reads what
 * the projection it re-runs anyway already knows.
 *
 * Both live here because they concern the same event. The transaction never refuses on
 * affordability — a shortfall blocks the projection instead, at simulate time, the same
 * way an unaffordable down payment does — so there is no preview to gate authoring on; the nudge
 * exists purely to speak up AFTER the spend lands, when it turns out to wreck the plan in a way
 * its own funding gate could never see (Slice #4's gate scopes the marginal tax the draw itself
 * induces, not the knock-on widening of the automatic decumulation gap).
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";

/** Author a One-Time Spend during the plan. */
export interface OneTimeSpendInput {
  readonly month: number;
  readonly label: string;
  readonly amountCents: number;
  /** Liquid accounts and/or credit cards funding the spend, in drain order. */
  readonly fundingSourceIds: readonly string[];
}

/**
 * Author the spend as one event. Subject to no affordability gate — REFUSED only on structural
 * grounds (an unknown funding source); a named source that cannot cover the amount is still
 * authored, and blocks the projection at `month` instead. Answers with the minted `"spend-N"` id.
 */
export function applyOneTimeSpend(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: OneTimeSpendInput,
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

/** The whole-month feasibility nudge (#5): advisory, and it never blocks. */
export interface OneTimeSpendNudge {
  readonly eventId: string;
  /** The first month the plan goes insolvent. */
  readonly insolventMonth: number;
}

/**
 * A spend can pass its own funding gate and still wreck the plan — the realized gain it induces
 * raises the tax bill, widening the automatic gap and forcing more decumulation, until some later
 * month's shortfall cascade can no longer absorb it. Blocking would be wrong (the user's remedies
 * — another account, a smaller amount, a different month — don't address a knock-on tax effect),
 * so this only ever ADVISES, off {@link import("../facade/projectionRun").ProjectionResult}'s
 * already-computed `firstInsolventMonth` — no second simulation, matching {@link
 * import("./housing").assessHomePurchase}'s own rule that a preview reads the run it was given.
 *
 * `null` when the spend was blocked (its own gate already speaks to that, and nothing moved) or
 * the first insolvent month PRECEDES the spend — insolvency this spend cannot be the cause of.
 * Firing on any insolvency from the spend's month onward, not only one strictly after it, matches
 * "authored in a month that also has decumulation" (Slice #4's gate == sim case): a spend that is
 * itself the marginal cause of THIS month's shortfall must still be named.
 */
export function assessOneTimeSpendNudge(params: {
  readonly eventId: string;
  readonly eventMonth: number;
  readonly blocked: boolean;
  readonly firstInsolventMonth: number | null;
}): OneTimeSpendNudge | null {
  if (params.blocked) return null;
  if (params.firstInsolventMonth === null) return null;
  if (params.firstInsolventMonth < params.eventMonth) return null;
  return { eventId: params.eventId, insolventMonth: params.firstInsolventMonth };
}
