/**
 * The `Projection` root — the headline public API of `@finley/engine` (§2, §18,
 * §20, "npm API surface" of JOBS_HOUSEHOLD_REDESIGN, issue #70, slice 7).
 *
 * One **unified `Projection` root**: both standing edits (`addJob`, `addBudgetLine`,
 * `setRetirementTarget`) and ledger transactions (`buyHome`, `marry`, `takeLoan`) are
 * methods on it. Internally they route to standing data (a {@link Plan}) vs the
 * {@link Ledger} per §18/§20 — but the caller sees **one object**. It is
 * "imperative-looking over an immutable core" (§2): each write derives a *new*
 * immutable {@link ProjectionState} and swaps it in, so no caller can observe a
 * half-applied write and any state already handed out stays intact.
 *
 * **Writes are not reversible by the root.** There is deliberately no undo stack: a
 * `Projection` holds the *current* state only. Reversal is addressable, not
 * positional — a future `removeTransaction(id)` / `removeJob(id)` names the thing to
 * drop (removal from a ledger *deletes the event*, per §6.1, cascading to dependents
 * and refusing when a survivor's preconditions would fail). A UI deleting row 3 of a
 * timeline must not have to know what order rows were created in, and cross-session
 * undo would require a persisted operation log — a different design, not a stack held
 * in memory. See issue #70's amended ACs.
 *
 * **Creating writes mint a deterministic sequence id and return it** (§ "npm API").
 * A single monotonic counter (`nextSeq`) lives in the state — `addJob` → `"job-1"`,
 * the next creating write → `"…-2"`, and so on. Because it is one counter across all
 * kinds, ids never collide. The counter is part of the serialized state
 * ({@link Projection.toJSON}), so a reloaded plan continues the sequence rather than
 * restarting at 1 and colliding with an existing id. A caller may override the minted
 * id with `{ id }` in the payload (round-trips, tests); an override does **not**
 * consume the counter.
 *
 * **`run(jurisdiction)` → immutable {@link ProjectionResult}.** The jurisdiction is
 * injected at `run()`, never at construction: `Projection` is pure, jurisdiction-free
 * authoring state, so one plan can be re-run under different rule sets without
 * mutation. (`ProjectionResult` is deliberately thin in this slice — the per-line
 * monthly resolution and the §5 solver outputs land in slice 8; the shape here is the
 * already-monthly {@link ProjectionSeries} plus the insolvency marker.)
 *
 * Packaging (§ "npm API", Q28): the root ships *inside* `@finley/engine` as the
 * headline surface; the existing functional barrel (`interpretLedger`,
 * `simulateHousehold`, …) stays exported as the low-level surface. The purity guard
 * is unchanged — swapping the internal state field is not I/O, and `Jurisdiction` is a
 * `run()` argument (the engine's own {@link nullJurisdiction} is used for the
 * write-time affordability gate), never a rules-package import.
 */

import type { Plan, GoalPlan } from "./plan";
import type { Job, PersonId } from "./job";
import type { BudgetLine } from "./budgetLine";
import type { Scenario } from "./scenario";
import { scenarioOf, withPlan, withLedger } from "./scenario";
import type { NewLifeEvent } from "./ledger/eventTypes";
import type { SimPerson } from "./projection/simulate";
import type { ProjectionSeries } from "./projection/simulate";
import type { LiabilityKind } from "./liability";
import type { GrowthMode } from "./cashFlowSeries";
import { addEvent } from "./ledger/addEvent";
import { projectScenario } from "./retirementSolver";
import { createProjectionBase, firstInsolventMonth } from "./projectionBase";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";

/**
 * The immutable authoring state a {@link Projection} holds — and the whole of what it
 * serializes. The {@link Scenario} carries the two homes writes route to (§18/§20):
 * standing data ({@link Plan}) and the {@link Ledger} of transactions. `nextSeq` is the
 * deterministic id counter
 * (§ "npm API") that **must** be serialized so a reload continues the sequence; and
 * `startYear` is the frozen "now" the compilation resolves against (an environment
 * input the engine cannot read from a wall clock).
 */
