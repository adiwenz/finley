/**
 * A household's standing figures, as opposed to timeline events. `createProjectionBase`
 * maps a `Plan` plus a `ProjectionContext` into the ledger base the simulator runs.
 */

import type { GoalDisposal } from "../goal/goal";
import type { SharedContributionScheme } from "../projection/waterfall";
import type { BudgetLine } from "../budget/budgetLine";
import type { Person } from "./person";
import { withBirthYear } from "./person";

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
 * {@link import("../projection/waterfall").SurplusDestination} (`idle` / `swept`), keeping
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
  readonly openingBalanceCents: number;
  /**
   * The retirement and brokerage standing accounts' starting balances — money already
   * saved there before month 0, as opposed to what a job's deferral or the waterfall
   * contributes going forward. Optional and default to zero (their prior, sole behavior):
   * a fresh plan's saver hasn't necessarily put anything by yet, unlike cash, which always
   * carries an opening figure because a household's day-one buffer is never assumed empty.
   */
  readonly retirementOpeningBalanceCents?: number;
  readonly brokerageOpeningBalanceCents?: number;
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
  /**
   * A DECIMAL rate (e.g. `0.02`), unlike the whole-percent fields above. Unset couples the
   * benefit COLA to {@link inflationPct}.
   */
  readonly benefitColaRate?: number;
  /**
   * The primary household member — their name, birth year, life expectancy, claiming age, jobs
   * and continuation job all live here, on a real standing {@link Person}, the same shape a
   * partner's is on the `RelationshipEvent` that brought them in. `id` is always
   * {@link import("../compile/projectionBase").PRIMARY_PERSON_ID}.
   *
   * `birthYear` is frozen at authoring time — not re-derived from a wall clock or from
   * `ProjectionContext.startYear` on every compile — the same way a partner's is set once at
   * `marry` and never revisited. Re-projecting the same plan against a later "now" ages the
   * primary the way it already ages a partner: not at all, on the engine's own account.
   */
  readonly primary: Person;
  /**
   * The sole expense authoring surface, and REQUIRED: a plan always states its spend, even if
   * that statement is "nothing". `createProjectionBase` compiles the *expense* lines into the
   * household's general-expense series; contribution lines resolve via
   * {@link import("../budget/budgetLine").resolveBudget}. An empty array is the deliberate no-spending
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
 * expectancy is an age a person is projected TO, so it reaches the ceiling itself. An age a
 * person already IS stops one year below it (119): the projection has to have
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
  lifeExpectancy: MAX_AGE,
  benefitClaimingAge: 70,
} as const satisfies Record<string, number>;

/**
 * The oldest age a person can already BE, as opposed to be projected to — one short of
 * {@link MAX_AGE}, so there is at least one month of life left to project.
 */
export const MAX_LIVED_AGE = 119;

/**
 * **The lowest life expectancy a person of `currentAge` may be given** — one past the age they
 * already are, because an expectancy AT it is the month-0 death {@link invalidAge} refuses.
 *
 * A floor that depends on the person, which is why it is a function and not another entry in
 * {@link AGE_LIMITS}: a 40-year-old may be projected to 41 and a 76-year-old may not. Exported
 * because the authoring FORMS need it — a field bounded any higher silently rewrites a number
 * the user typed, and one bounded lower commits a value the very next write rejects. Both were
 * live: three fields carried a `Math.max(60, …)` floor, so a 40-year-old partner's expectancy
 * snapped to 60, an age nobody entered and the engine never asked for.
 *
 * Read by {@link invalidAge} itself, so the bound a form draws and the bound a write enforces
 * are one number.
 */
export function minLifeExpectancyFor(currentAge: number): number {
  return currentAge + 1;
}

