/**
 * The `Projection` root — the headline public API of `@finley/engine`, with the
 * functional barrel (`interpretLedger`, `simulateHousehold`, …) remaining as the
 * low-level surface.
 *
 * Standing edits (`addJob`, `setRetirementTarget`) and ledger transactions (`buyHome`,
 * `marry`) are both methods here; internally they route to a {@link Plan} vs the {@link
 * Ledger}, but the caller sees ONE object. Imperative-looking over an immutable core:
 * each write derives a new {@link ProjectionState} and swaps it in, so no caller observes
 * a half-applied write and state already handed out stays intact.
 *
 * **Writes are not reversible by the root** — deliberately no undo stack, only the
 * current state. Reversal is addressable, not positional: a future `removeTransaction(id)`
 * names the thing to drop (deleting the event, cascading to dependents, refusing when a
 * survivor's preconditions would fail). A UI deleting row 3 must not need to know
 * creation order, and cross-session undo would need a persisted operation log.
 *
 * **Creating writes mint a deterministic id and return it** from one monotonic `nextSeq`
 * counter shared across all kinds, so ids never collide. It is serialized ({@link
 * Projection.toJSON}) so a reloaded plan continues the sequence instead of restarting at
 * 1. A caller may override with `{ id }` in the payload; an override does not consume the
 * counter.
 *
 * The jurisdiction is injected at `run()`, never at construction — `Projection` is pure,
 * jurisdiction-free authoring state, so one plan re-runs under different rule sets without
 * mutation. Purity holds: swapping the state field is not I/O, and `Jurisdiction` is a
 * `run()` argument (the write-time affordability gate uses the engine's own {@link
 * nullJurisdiction}), never a rules-package import.
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
import { projectScenario } from "./retirementSolver";
import { createProjectionBase, firstInsolventMonth } from "./projectionBase";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";

/**
 * The immutable authoring state a {@link Projection} holds, and the whole of what it
 * serializes. `startYear` is the frozen "now" compilation resolves against — an
 * environment input the engine cannot read from a wall clock.
 */
export interface ProjectionState {
  /**
   * The projectable unit: the standing {@link Plan} coupled to the {@link Ledger} replayed
   * on top of it. One {@link Scenario} rather than two sibling fields, so a timeline
   * cannot be silently dropped on its way to {@link Projection.run}.
   */
  readonly scenario: Scenario;
  /** The frozen "now" — calendar year of month 0. */
  readonly startYear: number;
  /** Next sequence number a creating write will mint. Serialized. */
  readonly nextSeq: number;
}

/** A {@link Job} payload for {@link Projection.addJob}: the owner is supplied as the
 * `personId` argument, the id is minted (override with `{ id }`). */
export type JobInput = Omit<Job, "id" | "ownerId"> & { readonly id?: string };

/** A {@link BudgetLine} payload for {@link Projection.addBudgetLine}: id minted (override with `{ id }`). */
export type BudgetLineInput = Omit<BudgetLine, "id"> & { readonly id?: string };

/** A {@link GoalPlan} payload for {@link Projection.addGoal}: id minted (override with `{ id }`). */
export type GoalInput = Omit<GoalPlan, "id"> & { readonly id?: string };

/**
 * The incoming partner, authored as a {@link Person}. `birthYear` is REQUIRED: it is what
 * makes a benefit basis and the age-50 catch-up computable, and a spouse without one is a
 * data-entry gap, not an intent. `retirementTargetAge` defaults to 65,
 * `benefitClaimingAge` to 67. Their covered-earnings record derives from `jobs` at the sim
 * boundary, so the empty default models no benefit basis of their own.
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

/** The fields every `takeLoan` payload carries, whatever the liability's kind. */
interface TakeLoanCommon {
  readonly month: number;
  readonly ownerId: PersonId;
  readonly openingBalanceCents: number;
  readonly apr: number;
  /** Override the minted liability id. */
  readonly id?: string;
}

/**
 * Discriminated on `kind`. `termMonths` and `creditLimitCents` are not optional but
 * kind-*determined*: a revolving card has a limit and never amortizes, a term loan
 * amortizes and has no limit. The union makes each required exactly where it applies and
 * unrepresentable where it does not, so no caller invents a term for a card.
 */
export type TakeLoanInput =
  | (TakeLoanCommon & { readonly kind: "creditCard"; readonly creditLimitCents: number })
  | (TakeLoanCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termMonths: number;
    });

/** A `buyHome` payload. `appreciationMode` defaults to `inflationLinked` at base inflation. */
export interface BuyHomeInput {
  readonly month: number;
  readonly ownerId: PersonId;
  readonly purchasePriceCents: number;
  readonly downPaymentCents: number;
  /** The liquid funding accounts drained for the down payment, in order. */
  readonly downPaymentSourceIds: readonly string[];
  readonly mortgageApr: number;
  readonly mortgageTermMonths: number;
  readonly appreciationMode?: GrowthMode;
  /** Override the minted property id (the mortgage liability id is derived from it). */
  readonly id?: string;
}

/**
 * What {@link Projection.run} produces: one pipeline pass under a specific jurisdiction,
 * frozen. Carries the monthly {@link ProjectionSeries} the chart reads plus the first
 * insolvent month. Solver outputs / on-track % stay deferred.
 */
