/**
 * The `Projection` root — the high-level public API of `@finley/engine`; the functional
 * barrel (`interpretLedger`, `simulateHousehold`, …) remains the low-level surface.
 *
 * Standing edits (`addJob`) route to a {@link Plan}, ledger transactions (`buyHome`) to the
 * {@link Ledger}. Each write derives a new {@link ProjectionState}, so state already handed
 * out stays intact.
 *
 * No undo stack. Reversal is addressable, not positional: a future `removeTransaction(id)`
 * names the event to drop, because a UI deleting row 3 does not know creation order.
 *
 * The jurisdiction is injected at `run()`, never at construction, so one plan re-runs under
 * different rule sets. `Projection` therefore imports no rules package; the write-time
 * affordability gate uses {@link nullJurisdiction}.
 */

import type { Plan, GoalPlan } from "./plan";
import type { Job, PersonId } from "./job";
import type { BudgetLine } from "./budgetLine";
import type { Scenario } from "./scenario";
import { scenarioOf, withPlan, withLedger } from "./scenario";
import type { NewLifeEvent } from "./ledger/eventTypes";
import type { Person } from "./person";
import type { ProjectionSeries } from "./projection/simulate";
import type { LiabilityKind } from "./liability";
import type { GrowthMode } from "./cashFlowSeries";
import { addEvent } from "./ledger/addEvent";
import { validateGoalRemoval } from "./goalFunding";
import { projectScenario } from "./retirementSolver";
import { createProjectionBase, firstInsolventMonth } from "./projectionBase";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";

/** The immutable authoring state a {@link Projection} holds, and the whole of what it serializes. */
export interface ProjectionState {
  /**
   * Plan plus the {@link Ledger} replayed on top of it. One field rather than two siblings,
   * so a timeline cannot be silently dropped on its way to {@link Projection.run}.
   */
  readonly scenario: Scenario;
  /** The frozen "now" — calendar year of month 0. An input, never a wall-clock read. */
  readonly startYear: number;
  readonly nextSeq: number;
}

export type JobInput = Omit<Job, "id" | "ownerId"> & { readonly id?: string };

export type BudgetLineInput = Omit<BudgetLine, "id"> & { readonly id?: string };

export type GoalInput = Omit<GoalPlan, "id"> & { readonly id?: string };

/**
 * The incoming partner. `birthYear` is REQUIRED: it makes a benefit basis and the age-50
 * catch-up computable. `retirementTargetAge` defaults to 65, `benefitClaimingAge` to 67.
 * Covered earnings derive from `jobs`, so the empty default models no benefit basis.
 */
export interface MarryInput {
  readonly month: number;
  readonly name: string;
  readonly birthYear: number;
  readonly retirementTargetAge?: number;
  readonly benefitClaimingAge?: number;
  readonly jobs?: readonly Job[];
  /** Override the minted person id. */
  readonly id?: string;
}

interface TakeLoanCommon {
  readonly month: number;
  readonly ownerId: PersonId;
  readonly openingBalanceCents: number;
  readonly apr: number;
  /** Override the minted liability id. */
  readonly id?: string;
}

/**
 * Discriminated on `kind`: a revolving card has a limit and never amortizes, a term loan
 * amortizes and has no limit.
 */
export type TakeLoanInput =
  | (TakeLoanCommon & { readonly kind: "creditCard"; readonly creditLimitCents: number })
  | (TakeLoanCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termMonths: number;
    });

/** `appreciationMode` defaults to `inflationLinked` at base inflation. */
export interface BuyHomeInput {
  readonly month: number;
  readonly ownerId: PersonId;
  readonly purchasePriceCents: number;
  readonly downPaymentCents: number;
  /** Liquid funding accounts drained for the down payment, in order. */
  readonly downPaymentSourceIds: readonly string[];
  readonly mortgageApr: number;
  readonly mortgageTermMonths: number;
  readonly appreciationMode?: GrowthMode;
  /** Override the minted property id. */
  readonly id?: string;
}

/** One pipeline pass under a specific jurisdiction, frozen. */
export interface ProjectionResult {
  readonly jurisdictionId: string;
  readonly series: ProjectionSeries;
  /** First month the shortfall cascade exhausted all credit, or `null` if solvent throughout. */
  readonly firstInsolventMonth: number | null;
}

export interface ProjectionInit {
  readonly plan: Plan;
  /** The frozen "now" — calendar year of month 0. */
  readonly startYear: number;
}

/**
 * An override is returned verbatim and does NOT advance the counter. One counter across all
 * kinds, so ids cannot collide.
 */
