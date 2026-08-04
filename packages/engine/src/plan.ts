/**
 * A household's standing figures, as opposed to timeline events. `createProjectionBase`
 * maps a `Plan` plus a `ProjectionContext` into the ledger base the simulator runs.
 */

import type { GoalDisposal } from "./goal";
import type { SharedContributionScheme } from "./projection/waterfall";
import type { Job } from "./job";
import type { BudgetLine } from "./budgetLine";

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
 * accumulates into its own derived fund account (`fund-<id>`).
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

export type GoalPlan = GoalPlanBase & GoalDisposal;

/**
 * Immutable — replace it, never mutate in place, so consumers can memoize the projection
 * base on `[plan]`.
 */
export interface Plan {
  readonly name: string;
  readonly openingBalanceCents: number;
  /**
   * Whole-number percents. Goal fund accounts carry their own rate on {@link GoalPlan}.
   */
  readonly savingsReturnPct: number;
  readonly retirementReturnPct: number;
  readonly brokerageReturnPct: number;
  readonly sharedScheme: SharedContributionScheme;
  /** Defaults to `"savings"`. */
  readonly surplusCashTo?: SurplusCashDestination;
  readonly goals: readonly GoalPlan[];
  /**
   * General inflation (CPI), whole-number percent. Grows income and general expenses in
   * the nominal projection, and de-inflates every nominal figure for the real net-worth
   * line and the retirement drawdown.
   */
  readonly inflationPct: number;
  /** The base the retirement solver counts years from. */
  readonly currentAge: number;
  /** Target mode reports on-track % against it. */
  readonly retirementAge: number;
  /** Age the portfolio must last to. */
  readonly lifeExpectancy: number;
  /** An input to the check, never searched. */
  readonly benefitClaimingAge: number;
  /**
   * A DECIMAL rate (e.g. `0.02`), unlike the whole-percent fields above. Unset couples the
   * benefit COLA to {@link inflationPct}.
   */
  readonly benefitColaRate?: number;
  /**
   * Source of truth for earned income. `createProjectionBase` compiles these into the base
   * income series: the primary member's open-ended jobs end at {@link retirementAge},
   * fixed-term jobs carry their own end. Covered SS earnings, including the pre-"now"
   * record, derive from job spans and salaries — when a person started working is the
   * earliest job's `startYear`, not a separate field.
   */
  readonly jobs: readonly Job[];
  /**
   * The sole expense authoring surface, and REQUIRED: a plan always states its spend, even if
   * that statement is "nothing". `createProjectionBase` compiles the *expense* lines into the
   * household's general-expense series; contribution lines resolve via
   * {@link import("./budgetLine").resolveBudget}. An empty array is the deliberate no-spending
   * plan — only event-created costs remain — and is indistinguishable to the engine from a
   * budget of zero-amount lines. Health is one of these lines like any other; the plan carries
   * no standing health figure of its own.
   */
  readonly budgetLines: readonly BudgetLine[];
}

// ── The maximum age ──

/**
 * The oldest age this engine will carry a person to.
 *
 * A bound on the SIMULATION, stated as a bound on a person: the horizon is
 * `(lifeExpectancy − currentAge) × 12` months and every month is simulated in full, so an age
 * typed with an extra digit — 950 for 95 — asks for seventy years of projection nobody wanted
 * and the app sits there computing it. 120 is past the oldest verified human life, so a plan
 * that means something can always be authored under it, and nothing above it is a plan rather
 * than a typo.
 *
 * The engine refuses such an age rather than clamping it: a plan quietly projected to an age it
 * does not state is a plan whose own numbers disagree with the answer beside them, and the
 * caller — who can still see the 950 in the field they typed it into — is never told why.
 */
export const MAX_AGE = 120;

/**
 * The ceiling on each age the engine accepts. {@link MAX_AGE} is the outer bound — no age
 * exceeds it — and these are where each particular age stops first.
 *
 * They are not all the same number, because they do not all mean the same thing. A life
 * expectancy and a retirement age are ages a person is projected TO, so they reach the ceiling
 * itself. An age a person already IS stops one year below it (119): the projection has to have
 * somewhere left to go, and a person who is already 120 has no month of plan left to simulate.
 * A benefit claiming age stops at 70 for neither reason — that is the top of the legal claiming
 * window, and past it the delayed-credit formula in `@finley/rules` has nothing further to
 * award, so a plan stating 80 would be paid as if it said 70 and never say so.
 *
 * Anything a person is projected to but not through — a job's start or end age — is bounded as
 * a lived age (119) by {@link MAX_LIVED_AGE}, since a job pays in months the person is alive
 * for.
 */