export interface ProjectionState {
  /**
   * The projectable unit (§6): the standing {@link Plan} coupled to the {@link Ledger}
   * of events replayed on top of it. Held as ONE {@link Scenario} rather than two
   * sibling fields precisely because that is the type's purpose — the engine projects a
   * scenario, never a bare plan, so a timeline cannot be silently dropped on its way to
   * {@link Projection.run}.
   */
  readonly scenario: Scenario;
  /** The frozen "now" — calendar year of month 0. */
  readonly startYear: number;
  /** Next deterministic sequence number a creating write will mint. Serialized (§ "npm API"). */
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
 * A `marry` payload: the incoming partner. `birthYear` is **required** — it is what
 * makes a benefit basis (§5.4) and the age-50 deferral catch-up (§11) computable, and
 * a spouse with no birth year is a data-entry gap rather than an intent (`SimPerson`
 * keeps it optional because *that* is the compiled shape, where absent legitimately
 * means "model no benefit"). `benefitClaimingAge` defaults to the jurisdiction's
 * full retirement age (US: 67) and `priorEarningsCents` to no record.
 */
export interface MarryInput {
  readonly month: number;
  readonly name: string;
  readonly birthYear: number;
  readonly benefitClaimingAge?: number;
  readonly priorEarningsCents?: Readonly<Record<number, number>>;
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
 * A `takeLoan` payload, discriminated on `kind`. `termMonths` and `creditLimitCents`
 * are not "optional" — they are kind-*determined*: a revolving card has a credit limit
 * and never amortizes; a term loan amortizes over a term and has no limit. Modelling
 * that as a union makes each field required exactly where it applies and
 * unrepresentable where it does not, so no caller has to invent a term for a card.
 */
export type TakeLoanInput =
  | (TakeLoanCommon & { readonly kind: "creditCard"; readonly creditLimitCents: number })
  | (TakeLoanCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termMonths: number;
    });

/** A `buyHome` payload. `appreciationMode` defaults to `inflationLinked` at base inflation (§4.1). */
export interface BuyHomeInput {
  readonly month: number;
  readonly ownerId: PersonId;
  readonly purchasePriceCents: number;
  readonly downPaymentCents: number;
  readonly downPaymentAccountId: string;
  readonly mortgageApr: number;
  readonly mortgageTermMonths: number;
  readonly appreciationMode?: GrowthMode;
  /** Override the minted property id (the mortgage liability id is derived from it). */
  readonly id?: string;
}

/**
 * The computed snapshot a {@link Projection.run} produces (§ "npm API", Q26). Pure
 * and **immutable** (frozen): the plan is authoring state, the result is one pipeline
 * pass under a specific jurisdiction. Deliberately thin in slice 7 — the §5 solver
 * outputs, on-track %, and per-line monthly resolution land in slice 8; today it
 * carries the already-monthly {@link ProjectionSeries} the chart reads plus the
 * first insolvent month (a convenience the app already derives).
 */
export interface ProjectionResult {
  /** The jurisdiction this snapshot was computed under — echoes {@link Jurisdiction.id}. */
  readonly jurisdictionId: string;
  /** The per-month accumulation table (net worth, per-account/liability balances, flows). */
  readonly series: ProjectionSeries;
  /** First month the §5.1 shortfall cascade exhausted all credit, or `null` if solvent throughout. */
  readonly firstInsolventMonth: number | null;
}

/** The initial standing numbers a fresh {@link Projection} is created from. */
export interface ProjectionInit {
  readonly plan: Plan;
  /** The frozen "now" — calendar year of month 0. */
  readonly startYear: number;
}

/**
 * Mint the next id for a creating write. A supplied override is returned verbatim and
 * does **not** advance the counter; otherwise `${kind}-${nextSeq}` is minted and the
 * counter steps by one. A single counter across all kinds guarantees no collision.
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
   * The current authoring state — the ONLY mutable field. Each write swaps in a fresh
   * immutable {@link ProjectionState} rather than mutating this one, so a state already
   * read out of {@link state} never changes underfoot (imperative-looking over an
   * immutable core, §2). No prior states are retained; writes are not reversible by the
   * root (see the module doc).
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

  /**
   * Commit a standing edit: swap the plan and carry the ledger through via
   * {@link withPlan}, so no standing write can drop the timeline (§6).
   */
  private commitPlan(plan: Plan, nextSeq?: number): void {
    const s = this.state;
    this.commit({
      ...s,
      scenario: withPlan(s.scenario, plan),
      ...(nextSeq !== undefined ? { nextSeq } : {}),
    });
  }

  // ─── Standing edits (§18) ─────────────────────────────────────────────────

  /**
   * Add a {@link Job} owned by `personId`. Mints and returns a `"job-N"` id (override
   * with `job.id`). The job appends to the plan's standing job list (§1).
   */
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

