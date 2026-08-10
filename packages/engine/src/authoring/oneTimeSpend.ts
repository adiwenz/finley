/**
 * Authoring a One-Time Spend: a dated, source-directed cash outflow. One event, one mint —
 * unlike {@link import("./housing").applyHomePurchase}, there is no paired dependent artifact
 * (no mortgage) to mint alongside it.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { Cents } from "../money/money";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";

/** A dated, source-directed spend authored during the plan. */
export interface OneTimeSpendInput {
  readonly month: number;
  readonly label: string;
  readonly amountCents: Cents;
  /** Accounts (and credit cards) funding the spend, in drain order. */
  readonly fundingSourceIds: readonly string[];
}

/**
 * Author the spend as one event. Never refused on affordability — a shortfall against the
 * named sources blocks the projection at `input.month` instead, and this call always lands.
 * Returns the minted `"spend-N"` id.
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
