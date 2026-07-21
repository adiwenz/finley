/**
 * The `Projection` facade — the headline public API of `@finley/engine` (§2, §18,
 * §20, "npm API surface" of JOBS_HOUSEHOLD_REDESIGN, issue #70, slice 7).
 *
 * One **unified `Projection` root**: both standing edits (`addJob`, `addBudgetLine`,
 * `setRetirementTarget`) and ledger transactions (`buyHome`, `marry`, `takeLoan`) are
 * methods on it. Internally they route to standing data (a {@link Plan}) vs the
 * {@link Ledger} per §18/§20 — but the caller sees **one object, one undo stack**.
 * It is "imperative-looking over an immutable core" (§2): each write derives a *new*
 * immutable {@link ProjectionState} and pushes it onto an internal history stack, so
 * {@link Projection.undo} reverts standing edits and ledger transactions uniformly
 * (a single pop), and every past state stays intact.
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
 * Packaging (§ "npm API", Q28): the facade ships *inside* `@finley/engine` as the
 * headline surface; the existing functional barrel (`interpretLedger`,
 * `simulateHousehold`, …) stays exported as the low-level surface. The purity guard
 * is unchanged — internal history mutation is not I/O, and `Jurisdiction` is a
 * `run()` argument (the engine's own {@link nullJurisdiction} is used for the
 * write-time affordability gate), never a rules-package import.
 */

import type { Plan, GoalPlan } from "./plan";
import type { Job, PersonId } from "./job";
import type { BudgetLine } from "./budgetLine";
import type { Ledger } from "./ledger/ledger";
import { emptyLedger } from "./ledger/ledger";
import type { NewLifeEvent } from "./ledger/eventTypes";
import type { SimPerson } from "./projection/simulate";
import type { ProjectionSeries } from "./projection/simulate";
import type { LiabilityKind } from "./liability";
import type { GrowthMode } from "./cashFlowSeries";
import { addEvent } from "./ledger/addEvent";
import { interpretLedger } from "./ledger/interpret";
import { buildProjection } from "./projection/buildHouseholdInput";
import { createProjectionBase, firstInsolventMonth, PRIMARY_PERSON_ID } from "./projectionBase";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";

/**
 * The immutable authoring state a {@link Projection} snapshots onto its history
 * stack. Standing data ({@link Plan}) and the {@link Ledger} of transactions are the
 * two homes writes route to (§18/§20); `nextSeq` is the deterministic id counter
 * (§ "npm API") that **must** be serialized so a reload continues the sequence; and
 * `startYear` is the frozen "now" the compilation resolves against (an environment
 * input the engine cannot read from a wall clock).
 */
export interface ProjectionState {
  readonly plan: Plan;
  readonly ledger: Ledger;
  /** The frozen "now" — calendar year of month 0. */
  readonly startYear: number;
  /** Next deterministic sequence number a creating write will mint. Serialized (§ "npm API"). */
  readonly nextSeq: number;
}

/** A {@link Job} payload for {@link Projection.addJob}: owners are supplied as the
 * `personId` argument, the id is minted (override with `{ id }`). */
export type JobInput = Omit<Job, "id" | "owners"> & { readonly id?: string };

/** A {@link BudgetLine} payload for {@link Projection.addBudgetLine}: id minted (override with `{ id }`). */
export type BudgetLineInput = Omit<BudgetLine, "id"> & { readonly id?: string };

/** A {@link GoalPlan} payload for {@link Projection.addGoal}: id minted (override with `{ id }`). */
export type GoalInput = Omit<GoalPlan, "id"> & { readonly id?: string };

/** A `marry` payload: the incoming partner. `priorEarningsCents` defaults to none. */
export interface MarryInput {
  readonly month: number;
  readonly name: string;
  readonly birthYear?: number;
  readonly benefitClaimingAge?: number;
  readonly priorEarningsCents?: Readonly<Record<number, number>>;
  /** Override the minted person id. */
  readonly id?: string;
}

/** A `takeLoan` payload. `ownerId` defaults to the primary person. */
export interface TakeLoanInput {
  readonly month: number;
  readonly kind: LiabilityKind;
  readonly openingBalanceCents: number;
  readonly apr: number;
  readonly termMonths?: number;
  readonly creditLimitCents?: number;
  readonly ownerId?: PersonId;
  /** Override the minted liability id. */
  readonly id?: string;
}

/** A `buyHome` payload. `ownerId` defaults to the primary person. */
export interface BuyHomeInput {
  readonly month: number;
  readonly purchasePriceCents: number;
  readonly downPaymentCents: number;
  readonly downPaymentAccountId: string;
  readonly mortgageApr: number;
  readonly mortgageTermMonths: number;
  readonly appreciationMode?: GrowthMode;
  readonly ownerId?: PersonId;
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
   * The history stack: the last entry is the current state, every earlier entry a
   * prior one. Never empty — the initial state is the floor {@link undo} cannot pop
   * past. This is the ONLY mutable field; each write replaces it by pushing a fresh
   * immutable {@link ProjectionState} (imperative-looking over an immutable core, §2).
   */
  private history: ProjectionState[];