  /**
   * Add a {@link BudgetLine} to the standing line-item budget (§12). Mints and returns
   * a `"line-N"` id (override with `line.id`).
   */
  addBudgetLine(line: BudgetLineInput): string {
    const s = this.state;
    const { id, nextSeq } = mint(s, "line", line.id);
    const { id: _drop, ...rest } = line;
    const newLine: BudgetLine = { id, ...rest };
    const plan = s.scenario.plan;
    this.commitPlan({ ...plan, budgetLines: [...(plan.budgetLines ?? []), newLine] }, nextSeq);
    return id;
  }

  /**
   * Add a funding {@link GoalPlan} (appended = lowest priority, §14). Mints and returns
   * a `"goal-N"` id (override with `goal.id`).
   */
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
   * Set the retirement target age (§5) — the career-exit input. A standing *edit*, not
   * a creating write: it overwrites an existing value, so it mints no id.
   */
  setRetirementTarget(age: number): void {
    this.commitPlan({ ...this.state.scenario.plan, retirementAge: age });
  }

  // ─── Ledger transactions (§18) ────────────────────────────────────────────

  /**
   * Grow the ledger with a life event through the safe, base-aware {@link addEvent}
   * path (its own-field + precondition validation, incl. the §4.5 affordability gate,
   * evaluated under the engine's own {@link nullJurisdiction} — no rules import, purity
   * intact), and commit it as ONE new state carrying both the grown ledger and the
   * post-mint `nextSeq`. Throws the conflict on failure, leaving the current state
   * untouched (so a refused transaction consumes no id and cannot half-apply).
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
    // withLedger carries the plan through — the mirror of commitPlan (§6).
    this.commit({ ...s, scenario: withLedger(s.scenario, result.ledger), nextSeq });
  }

  /**
   * Marry a partner into the household (a {@link RelationshipEvent}). Mints and returns
   * the `"person-N"` id (override with `input.id`).
   */
  marry(input: MarryInput): string {
    const { id, nextSeq } = mint(this.state, "person", input.id);
    const person: SimPerson = {
      id,
      name: input.name,
      birthYear: input.birthYear,
      ...(input.benefitClaimingAge !== undefined
        ? { benefitClaimingAge: input.benefitClaimingAge }
        : {}),
      ...(input.priorEarningsCents !== undefined
        ? { priorEarningsCents: input.priorEarningsCents }
        : {}),
    };
    this.commitEvent({ id, type: "RelationshipEvent", month: input.month, person }, nextSeq);
    return id;
  }

  /**
   * Originate a liability (a {@link LoanEvent}). Mints and returns the `"loan-N"` id
   * (override with `input.id`).
   */
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
    // Built per arm rather than spread: `kind` and its companion field have to travel
    // together for the event union to accept them.
    this.commitEvent(
      input.kind === "creditCard"
        ? { ...common, kind: input.kind, creditLimitCents: input.creditLimitCents }
        : { ...common, kind: input.kind, termMonths: input.termMonths },
      nextSeq,
    );
    return id;
  }

  /**
   * Buy a home (a {@link HomePurchaseEvent}): mints the property id (override with
   * `input.id`) and derives the mortgage liability id from it (`mortgage-<propertyId>`).
   * Subject to the §4.5 down-payment hard block. Returns the property id.
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
        downPaymentAccountId: input.downPaymentAccountId,
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

  // ─── Run (§ "npm API", Q26) ────────────────────────────────────────────────

  /**
   * Compute the immutable {@link ProjectionResult} for the current authoring state
   * under `jurisdiction`. Pure and read-only: it never swaps the current state, so the
   * same `Projection` can be re-run under different jurisdictions without mutation.
   *
   * Delegates to {@link projectScenario} rather than restating its steps: that is the
   * one pipeline the net-worth chart and the §5 solver panel already share (#37), and a
   * second spelling of it here is how those three quietly stop agreeing.
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

  // ─── Serialization (§ "npm API": the id counter round-trips) ───────────────

  /**
   * The serializable current state — plan, ledger, `startYear`, and the `nextSeq`
   * counter. Serializing `nextSeq` is what lets a reloaded plan continue the sequence
   * and never collide with an existing id. This is the whole of a `Projection` — it
   * retains no prior states — so a round-trip loses nothing.
   */
  toJSON(): ProjectionState {
    return this.state;
  }

  /** Reconstruct a projection from a {@link toJSON} snapshot. */
  static fromJSON(state: ProjectionState): Projection {
    return new Projection(state);
  }
}