/**
 * How many months this plan spans: "now" to life expectancy. The projection simulates exactly
 * this many months, so it is also how long every surface drawing the plan reaches — the net-worth
 * charts' x-axis, the timeline, the event year picker.
 *
 * Lives here rather than in each caller because it is a fact ABOUT THE PLAN, not a presentation
 * choice, and a second definition of it can disagree with the one the simulator ran. That matters
 * most where the two are read together: a chart axis derived from its own arithmetic and a series
 * truncated by the engine would drift silently, and the chart would be the last place anyone
 * looked. Clamped at 0 for a life expectancy at or below the current age — a plan with no months
 * left to simulate, which the engine refuses upstream but which no arithmetic here should invent.
 *
 * "Current age" is read off the primary's frozen `birthYear` against `startYear` — the calendar
 * "now" the caller is projecting from, never a wall clock — so the same plan re-projected at a
 * later `startYear` reaches a shorter horizon rather than a stale one.
 */
export function planHorizonMonths(
  plan: Pick<Plan, "primary">,
  startYear: number,
): number {
  const currentAge = startYear - plan.primary.birthYear;
  return Math.max(0, plan.primary.lifeExpectancy - currentAge) * 12;
}

/** The first age-valued field the engine will not accept, and what is wrong with it. */
export interface InvalidAge {
  readonly field: string;
  readonly age: number;
  /**
   * The complaint, phrased to complete "`<field> <age>` …" — `"may not exceed 120"`,
   * `"must be past the age they already are (40)"`. A sentence fragment rather than a `limit`
   * number, because the reasons are no longer all the same shape: one bound is a ceiling the
   * engine imposes, the other is a floor the person's own birth year sets.
   */
  readonly problem: string;
}

/**
 * The first age-valued field the engine will not accept, or `null` when every one is fine —
 * checked against `startYear`, the calendar "now" `birthYear` is read relative to.
 *
 * Two bounds, and they are different in kind:
 *
 *  - **A ceiling**, from {@link AGE_LIMITS}: a horizon nobody can afford to simulate, a claiming
 *    age past the top of the legal window.
 *  - **A floor on the life expectancy alone**: it must be past the age the person already is.
 *    An expectancy at or below their current age says they are already dead, which closes their
 *    {@link import("../job/personActiveWindow").PersonActiveWindow} at month 0 — every job of
 *    theirs ends before it starts, no benefit is ever paid, and a plan whose only member is that
 *    person projects zero months. That is a well-defined answer and a useless one, and it arrives
 *    from a slider the user can drag rather than from anything exotic. Refused at the door
 *    instead, where the number they typed is still in front of them.
 *
 * What is out of ORDER against the other ages — an expectancy below a claiming age, a job ending
 * after one — is the surface's own question and not this bound's.
 *
 * Shared by the primary (at plan-open and on every `updatePlan`) and a partner (at `marry`) —
 * the same bounds apply to either, since both are a {@link Person}. Restoration deliberately
 * does NOT run this: a file that arrives already stating one is better opened and clamped than
 * refused with nothing the user can fix it in.
 */
