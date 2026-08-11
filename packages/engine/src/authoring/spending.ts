/**
 * The One-Time Spend transaction: a dated, source-directed cash outflow, drained from named
 * accounts (and/or credit cards) in the user's chosen order.
 *
 * Shares the down payment's ordered-drain funding machinery with `./housing` and nothing else —
 * no price, no financing terms, no dependent artifact. And unlike a home purchase, it is never
 * refused on affordability at authoring time: {@link applySpendOnce} carries no hard block, so a
 * spend whose named sources fall short is still accepted and left to block the PROJECTION at its
 * month instead of the append.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { Cents } from "../money/money";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";

export interface SpendOnceInput {
  readonly month: number;
  readonly label: string;
  readonly amountCents: Cents;
  /** Liquid accounts and/or credit cards drained for the spend, in order. */
  readonly fundingSourceIds: readonly string[];
}

/** Author a One-Time Spend as a single event. Returns the minted `"spend-N"` id. */
export function applySpendOnce(
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
