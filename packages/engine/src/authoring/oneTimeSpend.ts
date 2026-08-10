/**
 * One-Time Spend: a dated, source-directed cash outflow — the transaction that authors one, and
 * the post-add nudge that reads whether it leaves the plan insolvent later on.
 *
 * Distinct from Home Purchase, which carries price and mortgage terms this does not; the two
 * share only the funding machinery — the ordered-drain gate `applyOneTimeSpend` is subject to
 * (`oneTimeSpend.check`, `eventHandlers.ts`) and the block it produces on a shortfall.
 */

import type { Cents } from "../money/money";
import type { OneTimeSpendEvent } from "../ledger/eventTypes";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";

/** Author a `OneTimeSpendEvent`; see {@link OneTimeSpendEvent} for field semantics. */
export interface OneTimeSpendInput {
  readonly month: number;
  readonly label: string;
  /** NOMINAL at `month` — a one-time decision the user prices themselves, unlike a recurring stream. */
  readonly amountCents: Cents;
  /** Drained in order; may include credit cards, unlike a Home Purchase down payment. */
  readonly fundingSourceIds: readonly string[];
}

/**
 * Author the spend. Subject to the same ordered-drain hard block Home Purchase's down payment
 * is: a selection that cannot cover the amount, net of the capital-gains tax liquidating any
 * appreciated source owes, refuses at append time. Returns the minted `"spend-N"` event id.
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

/**
 * The post-add nudge (§5): a spend can pass the gate and still wreck the plan — its realized gain
 * raises the tax bill, widening the automatic gap and forcing more decumulation. Never a block
 * (the user's remedies — another account, a smaller amount, a different month — don't address
 * insolvency, and refusing outright would contradict "authoring never refuses on affordability").
 *
 * Compares the FIRST insolvent month before and after the spend was added — both already
 * computed by the projections a caller re-runs anyway (the graph and retirement panel), so this
 * costs no extra simulation. `null` when the spend introduces no NEW insolvency: the plan was
 * already insolvent at least that early, or stays solvent throughout.
 */
export interface OneTimeSpendNudge {
  /** The first month the plan goes insolvent, only because this spend was added. */
  readonly insolventFromMonth: number;
}

export function assessOneTimeSpendNudge(
  firstInsolventMonthBefore: number | null,
  firstInsolventMonthAfter: number | null,
): OneTimeSpendNudge | null {
  if (firstInsolventMonthAfter === null) return null;
  if (
    firstInsolventMonthBefore !== null &&
    firstInsolventMonthBefore <= firstInsolventMonthAfter
  ) {
    return null;
  }
  return { insolventFromMonth: firstInsolventMonthAfter };
}
