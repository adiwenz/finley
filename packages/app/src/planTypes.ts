/** Application-level plan types for the value-editing surface (§10.2). */

import type { GoalType, OverrideScope, SharedContributionScheme } from "@finley/engine";

export interface ValueOverride {
  readonly month: number;
  readonly monthlyCents: number;
  readonly scope: OverrideScope;
}

/**
 * A funding goal on the value-editing surface (§5.2). Priority is the goal's
 * position in {@link BudgetValues.goals} (index 0 = funded first), so reordering
 * the array IS reprioritizing — one of the four exposed waterfall levers (§5.0).
 * Each goal accumulates into its own derived fund account (`goal-<id>`).
 */
export interface GoalPlan {
  readonly id: string;
  readonly name: string;
  readonly targetCents: number;
  /** Absolute simulation month wanted by, or "asap". */
  readonly targetDate: number | "asap";
  readonly type: GoalType;
  /**
   * Annual return on this goal's fund account, as a whole-number percent. Drives
   * both the projected growth and the §5.2 short-horizon-risk flag (a near-term
   * goal in a high-return, market-risk account).
   */
  readonly annualReturnPct: number;
}

/**
 * The ongoing numbers a user edits directly, with no timeline event. Held as one
 * object so its identity only changes when a value actually changes; that lets
 * `App` memoize the projection base on `[budget]`. React treats it as immutable —
 * replace it, never mutate in place.
 */
export interface BudgetValues {
  readonly name: string;
  readonly incomeCents: number;
  readonly expenseCents: number;
  readonly expenseOverrides: readonly ValueOverride[];
  readonly openingBalanceCents: number;
  /**
   * Per-account annual return, as whole-number percents. Each standing account
   * carries its own rate so, e.g., the swept brokerage can out-earn idle savings
   * (which is what makes the surplus-destination lever move net worth, not just
   * shuffle balances). Goal fund accounts carry their own rate on {@link GoalPlan}.
   */
  readonly savingsReturnPct: number;
  readonly retirementReturnPct: number;
  readonly brokerageReturnPct: number;
  /**
   * Lever 1 (§5.0): fraction of income deferred pre-tax into the retirement
   * account, as a whole-number percent. 0 = no plan (income is fully post-tax).
   */
  readonly retirementDeferralPct: number;
  /** Lever 2 (§5.0): how shared obligations are split between partners. */
  readonly sharedScheme: SharedContributionScheme;
  /** Lever 4 (§5.0): true sweeps leftover cash to a brokerage; false idles it. */
  readonly surplusSwept: boolean;
  /** Lever 3 (§5.0): funding goals in priority order (array index = priority). */
  readonly goals: readonly GoalPlan[];
  /** Age at "now" — the base the retirement solver counts years from (§7). */
  readonly currentAge: number;
  /** The pinned/desired retirement age; target mode reports on-track % against it (§7.1). */
  readonly retirementAge: number;
  /** Age the portfolio must last to — the retirement survival horizon (§7). */
  readonly lifeExpectancy: number;
  /** Pinned Social Security claiming age — an input to the check, never searched (§7). */
  readonly ssClaimingAge: number;
  /** Real annual Social Security benefit once claiming, in cents. */
  readonly socialSecurityAnnualCents: number;
}