export const AGE_LIMITS = {
  currentAge: 119,
  retirementAge: MAX_AGE,
  lifeExpectancy: MAX_AGE,
  benefitClaimingAge: 70,
} as const satisfies Record<string, number>;

/**
 * The oldest age a person can already BE, as opposed to be projected to — one short of
 * {@link MAX_AGE}, so there is at least one month of life left to project.
 */
export const MAX_LIVED_AGE = AGE_LIMITS.currentAge;

/** The plan's age-valued scalars, named for the refusal message. */
const AGE_FIELDS = Object.keys(AGE_LIMITS) as readonly (keyof typeof AGE_LIMITS)[];

/**
 * The first age-valued field over its {@link AGE_LIMITS} ceiling, or `null` when every one is
 * within. Only an OVER-large age is a refusal here — what is too young, or out of order against
 * the other ages, is the surface's own question and not this bound's.
 */
export function ageAboveMaximum(
  plan: Pick<Plan, (typeof AGE_FIELDS)[number]>,
): { readonly field: string; readonly age: number; readonly limit: number } | null {
  for (const field of AGE_FIELDS) {
    const age = plan[field];
    const limit = AGE_LIMITS[field];
    if (age > limit) return { field, age, limit };
  }
  return null;
}

// ── Authoring transforms ──
//
// Pure list-in/list-out edits over the plan's goals, beside the type they edit, so the
// `Projection` API and the app's Goals panel apply the same rule rather than each holding
// its own copy. Priority is array position, so "reorder" is a real operation here and not
// a field write.

/** Every {@link GoalPlan} field except the stable `id`, which the plan owns: add mints a
 * fresh one, edit keeps the old. */
export type GoalPatch = Partial<Omit<GoalPlan, "id">>;

/**
 * The plan's standing **scalars** — every {@link Plan} field except the three collections.
 *
 * The exclusion is the point, not tidiness: each collection has operations that mint stable
 * ids and enforce rules (removing a goal is refused while an event still spends from its
 * fund account). A bare `Partial<Plan>` would let a caller drop every goal in a "scalar"
 * patch and walk straight past that guard.
 */
export type PlanPatch = Partial<Omit<Plan, "goals" | "jobs" | "budgetLines">>;

/**
 * Overwrite one goal's named fields, keeping its `id` — and thus its derived `fund-<id>`
 * fund account and its list position, so funding priority is untouched. The `id` is
 * stripped from the patch, so an edit can never re-point a goal at another's fund account.
 * A patch aimed at an id that is not a goal changes nothing.
 */
export function withGoalPatch(
  goals: readonly GoalPlan[],
  id: string,
  patch: GoalPatch,
): readonly GoalPlan[] {
  const { id: _drop, ...rest } = patch as Partial<GoalPlan>;
  return goals.map((g) => (g.id === id ? ({ ...g, ...rest } as GoalPlan) : g));
}

/**
 * Drop a goal. Its derived fund account falls away with it, which is why the callers that
 * can reach a ledger check {@link import("./goalFunding").validateGoalRemoval} first.
 */
export function withoutGoal(goals: readonly GoalPlan[], id: string): readonly GoalPlan[] {
  return goals.filter((g) => g.id !== id);
}

/**
 * Move a goal one slot earlier (`"up"`, funded sooner) or later (`"down"`). Priority IS the
 * index in {@link Plan.goals} and appending is the only way to author one, so this is the
 * sole reprioritization primitive. A no-op at the ends and for an unknown id.
 */
export function withGoalReordered(
  goals: readonly GoalPlan[],
  id: string,
  direction: "up" | "down",
): readonly GoalPlan[] {
  const index = goals.findIndex((g) => g.id === id);
  if (index === -1) return goals;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= goals.length) return goals;
  const next = [...goals];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Patch the plan's scalars, dropping the three collections at RUNTIME as well as in the
 * type: `@finley/engine` is published, and a JavaScript caller passing `{ goals: [] }`
 * would otherwise spread straight past the goal-removal guard. A type that is the only
 * guard is not a guard.
 */
export function withPlanPatch(plan: Plan, patch: PlanPatch): Plan {
  const { goals: _g, jobs: _j, budgetLines: _b, ...scalars } = patch as Partial<Plan>;
  const next = { ...plan, ...scalars };
  const bad = ageAboveMaximum(next);
  if (bad) throw new Error(`Projection: cannot set ${bad.field} to ${bad.age} — it may not exceed ${bad.limit}`);
  return next;
}