export function invalidAge(
  person: Pick<Person, "birthYear" | "lifeExpectancy"> & { readonly benefitClaimingAge?: number },
  startYear: number,
): InvalidAge | null {
  const currentAge = startYear - person.birthYear;
  const notOver = (limit: number) => `may not exceed ${limit}`;
  if (currentAge > MAX_LIVED_AGE) {
    return { field: "age", age: currentAge, problem: notOver(MAX_LIVED_AGE) };
  }
  const checks: readonly (readonly [string, number | undefined, number])[] = [
    ["lifeExpectancy", person.lifeExpectancy, AGE_LIMITS.lifeExpectancy],
    ["benefitClaimingAge", person.benefitClaimingAge, AGE_LIMITS.benefitClaimingAge],
  ];
  for (const [field, age, limit] of checks) {
    if (age !== undefined && age > limit) return { field, age, problem: notOver(limit) };
  }
  // At, not merely below: an expectancy equal to the current age is the month-0 death, and a
  // projection with no months in it is not a plan.
  if (person.lifeExpectancy < minLifeExpectancyFor(currentAge)) {
    return {
      field: "lifeExpectancy",
      age: person.lifeExpectancy,
      problem: `must be past the age they already are (${currentAge})`,
    };
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
 * The primary's own scalars a plan patch may reach — name, birth year, life expectancy, claiming
 * age. Not `jobs` or `continuationJobId`: those are not scalars but an id-bearing collection and
 * a job id, each with its own mint/validate path (`addJob`, `setContinuationJob`), the same
 * reason `goals`/`budgetLines` are excluded below.
 */
type PrimaryPatchKeys = "name" | "birthYear" | "lifeExpectancy" | "benefitClaimingAge";

/**
 * The plan's standing **scalars** — every {@link Plan} field except the two collections, plus
 * the primary's own patchable scalars (see {@link PrimaryPatchKeys}) flattened in, so a caller
 * still writes `{ lifeExpectancy: 90 }` rather than reaching through `{ primary: { ... } }`.
 *
 * The collection exclusion is the point, not tidiness: `goals`/`budgetLines` have operations
 * that mint stable ids and enforce rules (removing a goal is refused while an event still spends
 * from its fund account). A bare `Partial<Plan>` would let a caller drop every goal in a
 * "scalar" patch and walk straight past that guard.
 */
export type PlanPatch = Partial<Omit<Plan, "goals" | "budgetLines" | "primary">> &
  Partial<Pick<Person, PrimaryPatchKeys>>;

/** {@link PlanPatch}'s primary-scoped keys, named once so `withPlanPatch` can split on them. */
const PRIMARY_PATCH_KEYS: readonly PrimaryPatchKeys[] = [
  "name",
  "birthYear",
  "lifeExpectancy",
  "benefitClaimingAge",
];

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
 * can reach a ledger check {@link import("../goal/goalFunding").validateGoalRemoval} first.
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
 * Patch the plan's scalars, dropping the two collections at RUNTIME as well as in the
 * type: `@finley/engine` is published, and a JavaScript caller passing `{ goals: [] }`
 * would otherwise spread straight past the goal-removal guard. A type that is the only
 * guard is not a guard.
 *
 * `startYear` is the calendar "now" a primary-scalar edit is validated against — the same bound
 * {@link invalidAge} applies to a partner at `marry`.
 */
export function withPlanPatch(plan: Plan, patch: PlanPatch, startYear: number): Plan {
  const { goals: _g, budgetLines: _b, ...rest } = patch as Partial<Plan> & Partial<Plan["primary"]>;
  const primaryPatch: Partial<Pick<Person, PrimaryPatchKeys>> = {};
  const scalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if ((PRIMARY_PATCH_KEYS as readonly string[]).includes(key)) {
      // Every primary scalar is REQUIRED on the Person, so an explicit `undefined` is a clear,
      // not a write — and spreading it would erase a field the type says is always there
      // (`lifeExpectancy` above all, which the horizon is computed from). Skipped for the same
      // reason the collections are dropped at runtime: a type that is the only guard is not a guard.
      if (value !== undefined) (primaryPatch as Record<string, unknown>)[key] = value;
    } else {
      // A plan scalar may be genuinely optional (`surplusCashTo`, `benefitColaRate`), so an
      // `undefined` here is left alone — unsetting one is a real edit.
      scalars[key] = value;
    }
  }
  // `birthYear` is applied through {@link withBirthYear} rather than spread with its siblings: it
  // is the origin the primary's job ages are read against, so moving it moves their whole working
  // life with them rather than restating ages nobody edited. The rest spread over the result, so
  // a patch moving the birth year AND the expectancy in one write still ends up with both.
  const { birthYear, ...otherPrimaryPatch } = primaryPatch;
  const rebased = birthYear === undefined ? plan.primary : withBirthYear(plan.primary, birthYear);
  const primary = { ...rebased, ...otherPrimaryPatch };
  const bad = invalidAge(primary, startYear);
  if (bad) throw new Error(`Projection: cannot set ${bad.field} to ${bad.age} — it ${bad.problem}`);
  return { ...plan, ...scalars, primary };
}
