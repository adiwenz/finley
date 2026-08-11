/**
 * One-Time Spend: a dated, source-directed cash outflow the household funds from named accounts
 * (and, eligibly, credit cards) in a chosen order.
 *
 * Distinct from a dated expense override, which finances itself from the engine's default
 * liquidation order and never blocks: this names WHICH accounts to draw, in WHAT order, and
 * blocks the projection rather than silently financing itself when they fall short. Authoring
 * never refuses on affordability — unlike Home Purchase's down payment, there is no hard block
 * here; a shortfall is a projection-time block, not an authoring-time refusal.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { Cents } from "../money/money";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";

export interface OneTimeSpendInput {
  readonly month: number;
  readonly label: string;
  readonly amountCents: Cents;
  /** Liquid accounts and/or credit cards funding the spend, drained in this order. */
  readonly fundingSourceIds: readonly string[];
}

/** Author the spend as one event. Answers with the minted `"spend-N"` id. */
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