function mint(
  state: ProjectionState,
  kind: string,
  override: string | undefined,
): { id: string; nextSeq: number } {
  if (override != null) return { id: override, nextSeq: state.nextSeq };
  return { id: `${kind}-${state.nextSeq}`, nextSeq: state.nextSeq + 1 };
}

export class Projection {
  /** The only mutable field; writes swap in a fresh state rather than mutating it. */
  private current: ProjectionState;

  private constructor(state: ProjectionState) {
    this.current = state;
  }

  static create(init: ProjectionInit): Projection {
    return new Projection({
      scenario: scenarioOf(init.plan),
      startYear: init.startYear,
      nextSeq: 1,
    });
  }

  get state(): ProjectionState {
    return this.current;
  }

  get plan(): Plan {
    return this.current.scenario.plan;
  }

  /** The single write primitive every method routes through. */
  private commit(next: ProjectionState): void {
    this.current = next;
  }

  /** Swap the plan, carrying the ledger through, so no standing write drops the timeline. */
  private commitPlan(plan: Plan, nextSeq?: number): void {
    const s = this.state;
    this.commit({
      ...s,
      scenario: withPlan(s.scenario, plan),
      ...(nextSeq !== undefined ? { nextSeq } : {}),
    });
  }

  // Standing edits

  /** Returns the minted `"job-N"` id. */
  addJob(personId: PersonId, job: JobInput): string {
    const s = this.state;
    const { id, nextSeq } = mint(s, "job", job.id);
    const newJob: Job = {
      id,
      ownerId: personId,
      startYear: job.startYear,
      endYear: job.endYear,
      salary: job.salary,
      ...(job.deferral !== undefined ? { deferral: job.deferral } : {}),
    };
    this.commitPlan({ ...s.scenario.plan, jobs: [...(s.scenario.plan.jobs ?? []), newJob] }, nextSeq);
    return id;
  }

  /** Returns the minted `"line-N"` id. */
  addBudgetLine(line: BudgetLineInput): string {
    const s = this.state;
    const { id, nextSeq } = mint(s, "line", line.id);
    const { id: _drop, ...rest } = line;
    const newLine: BudgetLine = { id, ...rest };
    const plan = s.scenario.plan;
    this.commitPlan({ ...plan, budgetLines: [...plan.budgetLines, newLine] }, nextSeq);
    return id;
  }

  /** Appended, so lowest funding priority. Returns the minted `"goal-N"` id. */
  addGoal(goal: GoalInput): string {
    const s = this.state;
    const { id, nextSeq } = mint(s, "goal", goal.id);
    const { id: _drop, ...rest } = goal;
    const newGoal = { id, ...rest } as GoalPlan;
    const plan = s.scenario.plan;
    this.commitPlan({ ...plan, goals: [...plan.goals, newGoal] }, nextSeq);
    return id;
  }

  /**
   * Replace one goal's authorable fields, keeping its `id` — and thus its `goal-<id>` fund
   * account and its list position, so funding priority is untouched. A patch, not a whole
   * draft: the caller names only what changes. Editing cannot dangle a funding reference (the
   * account id is stable), so unlike {@link removeGoal} it needs no guard. A patch aimed at an
   * id that is not a goal is a no-op plan swap.
   */
  updateGoal(id: string, patch: Partial<GoalInput>): void {
    const plan = this.state.scenario.plan;
    const { id: _drop, ...rest } = patch;
    const goals = plan.goals.map((g) => (g.id === id ? ({ ...g, ...rest } as GoalPlan) : g));
    this.commitPlan({ ...plan, goals });
  }

  /**
   * Drop a goal and, with it, the derived fund account that is its balance. REFUSED while
   * any event still spends from that account: the account would vanish out from under a
   * reference the ledger keeps, so the removal is a no-op and this throws with the state
   * untouched — the same contract {@link commitEvent} gives a refused transaction.
   *
   * Removing a goal that no event funds, or an id that is not a goal, is a plain no-op-safe
   * plan swap. Callers wanting to ask before acting call {@link validateGoalRemoval}.
   */
  removeGoal(id: string): void {
    const plan = this.state.scenario.plan;
    const check = validateGoalRemoval(plan.goals, id, this.state.scenario.ledger);
    if (!check.ok) {
      throw new Error(`Projection: cannot remove goal — ${check.reason}`);
    }
    this.commitPlan({ ...plan, goals: plan.goals.filter((g) => g.id !== id) });
  }

