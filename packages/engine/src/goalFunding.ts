/**
 * Funding-reference integrity for goals: which authored events name a goal's derived fund
 * account as the money they spend. Dropping a goal drops its account, so any event still
 * naming it would be left pointing at an account that does not exist.
 *
 * Pure structure over the ledger — it asks what an event *references*, never what the
 * simulator resolves, so a reference counts whether or not the draw ever succeeds. Reasons
 * are phrased in engine vocabulary (event id, type, month); turning them into the
 * plain-language a person reads is the app's job.
 */

import type { GoalPlan } from "./plan";
import type { Ledger, ValidationResult } from "./ledger/ledger";
import type { LifeEvent } from "./ledger/eventTypes";
import { goalFundAccountId } from "./projectionBase";

/**
 * The account ids an event spends from, in drain order.
 *
 * Exhaustive over the event union deliberately, with no default arm: a new event type that
 * spends from an account has to answer here or this stops compiling. That is the whole
 * point of the function living beside the union rather than in a consumer.
 */
export function eventFundingSourceIds(event: LifeEvent): readonly string[] {
  switch (event.type) {
    // Ordered down-payment sources, each emptied before the next.
    case "HomePurchaseEvent":
      return event.downPaymentSourceIds;
    // The paired outflow: a payoff reduces the liability and drains this account.
    case "DebtPayoffEvent":
      return [event.accountId];
    // Structural or series-only — no account is spent from.
    case "RelationshipEvent":
    case "ChildEvent":
    case "SeparationEvent":
    case "LoanEvent":
      return [];
  }
}

/**
 * The events that spend from the goal's derived fund account, sorted by (month, sequence)
 * so callers can list them in timeline order. Empty when the account is unreferenced — and
 * for an unknown goal id, which references nothing by definition.
 */
export function eventsFundedByGoal(
  goals: readonly GoalPlan[],
  goalId: string,
  ledger: Ledger,
): readonly LifeEvent[] {
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return [];
  const fundAccountId = goalFundAccountId(goal);
  return [...ledger.events]
    .filter((e) => eventFundingSourceIds(e).includes(fundAccountId))
    .sort((a, b) => a.month - b.month || a.sequenceNumber - b.sequenceNumber);
}

/**
 * Whether a goal may be removed: refused while its fund account still funds an event, with
 * every blocker named so the caller can say which events to re-point first. Removing an
 * unreferenced goal — or one that is not in the list — is always allowed.
 */
export function validateGoalRemoval(
  goals: readonly GoalPlan[],
  goalId: string,
  ledger: Ledger,
): ValidationResult {
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return { ok: true };
  const blockers = eventsFundedByGoal(goals, goalId, ledger);
  if (blockers.length === 0) return { ok: true };
  const named = blockers.map((e) => `"${e.id}" (${e.type}, month ${e.month})`).join(", ");
  return {
    ok: false,
    reason: `Cannot remove goal "${goalId}": its fund account "${goalFundAccountId(goal)}" funds ${named}`,
  };
}
