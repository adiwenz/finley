/**
 * Pure presentation logic for the Goals panel: scores each plan goal against the projection
 * via the engine's on-track math, and reprioritizes the list. Reordering changes who the
 * waterfall funds first, so the *other* goals' on-track numbers move — the tradeoff a
 * shared priority list exists to show.
 */

import {
  computeGoalProgress,
  buildPlanAccounts,
  buildPlanGoals,
  eventsFundedByGoal,
  withGoalPatch,
  withGoalReordered,
  withoutGoal,
  type ProjectionSeries,
} from "@finley/engine";
import type {
  Plan,
  GoalPlan,
  GoalDisposition,
  GoalDisposal,
  GoalAccountType,
  GoalCompletion,
  Ledger,
} from "@finley/engine";
import { summarizeEvent } from "./ledgerView";
import { monthLabel } from "./format";

export function dispositionLabel(disposition: GoalDisposition): string {
  switch (disposition) {
    case "retain":
      return "Kept as a reserve";
    case "drawDown":
      return "Drawn down over time";
  }
}

export interface GoalRow {
  readonly id: string;
  readonly name: string;
  readonly targetCents: number;
  readonly targetDate: number | "asap";
  /** Position in the funding order; 0 is funded first. */
  readonly priority: number;
  /**
   * Projected fund at target ÷ target, whole-number percent, capped at 100. A funded goal
   * keeps earning its account's return so the raw fraction drifts past 1.0, but the
   * waterfall stops depositing at target — "done" is 100%, never more.
   */
  readonly onTrackPct: number;
  /** Whole-number percent. */
  readonly annualReturnPct: number;
  /** True when a near-term goal accumulates into an equity-like account. */
  readonly shortHorizonRiskFlag: boolean;
  /** Latched: In Progress until the fund reaches target on/before the date, then Funded. */
  readonly completion: GoalCompletion;
  /** True when a still-In-Progress goal is off pace (raw on-track fraction < 1). */
  readonly behindPace: boolean;
  readonly disposition: GoalDisposition;
  readonly dispositionLabel: string;
}

/**
 * Rows in priority order. The projection MUST be built from the SAME `budget`, so its
 * fund-account balances line up with the goals' `fundAccountId`s.
 */
export function goalRows(budget: Plan, projection: ProjectionSeries): GoalRow[] {
  const goals = buildPlanGoals(budget);
  const accounts = buildPlanAccounts(budget);
  // `goals` is `budget.goals` mapped in order, so the plan goal at the same index carries
  // this row's editable rate.
  return goals.map((goal, i) => {
    const progress = computeGoalProgress(goal, projection, accounts);
    return {
      id: goal.id,
      name: goal.name,
      targetCents: goal.targetCents,
      targetDate: goal.targetDate,
      priority: goal.priority,
      onTrackPct: Math.min(100, Math.round(progress.onTrackFraction * 100)),
      annualReturnPct: budget.goals[i].annualReturnPct,
      shortHorizonRiskFlag: progress.shortHorizonRiskFlag,
      completion: progress.completion,
      behindPace: progress.completion === "inProgress" && progress.onTrackFraction < 1,
      disposition: goal.disposition,
      dispositionLabel: dispositionLabel(goal.disposition),
    };
  });
}

// The list edits themselves live in the engine (`@finley/engine`'s `plan` module): the
// published `Projection` API reprioritizes and patches goals too, and priority-is-array-index
// is the kind of rule that must not have two implementations. What stays here is the panel's
// vocabulary — a form-shaped {@link GoalDraft}, and the rate as its own control.

export function setGoalRate(
  goals: readonly GoalPlan[],
  id: string,
  annualReturnPct: number,
): readonly GoalPlan[] {
  return withGoalPatch(goals, id, { annualReturnPct });
}

/**
 * The user-authorable shape of a goal — every {@link GoalPlan} field EXCEPT the stable
 * `id`, which the plan owns (add mints a fresh one; edit keeps the old).
 */
export type GoalDraft = {
  readonly name: string;
  readonly targetCents: number;
  readonly annualReturnPct: number;
  /**
   * Optional so a draft omitting it keeps the engine's legacy default (a capital-gains
   * investment); the form always supplies one.
   */
  readonly accountType?: GoalAccountType;
} & GoalDisposal;

/** Selectable goal account types, in the order the form lists them; the default is `"cash"`. */
export const GOAL_ACCOUNT_TYPES: readonly {
  readonly value: GoalAccountType;
  readonly label: string;
}[] = [
  { value: "cash", label: "Cash / savings" },
  { value: "brokerage", label: "Taxable brokerage" },
  { value: "taxExempt", label: "Tax-exempt (Roth-like)" },
  { value: "preTax", label: "Pre-tax retirement" },
];

/** Pair two independently-held form controls; every disposition accepts either date form. */
export function goalDisposal(
  disposition: GoalDisposition,
  targetDate: number | "asap",
): GoalDisposal {
  return { disposition, targetDate };
}

/**
 * Replace one goal's authorable fields from a form draft, keeping its id and list position
 * so priority is unchanged. A draft is a WHOLE goal minus its id, so this is a replace, not
 * the engine's field-wise patch.
 */
export function updateGoal(
  goals: readonly GoalPlan[],
  id: string,
  draft: GoalDraft,
): readonly GoalPlan[] {
  return withGoalPatch(goals, id, draft);
}

/**
 * Drop a goal. Its derived `goal-<id>` fund account falls away with it —
 * `buildPlanAccounts` mints one account per remaining goal.
 */
export function removeGoal(goals: readonly GoalPlan[], id: string): readonly GoalPlan[] {
  return withoutGoal(goals, id);
}

/**
 * One event that blocks a goal's deletion, in the shape the block message renders. Carries
 * the event id so a caller can hold on to *which* events blocked without holding the words
 * describing them — the label and month are re-derived from the ledger on every read.
 */
export interface GoalFundingBlock {
  readonly eventId: string;
  readonly label: string;
  readonly month: number;
}

/**
 * The blocking events in the words a person reads. Which events block is the engine's
 * question ({@link eventsFundedByGoal} — already in timeline order); this only names them,
 * with the same labels the timeline shows.
 */
export function goalFundingBlocks(
  goals: readonly GoalPlan[],
  id: string,
  ledger: Ledger,
): GoalFundingBlock[] {
  return eventsFundedByGoal(goals, id, ledger).map((e) => ({
    eventId: e.id,
    label: summarizeEvent(e).label,
    month: e.month,
  }));
}

/**
 * The refuse-to-delete text for a given set of blockers, or null for none. The single
 * authority for the wording; callers that hold a narrowed set of blockers (one refusal's
 * own) format through here rather than re-deriving the sentence.
 */
export function fundingBlockMessage(blocks: readonly GoalFundingBlock[]): string | null {
  if (blocks.length === 0) return null;
  const lines = blocks.map((b) => `- ${b.label} in ${monthLabel(b.month)}`);
  return ["This account cannot be deleted because it funds:", ...lines].join("\n");
}


/**
 * Move a goal one slot earlier ("up", funded sooner) or later ("down"); a no-op at the
 * ends. Since priority is array position, this is the only reprioritization primitive.
 */
export function reorderGoal(
  goals: readonly GoalPlan[],
  id: string,
  direction: "up" | "down",
): readonly GoalPlan[] {
  return withGoalReordered(goals, id, direction);
}
