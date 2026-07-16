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
  /**
   * Authored monthly PRE-Medicare health-care expense in cents (§5.4) — the
   * self-funded figure paid until Medicare enrolment (and for life when
   * {@link enrollsInMedicare} is false). A dedicated budget line, separate from and
   * ADDITIVE to {@link expenseCents} (which carries non-health spend), modelled as a
   * real expense in both projections and growing at {@link healthInflationPct}. It
   * is the figure the early-retiree honesty check compares against the pre-65
   * self-funded benchmark (understating it while retiring before 65 trips a nudge).
   */
  readonly healthMonthlyCents: number;
  /**
   * Authored monthly health-care expense in cents from age 65 onward — the Medicare
   * residual (premiums/Part B/out-of-pocket) that remains after enrolment (§5.4). In
   * today's dollars, grown at {@link healthInflationPct}. Set to 0 to model forgoing
   * coverage. Used only when {@link enrollsInMedicare}; ignored otherwise.
   */
  readonly postMedicareHealthMonthlyCents: number;
  /**
   * Whether the plan enrols in Medicare at 65 (§5.4). True → health steps from
   * {@link healthMonthlyCents} down to {@link postMedicareHealthMonthlyCents} at 65.
   * False → the pre-Medicare (self-funded) line runs for life with no step.
   */
  readonly enrollsInMedicare: boolean;
  /**
   * Annual growth of the health lines, as a whole-number percent (§5.4). Health is
   * modelled like any other budget item but with its own rate. In the nominal
   * projection it compounds the health series; in the (real-dollars) retirement
   * drawdown it compounds health net of {@link inflationPct}, so health rises in
   * real terms only insofar as it outpaces general inflation.
   */
  readonly healthInflationPct: number;
  /**
   * General inflation (CPI), as a whole-number percent. Income and general expenses
   * grow at this rate each year in the nominal projection (so they hold constant in
   * real terms), and it is the rate every nominal figure is de-inflated by to give
   * the real (today's-dollars) net-worth line and the retirement drawdown (§0.5).
   */
  readonly inflationPct: number;
  /** Age at "now" — the base the retirement solver counts years from (§7). */
  readonly currentAge: number;
  /** The pinned/desired retirement age; target mode reports on-track % against it (§7.1). */
  readonly retirementAge: number;
  /** Age the portfolio must last to — the retirement survival horizon (§7). */
  readonly lifeExpectancy: number;
  /** Pinned Social Security claiming age — an input to the check, never searched (§7). */
  readonly ssClaimingAge: number;
}
