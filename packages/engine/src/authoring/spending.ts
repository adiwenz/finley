/**
 * One-Time Spend: a dated, source-directed cash outflow the user funds from named accounts in a
 * chosen order. Distinct from Home Purchase (`./housing`), which carries a price and mortgage
 * terms this does not — the two share only the funding machinery: an ordered draw, resolved at
 * simulation time, that blocks the projection rather than the append.
 *
 * Unlike the down payment's hard block, authoring here never refuses on affordability: `check`
 * (`eventHandlers.ts`) is purely structural, so there is no gate to price against a projection
 * and this module needs none of `./housing`'s affordability plumbing.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { Cents } from "../money/money";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";

/** Author a One-Time Spend event: a labeled, dated, source-directed outflow. */
export interface OneTimeSpendInput {
  readonly month: number;
  readonly label: string;
  /** NOMINAL at `month` — a one-time decision the user prices themselves. */
  readonly amountCents: Cents;
  /** Liquid accounts and/or credit cards drained in order; at least one is required. */
  readonly fundingSourceIds: readonly string[];
}

/**
 * The person a spend is authored "for" is not tracked — unlike a home purchase, nothing here
 * originates a durable, owned entity, so there is no `ownerId` to stamp. Returns the minted
 * `"spend-N"` id.
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

