/**
 * The engine's primary input: the standing figures (income, expenses, per-account
 * returns, health-care lines, ages) describing a household's steady state, as opposed
 * to timeline events. `createProjectionBase` maps a `Plan` plus a `ProjectionContext`
 * into the ledger base the simulator runs.
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
 * The kind of account a goal's fund is held in — the thing a person actually knows
 * ("my emergency fund is in savings"). Source of truth for the fund account's
 * {@link import("./simAccount").SimAccountTaxProfile} and liquidity, rather than
 * hard-coding every goal to a capital-gains investment. Covers all four standing
 * vehicles:
 *  - `"cash"`      — cash/savings buffer: tax-free withdrawal (interest taxed at
 *                    accrual), liquid — a reserve exists to be reachable;
 *  - `"brokerage"` — taxable investment: post-tax in, capital-gains out, liquid
 *                    (sellable on demand);
 *  - `"taxExempt"` — Roth-like: post-tax in, tax-free out, growth untaxed, illiquid
 *                    (age/penalty rules);
 *  - `"preTax"`    — tax-deferred: pre-tax in, ordinary-income out, illiquid.
 */
export type GoalAccountType = "cash" | "brokerage" | "taxExempt" | "preTax";

/**
 * Where each month's leftover cash — the residual after every goal and standing
 * contribution is funded — lands. `"savings"` (default) idles it in the liquid Cash
 * account earning {@link Plan.savingsReturnPct}; `"brokerage"` sweeps it into the
 * taxable brokerage earning {@link Plan.brokerageReturnPct}. Plan-authoring shape of
 * the engine's {@link import("./projection/waterfall").SurplusDestination}
 * (`idle` / `swept`); `createProjectionBase` maps the two, keeping the concrete
 * account id inside the engine.
 */
export type SurplusCashDestination = "savings" | "brokerage";

/**
 * A funding goal. Priority is the goal's position in {@link Plan.goals}
 * (index 0 = funded first), so reordering the array IS reprioritizing. Each goal
 * accumulates into its own derived fund account (`goal-<id>`).
 */
interface GoalPlanBase {
  readonly id: string;
  readonly name: string;
  readonly targetCents: number;
  /**
   * Annual return on this goal's fund account, whole-number percent. Drives projected
   * growth and the short-horizon-risk flag (near-term goal in a market-risk account).
   */
  readonly annualReturnPct: number;
  /**
   * The {@link GoalAccountType} the fund is held in; tax profile and liquidity derive
   * from it. Optional — an undeclared type defaults to `"brokerage"` (capital-gains,
   * liquid).
   */
  readonly accountType?: GoalAccountType;
}

/**
 * A funding goal. The `disposition`/`targetDate` pairing is the engine's
 * {@link GoalDisposal}; both dispositions are purely descriptive, so either accepts a
 * concrete month or `"asap"`. Sharing the type keeps plan and sim goal from drifting.
 */
export type GoalPlan = GoalPlanBase & GoalDisposal;

/**
 * The household's steady-state numbers, no timeline events. One object so identity
 * changes only when a value does, letting consumers memoize the projection base on
 * `[plan]`. Immutable — replace it, never mutate in place.
 */
export interface Plan {
  readonly name: string;
  readonly expenseCents: number;
  readonly expenseOverrides: readonly ValueOverride[];
  readonly openingBalanceCents: number;
  /**
   * Per-account annual returns, whole-number percents — so a brokerage can out-earn
   * idle savings. Goal fund accounts carry their own rate on {@link GoalPlan}.
   */
  readonly savingsReturnPct: number;
  readonly retirementReturnPct: number;
  readonly brokerageReturnPct: number;
  /** How shared obligations are split between partners. */
  readonly sharedScheme: SharedContributionScheme;
  /**
   * Where the month's leftover cash lands. Optional — defaults to `"savings"` (idle in
   * the liquid account), so no existing `Plan` literal needs editing. `"brokerage"`
   * sweeps the surplus into the taxable brokerage to earn the brokerage return.
   */
  readonly surplusCashTo?: SurplusCashDestination;
  /** Funding goals in priority order (array index = priority). */
  readonly goals: readonly GoalPlan[];
  /**
   * Monthly pre-public-coverage health expense, cents — the self-funded figure paid
   * until public coverage begins (and for life when
   * {@link enrollsInPublicHealthCoverage} is false). Separate from and ADDITIVE to
   * {@link expenseCents} (non-health spend); a real expense in both projections,
   * growing at {@link healthInflationPct}. The early-retiree honesty check compares
   * it against the pre-coverage self-funded benchmark — understating it while retiring
   * early trips a nudge.
   */
  readonly healthMonthlyCents: number;
  /**
   * Monthly health expense from the public-coverage age onward — the residual
   * (premiums/out-of-pocket) after coverage begins. Today's dollars, grown at
   * {@link healthInflationPct}. 0 models forgoing coverage. Used only when
   * {@link enrollsInPublicHealthCoverage}.
   */
  readonly postCoverageHealthMonthlyCents: number;
  /**
   * True → health steps from {@link healthMonthlyCents} down to
   * {@link postCoverageHealthMonthlyCents} at the coverage age. False → the
   * self-funded line runs for life with no step.
   */
  readonly enrollsInPublicHealthCoverage: boolean;
  /**
   * Annual growth of the health lines, whole-number percent. The nominal projection
   * compounds the health series by it; the real-dollars retirement drawdown compounds
   * health net of {@link inflationPct}, so health rises in real terms only insofar as
   * it outpaces general inflation.
   */
  readonly healthInflationPct: number;
  /**
   * General inflation (CPI), whole-number percent. Income and general expenses grow at
   * it each year in the nominal projection (holding constant in real terms), and every
   * nominal figure is de-inflated by it for the real net-worth line and the retirement
   * drawdown.
   */
  readonly inflationPct: number;
  /** Age at "now" — the base the retirement solver counts years from. */
  readonly currentAge: number;
  /** The pinned/desired retirement age; target mode reports on-track % against it. */
  readonly retirementAge: number;
  /** Age the portfolio must last to — the retirement survival horizon. */
  readonly lifeExpectancy: number;
  /** Pinned government-benefit claiming age — an input to the check, never searched. */
  readonly benefitClaimingAge: number;
  /**
   * Cost-of-living rate for the government retirement benefit, as a DECIMAL rate
   * (e.g. `0.02`). Unset COUPLES the benefit COLA to general inflation
   * ({@link inflationPct}); setting it DECOUPLES the two — a benefit indexing below or
   * above general CPI.
   */
  readonly benefitColaRate?: number;
  /**
   * Source of truth for earned income. `createProjectionBase` compiles these into the
   * base income series: the primary member's open-ended jobs end at
   * {@link retirementAge}, fixed-term jobs carry their own end. Covered SS earnings,
   * including the pre-"now" record, derive from job spans and salaries — so when a
   * person started working is the earliest job's `startYear`, not a separate field.
   */
  readonly jobs: readonly Job[];
  /**
   * Prioritized dollar line items — expenses and account contributions — each with a
   * `{ literal, fill-to-limit, goal-paced }` amount source and optional spans + dated
   * overrides. When present and non-empty, `createProjectionBase` compiles the
   * *expense* lines into the base expense series in place of the scalar
   * {@link expenseCents}; contribution lines resolve via
   * {@link import("./budgetLine").resolveBudget}. Optional — engine-native fixtures may
   * still author spending through the scalar {@link expenseCents} series.
   */
  readonly budgetLines?: readonly BudgetLine[];
}