  /** Construct from an explicit history (used by {@link fromJSON}); prefer {@link create}. */
  private constructor(history: ProjectionState[]) {
    this.history = history;
  }

  /** A fresh projection from standing numbers: empty ledger, sequence starting at 1. */
  static create(init: ProjectionInit): Projection {
    return new Projection([
      { plan: init.plan, ledger: emptyLedger, startYear: init.startYear, nextSeq: 1 },
    ]);
  }

  /** The current authoring state (top of the history stack). */
  get state(): ProjectionState {
    return this.history[this.history.length - 1];
  }

  /** Number of writes that can still be {@link undo}ne (0 at a fresh/fully-undone plan). */
  get depth(): number {
    return this.history.length - 1;
  }

  /** Push a derived state onto history — the single write primitive every method routes through. */
  private commit(next: ProjectionState): void {
    this.history.push(next);
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
      owners: [personId],
      startYear: job.startYear,
      endYear: job.endYear,
      salary: job.salary,
      ...(job.deferral !== undefined ? { deferral: job.deferral } : {}),
    };
    const plan: Plan = { ...s.plan, jobs: [...(s.plan.jobs ?? []), newJob] };
    this.commit({ ...s, plan, nextSeq });
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
    const plan: Plan = { ...s.plan, budgetLines: [...(s.plan.budgetLines ?? []), newLine] };
    this.commit({ ...s, plan, nextSeq });
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
    const plan: Plan = { ...s.plan, goals: [...s.plan.goals, newGoal] };
    this.commit({ ...s, plan, nextSeq });
    return id;
  }

  /**
   * Set the retirement target age (§5) — the career-exit input. A standing *edit*, not
   * a creating write: it overwrites an existing value, so it mints no id.
   */
  setRetirementTarget(age: number): void {
    const s = this.state;
    this.commit({ ...s, plan: { ...s.plan, retirementAge: age } });
  }

  // ─── Ledger transactions (§18) ────────────────────────────────────────────

  /**
   * Grow the ledger with a life event through the safe, base-aware {@link addEvent}
   * path (its own-field + precondition validation, incl. the §4.5 affordability gate,
   * evaluated under the engine's own {@link nullJurisdiction} — no rules import, purity
   * intact), and commit it as ONE new state carrying both the grown ledger and the
   * post-mint `nextSeq`. Throws the conflict on failure, leaving history untouched (so
   * a refused transaction consumes no id). The single commit is what keeps
   * {@link undo} a clean one-pop revert.
   */
  private commitEvent(event: NewLifeEvent, nextSeq: number): void {
    const s = this.state;
    const base = createProjectionBase(s.plan, {
      jurisdiction: nullJurisdiction,
      startYear: s.startYear,
    });
    const result = addEvent(s.ledger, base, event, nullJurisdiction);
    if (!result.ok) {
      throw new Error(`Projection: cannot apply transaction — ${result.conflict}`);
    }
    this.commit({ ...s, ledger: result.ledger, nextSeq });
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
      ...(input.birthYear !== undefined ? { birthYear: input.birthYear } : {}),
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
    this.commitEvent(
      {
        id,
        type: "LoanEvent",
        month: input.month,
        liabilityId: id,
        ownerId: input.ownerId ?? (PRIMARY_PERSON_ID as PersonId),
        kind: input.kind,
        openingBalanceCents: input.openingBalanceCents,
        apr: input.apr,
        ...(input.termMonths !== undefined ? { termMonths: input.termMonths } : {}),
        ...(input.creditLimitCents !== undefined
          ? { creditLimitCents: input.creditLimitCents }
          : {}),
      },
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
        ownerId: input.ownerId ?? (PRIMARY_PERSON_ID as PersonId),
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

  // ─── Undo (§18) ───────────────────────────────────────────────────────────

  /**
   * Revert the most recent write — standing edit or ledger transaction, uniformly
   * (§18 "undo everywhere"): a single pop of the history stack. No-op at the initial
   * state (nothing to undo). Returns whether a write was reverted.
   */
  undo(): boolean {
    if (this.history.length <= 1) return false;
    this.history.pop();
    return true;
  }

  // ─── Run (§ "npm API", Q26) ────────────────────────────────────────────────

  /**
   * Compute the immutable {@link ProjectionResult} for the current authoring state
   * under `jurisdiction`. Pure and read-only: it never touches the history stack, so
   * the same `Projection` can be re-run under different jurisdictions without mutation.
   */
  run(jurisdiction: Jurisdiction): ProjectionResult {
    const s = this.state;
    const base = createProjectionBase(s.plan, { jurisdiction, startYear: s.startYear });
    const household = interpretLedger(s.ledger, base);
    const series = buildProjection(household, base, jurisdiction);
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
   * and never collide with an existing id. Only the current state is emitted; the undo
   * history is a live editing convenience, not persisted plan data.
   */
  toJSON(): ProjectionState {
    return this.state;
  }

  /** Reconstruct a projection from a {@link toJSON} snapshot — a fresh single-entry history. */
  static fromJSON(state: ProjectionState): Projection {
    return new Projection([state]);
  }
}
