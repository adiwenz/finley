/**
 * A household's standing figures, as opposed to timeline events. `createProjectionBase`
 * maps a `Plan` plus a `ProjectionContext` into the ledger base the simulator runs.
 */

import type { GoalDisposal } from "./goal";
import type { OverrideScope } from "./cashFlowSeries";
import type { SharedContributionScheme } from "./projection/waterfall";
import type { Job } from "./job";
import type { BudgetLine } from "./budgetLine";

export interface ValueOverride {
  readonly month: number;
  readonly monthlyCents: number;
  readonly scope: OverrideScope;
}

/**
 * A goal fund account's {@link import("./simAccount").SimAccountTaxProfile} and liquidity:
 *  - `"cash"`      — tax-free withdrawal (interest taxed at accrual), liquid;
 *  - `"brokerage"` — post-tax in, capital-gains out, liquid;
 *  - `"taxExempt"` — post-tax in, tax-free out, growth untaxed, illiquid (age/penalty);
 *  - `"preTax"`    — pre-tax in, ordinary-income out, illiquid.
 */
export type GoalAccountType = "cash" | "brokerage" | "taxExempt" | "preTax";

/**
 * Where the residual after every goal and standing contribution is funded lands.
 * `"savings"` (default) idles it in Cash at {@link Plan.savingsReturnPct}; `"brokerage"`
 * sweeps it into the taxable brokerage at {@link Plan.brokerageReturnPct}. Maps to
 * {@link import("./projection/waterfall").SurplusDestination} (`idle` / `swept`), keeping
 * account ids inside the engine.
 */
export type SurplusCashDestination = "savings" | "brokerage";

/**
 * Priority is the goal's index in {@link Plan.goals} (0 = funded first). Each goal
 * accumulates into its own derived fund account (`goal-<id>`).
 */
interface GoalPlanBase {
  readonly id: string;
  readonly name: string;
  readonly targetCents: number;
  /**
   * Whole-number percent. Also drives the short-horizon-risk flag (near-term goal in a
   * market-risk account).
   */
  readonly annualReturnPct: number;
  /** Defaults to `"brokerage"`. */
  readonly accountType?: GoalAccountType;
}

/**
 * Both dispositions are purely descriptive, so either accepts a concrete month or
 * `"asap"`.
 */
export type GoalPlan = GoalPlanBase & GoalDisposal;

/**
 * Immutable — replace it, never mutate in place. Identity changes only when a value does,
 * so consumers can memoize the projection base on `[plan]`.
 */
export interface Plan {
  readonly name: string;
  readonly expenseCents: number;
  readonly expenseOverrides: readonly ValueOverride[];
  readonly openingBalanceCents: number;
  /**
   * Per-account annual returns, whole-number percents. Goal fund accounts carry their own
   * rate on {@link GoalPlan}.
   */
  readonly savingsReturnPct: number;
  readonly retirementReturnPct: number;
  readonly brokerageReturnPct: number;
  readonly sharedScheme: SharedContributionScheme;
  /** Defaults to `"savings"`. */
  readonly surplusCashTo?: SurplusCashDestination;
  readonly goals: readonly GoalPlan[];
  /**
   * Monthly self-funded health expense paid until public coverage begins (and for life
   * when {@link enrollsInPublicHealthCoverage} is false), cents. ADDITIVE to
   * {@link expenseCents}, not a slice of it; grows at {@link healthInflationPct}.
   * Understating it while retiring early trips the early-retiree honesty nudge.
   */
  readonly healthMonthlyCents: number;
  /**
   * Monthly health expense from the public-coverage age onward, today's dollars, grown at
   * {@link healthInflationPct}. 0 models forgoing coverage. Used only when
   * {@link enrollsInPublicHealthCoverage}.
   */
  readonly postCoverageHealthMonthlyCents: number;
  /**
   * True → health steps from {@link healthMonthlyCents} down to
   * {@link postCoverageHealthMonthlyCents} at the coverage age; false → the self-funded
   * line runs for life.
   */
  readonly enrollsInPublicHealthCoverage: boolean;
  /**
   * Annual growth of the health lines, whole-number percent. The real-dollars retirement
   * drawdown compounds health net of {@link inflationPct}.
   */
  readonly healthInflationPct: number;
  /**
   * General inflation (CPI), whole-number percent. Grows income and general expenses in
   * the nominal projection, and de-inflates every nominal figure for the real net-worth
   * line and the retirement drawdown.
   */
  readonly inflationPct: number;
  /** Age at "now" — the base the retirement solver counts years from. */
  readonly currentAge: number;
  /** The pinned/desired retirement age; target mode reports on-track % against it. */
  readonly retirementAge: number;
  /** Age the portfolio must last to. */
  readonly lifeExpectancy: number;
  /** Pinned government-benefit claiming age — an input to the check, never searched. */
  readonly benefitClaimingAge: number;
  /**
   * Cost-of-living rate for the government retirement benefit, as a DECIMAL rate
   * (e.g. `0.02`), unlike the whole-percent fields above. Unset couples the benefit COLA
   * to {@link inflationPct}.
   */
  readonly benefitColaRate?: number;
  /**
   * Source of truth for earned income. `createProjectionBase` compiles these into the
   * base income series: the primary member's open-ended jobs end at
   * {@link retirementAge}, fixed-term jobs carry their own end. Covered SS earnings,
   * including the pre-"now" record, derive from job spans and salaries — when a person
   * started working is the earliest job's `startYear`, not a separate field.
   */
  readonly jobs: readonly Job[];
  /**
   * Prioritized expense and account-contribution line items. When present and non-empty,
   * the *expense* lines replace the scalar {@link expenseCents} series in
   * `createProjectionBase`; contribution lines resolve via
   * {@link import("./budgetLine").resolveBudget}.
   */
  readonly budgetLines?: readonly BudgetLine[];
}