  /**
   * Move a goal one slot earlier (`"up"`, funded sooner) or later (`"down"`) in the funding
   * order. Priority is the goal's index in {@link Plan.goals}, and {@link addGoal} only
   * appends, so this is the sole way an API caller reprioritizes a goal after authoring it. A
   * no-op at the ends and for an id that is not a goal.
   */
  reorderGoal(id: string, direction: "up" | "down"): void {
    const plan = this.state.scenario.plan;
    const index = plan.goals.findIndex((g) => g.id === id);
    if (index === -1) return;
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= plan.goals.length) return;
    const goals = [...plan.goals];
    [goals[index], goals[target]] = [goals[target], goals[index]];
    this.commitPlan({ ...plan, goals });
  }

  setRetirementTarget(age: number): void {
    this.commitPlan({ ...this.state.scenario.plan, retirementAge: age });
  }

  // Ledger transactions

  /**
   * Validates through {@link addEvent} — including the affordability gate, run under
   * {@link nullJurisdiction} to keep purity — and commits ledger and post-mint `nextSeq` as
   * ONE new state. On failure it throws with the state untouched, so a refused transaction
   * consumes no id.
   */
  private commitEvent(event: NewLifeEvent, nextSeq: number): void {
    const s = this.state;
    const base = createProjectionBase(s.scenario.plan, {
      jurisdiction: nullJurisdiction,
      startYear: s.startYear,
    });
    const result = addEvent(s.scenario.ledger, base, event, nullJurisdiction);
    if (!result.ok) {
      throw new Error(`Projection: cannot apply transaction — ${result.conflict}`);
    }
    this.commit({ ...s, scenario: withLedger(s.scenario, result.ledger), nextSeq });
  }

  /** Returns the minted `"person-N"` id. */
  marry(input: MarryInput): string {
    const { id, nextSeq } = mint(this.state, "person", input.id);
    const person: Person = {
      id,
      name: input.name,
      birthYear: input.birthYear,
      retirementTargetAge: input.retirementTargetAge ?? 65,
      benefitClaimingAge: input.benefitClaimingAge ?? 67,
      jobs: input.jobs ?? [],
    };
    this.commitEvent({ id, type: "RelationshipEvent", month: input.month, person }, nextSeq);
    return id;
  }

  /** Returns the minted `"loan-N"` id. */
  takeLoan(input: TakeLoanInput): string {
    const { id, nextSeq } = mint(this.state, "loan", input.id);
    const common = {
      id,
      type: "LoanEvent",
      month: input.month,
      liabilityId: id,
      ownerId: input.ownerId,
      openingBalanceCents: input.openingBalanceCents,
      apr: input.apr,
    } as const;
    // Built per arm, not spread: the event union only accepts `kind` and its companion
    // field together.
    this.commitEvent(
      input.kind === "creditCard"
        ? { ...common, kind: input.kind, creditLimitCents: input.creditLimitCents }
        : { ...common, kind: input.kind, termMonths: input.termMonths },
      nextSeq,
    );
    return id;
  }

  /**
   * The mortgage liability id derives from the minted property id
   * (`mortgage-<propertyId>`). Subject to the down-payment hard block.
   */
  buyHome(input: BuyHomeInput): string {
    const { id, nextSeq } = mint(this.state, "home", input.id);
    this.commitEvent(
      {
        id,
        type: "HomePurchaseEvent",
        month: input.month,
        propertyId: id,
        ownerId: input.ownerId,
        purchasePriceCents: input.purchasePriceCents,
        downPaymentCents: input.downPaymentCents,
        downPaymentSourceIds: input.downPaymentSourceIds,
        mortgageLiabilityId: `mortgage-${id}`,
        mortgageApr: input.mortgageApr,
        mortgageTermMonths: input.mortgageTermMonths,
        ...(input.appreciationMode !== undefined
          ? { appreciationMode: input.appreciationMode }
          : {}),
      },
      nextSeq,
    );
    return id;
  }

  // Run

  /**
   * Read-only — never swaps the current state. Delegates to {@link projectScenario}, the
   * pipeline the chart and solver panel already share.
   */
  run(jurisdiction: Jurisdiction): ProjectionResult {
    const s = this.state;
    const series = projectScenario(s.scenario, { jurisdiction, startYear: s.startYear });
    return Object.freeze({
      jurisdictionId: jurisdiction.id,
      series,
      firstInsolventMonth: firstInsolventMonth(series),
    });
  }

  // Serialization

  /**
   * Serializing `nextSeq` is what lets a reloaded plan continue the sequence instead of
   * colliding with an existing id.
   */
  toJSON(): ProjectionState {
    return this.state;
  }

  static fromJSON(state: ProjectionState): Projection {
    return new Projection(state);
  }
}