export interface ProjectionResult {
  /** The jurisdiction this snapshot was computed under — echoes {@link Jurisdiction.id}. */
  readonly jurisdictionId: string;
  /** The per-month accumulation table (net worth, per-account/liability balances, flows). */
  readonly series: ProjectionSeries;
  /** First month the shortfall cascade exhausted all credit, or `null` if solvent throughout. */
  readonly firstInsolventMonth: number | null;
}

/** The initial standing numbers a fresh {@link Projection} is created from. */
export interface ProjectionInit {
  readonly plan: Plan;
  /** The frozen "now" — calendar year of month 0. */
  readonly startYear: number;
}

/**
 * Mint `${kind}-${nextSeq}` and step the counter. An override is returned verbatim and
 * does NOT advance it. One counter across all kinds guarantees no collision.
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
  /**
   * The ONLY mutable field. Each write swaps in a fresh {@link ProjectionState} rather than
   * mutating this one, so a state already read out of {@link state} never changes
   * underfoot. No prior states are retained.
   */
  private current: ProjectionState;

  /** Construct from an explicit state (used by {@link fromJSON}); prefer {@link create}. */
  private constructor(state: ProjectionState) {
    this.current = state;
  }

  /** A fresh projection from standing numbers: empty ledger, sequence starting at 1. */
  static create(init: ProjectionInit): Projection {
    return new Projection({
      scenario: scenarioOf(init.plan),
      startYear: init.startYear,
      nextSeq: 1,
    });
  }

  /** The current authoring state. */
  get state(): ProjectionState {
    return this.current;
  }

  /** The current standing plan — shorthand for `state.scenario.plan`. */
  get plan(): Plan {
    return this.current.scenario.plan;
  }

  /** Swap in a derived state — the single write primitive every method routes through. */
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

  /** Append a {@link Job} owned by `personId`. Returns a minted `"job-N"` id. */
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

  /** Add a {@link BudgetLine} to the standing budget. Returns a minted `"line-N"` id. */
  addBudgetLine(line: BudgetLineInput): string {
    const s = this.state;
    const { id, nextSeq } = mint(s, "line", line.id);
    const { id: _drop, ...rest } = line;
    const newLine: BudgetLine = { id, ...rest };
    const plan = s.scenario.plan;
    this.commitPlan({ ...plan, budgetLines: [...(plan.budgetLines ?? []), newLine] }, nextSeq);
    return id;
  }

  /** Add a funding {@link GoalPlan} — appended, so lowest priority. Returns a `"goal-N"` id. */
  addGoal(goal: GoalInput): string {
    const s = this.state;
    const { id, nextSeq } = mint(s, "goal", goal.id);
    const { id: _drop, ...rest } = goal;
    const newGoal = { id, ...rest } as GoalPlan;
    const plan = s.scenario.plan;
    this.commitPlan({ ...plan, goals: [...plan.goals, newGoal] }, nextSeq);
    return id;
  }

  /** The career-exit input. An edit, not a creating write, so it mints no id. */
  setRetirementTarget(age: number): void {
    this.commitPlan({ ...this.state.scenario.plan, retirementAge: age });
  }

  // Ledger transactions

  /**
   * Grow the ledger through the base-aware {@link addEvent} path — field and precondition
   * validation, including the affordability gate under {@link nullJurisdiction} to keep
   * purity — and commit ledger and post-mint `nextSeq` as ONE new state. Throws the
   * conflict on failure with the current state untouched, so a refused transaction
   * consumes no id and cannot half-apply.
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
    // The mirror of commitPlan: carry the plan through.
    this.commit({ ...s, scenario: withLedger(s.scenario, result.ledger), nextSeq });
  }

  /** Marry a partner in (a {@link RelationshipEvent}). Returns the minted `"person-N"` id. */
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

  /** Originate a liability (a {@link LoanEvent}). Returns the minted `"loan-N"` id. */
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
    // Built per arm, not spread: `kind` and its companion field must travel together for
    // the event union to accept them.
    this.commitEvent(
      input.kind === "creditCard"
        ? { ...common, kind: input.kind, creditLimitCents: input.creditLimitCents }
        : { ...common, kind: input.kind, termMonths: input.termMonths },
      nextSeq,
    );
    return id;
  }

  /**
   * Buy a home (a {@link HomePurchaseEvent}). Derives the mortgage liability id from the
   * minted property id (`mortgage-<propertyId>`). Subject to the down-payment hard block.
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
   * Compute the {@link ProjectionResult} under `jurisdiction`. Read-only — it never swaps
   * the current state, so one `Projection` re-runs under different jurisdictions.
   *
   * Delegates to {@link projectScenario} rather than restating its steps: that is the
   * pipeline the net-worth chart and solver panel already share, and a second spelling
   * here is how the three quietly stop agreeing.
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

  // Serialization (the id counter round-trips)

  /**
   * Plan, ledger, `startYear`, and `nextSeq` — the whole of a `Projection`, since it
   * retains no prior states, so a round-trip loses nothing. Serializing `nextSeq` is what
   * lets a reloaded plan continue the sequence instead of colliding with an existing id.
   */
  toJSON(): ProjectionState {
    return this.state;
  }

  /** Reconstruct a projection from a {@link toJSON} snapshot. */
  static fromJSON(state: ProjectionState): Projection {
    return new Projection(state);
  }
}
