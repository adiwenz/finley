/**
 * The `Projection` root — the high-level public API of `@finley/engine`; the functional
 * barrel (`interpretLedger`, `simulateHousehold`, …) remains the low-level surface.
 *
 * Standing edits (`addJob`) route to a {@link Plan}, ledger transactions (`buyHome`) to the
 * {@link Ledger}. Each write derives a new {@link ProjectionState}, so state already handed
 * out stays intact.
 *
 * Every authorable thing is add / edit / remove, not add-only: a caller that can author a
 * goal, a job, a budget line or a transaction can also revise and retract it, so the API is a
 * full editor rather than an authoring funnel that has to be escaped through {@link fromJSON}.
 *
 * No undo stack. Reversal is addressable, not positional: {@link Projection.removeTransaction}
 * names the event to drop, because a UI deleting row 3 does not know creation order.
 *
 * The jurisdiction is injected at `run()`, never at construction, so one plan re-runs under
 * different rule sets. `Projection` therefore imports no rules package; the write-time
 * affordability gate uses {@link nullJurisdiction}.
 */

import type { Plan, GoalPlan, GoalPatch, PlanPatch } from "./plan";
import { withGoalPatch, withGoalReordered, withoutGoal, withPlanPatch } from "./plan";
import type { Job, JobIncomeOverride, JobPatch, JobPayChange, PersonId } from "./job";
import {
  mapJob,
  withDeferralFraction,
  withIncomeOverride,
  withJobPatch,
  withMonthlyIncome,
  withoutIncomeOverride,
  withoutPayChange,
  withPayChange,
} from "./job";
import type { BudgetLine, BudgetLinePatch } from "./budgetLine";
import { withLinePatch, withoutLine } from "./budgetLine";
import type { Scenario } from "./scenario";
import { scenarioOf, withPlan, withLedger } from "./scenario";
import type { LifeEvent, NewLifeEvent } from "./ledger/eventTypes";
import { causedByEventId } from "./ledger/eventTypes";
import type { Ledger } from "./ledger/ledger";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import type { Person } from "./person";
import type { ProjectionSeries } from "./projection/simulate";
import type { LiabilityKind } from "./liability";
import type { GrowthMode } from "./cashFlowSeries";
import { addEvent } from "./ledger/addEvent";
import { removeEvent } from "./ledger/removeEvent";
import { updateEvent } from "./ledger/updateEvent";
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
 *
 * Jobs arrive as {@link JobInput}, not `Job`: the engine is the sole id authority, and for a
 * partner the owner is the person this very call creates — a caller could not name either id
 * before {@link Projection.marry} minted the person. {@link Projection.marry} mints each job's
 * id and stamps its `ownerId`.
 */
export interface MarryInput {
  readonly month: number;
  readonly name: string;
  readonly birthYear: number;
  readonly retirementTargetAge?: number;
  readonly benefitClaimingAge?: number;
  readonly jobs?: readonly JobInput[];
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

/**
 * A child joins the household. `birthMonth` defaults to `month` — recording a birth as it
 * happens; they differ only when a pre-existing child is entered after the fact (a birth
 * month at or below 0). A positive `annualCostCents` spawns the linked 18-year cost stream;
 * 0 records the child with no financial effect.
 */
export interface HaveChildInput {
  readonly month: number;
  readonly name: string;
  readonly annualCostCents: number;
  readonly birthMonth?: number;
  /** Override the minted child id. */
  readonly id?: string;
}

/**
 * A partner leaves the household. Every money field defaults to 0 — the no-support
 * separation is the plain case, not an omission — and alimony runs from `month`.
 */
export interface SeparateInput {
  readonly month: number;
  /** The partner {@link Projection.marry} returned. */
  readonly partnerPersonId: PersonId;
  readonly alimonyMonthlyCents?: number;
  readonly alimonyDurationMonths?: number;
  readonly childSupportMonthlyCents?: number;
  /** Override the minted event id. */
  readonly id?: string;
}

/**
 * A lump-sum principal paydown: the liability's balance falls and `accountId` pays for it, as
 * one conserved movement.
 */
export interface PayOffDebtInput {
  readonly month: number;
  readonly liabilityId: string;
  /** The account the payment is drawn from; must exist at `month`. */
  readonly accountId: string;
  readonly amountCents: number;
  /** Override the minted event id. */
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
 * Every kind the shared counter issues ids for. ONE list: {@link mint} accepts nothing else,
 * so the compiler refuses a new kind until it is named here, and {@link MINTED_ID} — the
 * parser that has to recognize the same ids coming back in — is built from it. A kind that
 * mints but is not recognized on the way back is exactly how a counter walks onto a live id.
 */
const MINTED_KINDS = [
  "job",
  "line",
  "goal",
  "person",
  "child",
  "separation",
  "payoff",
  "loan",
  "home",
] as const;

type MintedKind = (typeof MINTED_KINDS)[number];

/** The exact inverse of {@link mint}'s `${kind}-${n}` template — no other shape parses. */
const MINTED_ID = new RegExp(`^(?:${MINTED_KINDS.join("|")})-(\\d+)$`);

/**
 * The number {@link mint} issued to make this id, or `null` for anything it did not make.
 *
 * Rejects a suffix past `Number.MAX_SAFE_INTEGER`: past that, `Number` rounds, so
 * `job-9007199254740993` would parse to an integer neighbouring value and set a floor no
 * counter can reach — the mint would then hand out the SAME id forever, since incrementing a
 * non-safe integer is a no-op. Ignoring it is correct as well as safe: `mint` cannot have
 * issued a number it cannot count to, so nothing that far out is a real minted id.
 */
function mintedNumber(id: string | undefined): number | null {
  if (id === undefined) return null;
  const match = MINTED_ID.exec(id);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A caller's `{ id }` override is returned VERBATIM — it is their name for the thing, and
 * `Projection` does not rename it. But if it is one of *our* ids, the counter steps over it:
 * authoring `job-2` explicitly and then minting twice would otherwise reach `job-2` again.
 *
 * Anything else — `external-payroll-job`, a suffix past `Number.MAX_SAFE_INTEGER` — leaves the
 * counter alone. `mint` never produces those shapes, so no future id can collide with them.
 *
 * One counter across all kinds, so a `goal-5` override moves the floor for jobs and loans too.
 */
function mint(
  state: ProjectionState,
  kind: MintedKind,
  override: string | undefined,
): { id: string; nextSeq: number } {
  if (override != null) {
    const taken = mintedNumber(override);
    return {
      id: override,
      nextSeq: taken === null ? state.nextSeq : Math.max(state.nextSeq, taken + 1),
    };
  }
  return { id: `${kind}-${state.nextSeq}`, nextSeq: state.nextSeq + 1 };
}

/** A job's ids: its own, its owner's, and the account its deferral funds. */
function jobIds(job: Job): readonly (string | undefined)[] {
  return [job.id, job.ownerId, job.deferral?.fundAccountId];
}

/**
 * The id-bearing fields of one event, named field by field. The switch is exhaustive over
 * {@link LifeEvent} — the `never` default makes a new event type a COMPILE error here, so an
 * id field cannot be added to the union and silently left out of the floor.
 */
function eventIds(event: LifeEvent): readonly (string | undefined)[] {
  const common = [event.id, causedByEventId(event)];
  switch (event.type) {
    case "RelationshipEvent":
      return [...common, event.person.id, ...event.person.jobs.flatMap(jobIds)];
    case "ChildEvent":
      return [...common, event.childId];
    case "SeparationEvent":
      return [...common, event.partnerPersonId];
    case "HomePurchaseEvent":
      return [
        ...common,
        event.propertyId,
        event.ownerId,
        event.mortgageLiabilityId,
        ...event.downPaymentSourceIds,
      ];
    case "LoanEvent":
      return [...common, event.liabilityId, event.ownerId];
    case "DebtPayoffEvent":
      return [...common, event.liabilityId, event.accountId];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Every field of a {@link Scenario} that can hold an id the counter issued — the plan's three
 * collections and each event, named explicitly.
 *
 * Named fields, NOT a walk over every string: a `childName` of `"room-50000"` or a label of
 * `"goal-2 rewrite"` is a person's words, and treating it as a counter reading would advance
 * the mint by fifty thousand on the strength of a typo. Only somewhere an id actually lives
 * is read.
 */
function mintedIdFields(scenario: Scenario): readonly (string | undefined)[] {
  const { plan, ledger } = scenario;
  return [
    ...plan.jobs.flatMap(jobIds),
    ...plan.goals.map((g) => g.id),
    ...plan.budgetLines.flatMap((l) => [
      l.id,
      l.target.kind === "account" ? l.target.accountId : undefined,
    ]),
    ...ledger.events.flatMap(eventIds),
  ];
}

/**
 * The counter floor a scenario forces — ONE number, computed once, serving both counters that
 * authored data can invalidate:
 *
 *  - `ProjectionState.nextSeq`, the id mint. A plan holding `job-1` or an event holding
 *    `child-1` means the next {@link Projection.addJob} / {@link Projection.haveChild} must
 *    not mint it a second time.
 *  - `Ledger.nextSequenceNumber`, the same-month tie-breaker {@link addEvent} stamps from.
 *    Its invariant (strictly above every event's `sequenceNumber`) is documented but not
 *    enforced on data arriving from outside, and a ledger violating it hands the next two
 *    appends the SAME sequence number.
 *
 * Never decreases: `current` is a lower bound, so a number this `Projection` has already
 * issued stays spent and an import cannot walk the counter back onto a live id.
 */
function seqFloor(scenario: Scenario, current: number): number {
  let floor = Math.max(current, scenario.ledger.nextSequenceNumber);
  for (const event of scenario.ledger.events) {
    floor = Math.max(floor, event.sequenceNumber + 1);
  }
  for (const id of mintedIdFields(scenario)) {
    const n = mintedNumber(id);
    if (n !== null) floor = Math.max(floor, n + 1);
  }
  return floor;
}

/**
 * `state` with BOTH counters raised to the floor its own contents force — the entry point for
 * every state that arrives from outside rather than being built up by writes.
 *
 * Whole-state normalization, not just `nextSeq`: a serialized state carries the ledger's
 * `nextSequenceNumber` too, and it is no more trustworthy than the id counter. Its invariant
 * (strictly above every event's `sequenceNumber`) is documented but nothing enforces it on
 * data that has been round-tripped through JSON, edited by hand, or written by an older build.
 *
 * Never decreases either counter, and is idempotent — normalizing an already-normal state
 * returns the same numbers.
 */
function withNormalizedCounters(state: ProjectionState): ProjectionState {
  const nextSeq = seqFloor(state.scenario, state.nextSeq);
  return {
    ...state,
    scenario: withLedger(state.scenario, {
      ...state.scenario.ledger,
      nextSequenceNumber: nextSeq,
    }),
    nextSeq,
  };
}

export class Projection {
  /** The only mutable field; writes swap in a fresh state rather than mutating it. */
  private current: ProjectionState;

  private constructor(state: ProjectionState) {
    this.current = state;
  }

  /**
   * The counter starts clear of the plan it is handed, not at 1: a plan authored elsewhere
   * routinely already holds `job-1`, and minting it a second time would give two jobs one id.
   */
  static create(init: ProjectionInit): Projection {
    const scenario = scenarioOf(init.plan);
    return new Projection({
      scenario,
      startYear: init.startYear,
      nextSeq: seqFloor(scenario, 1),
    });
  }

  get state(): ProjectionState {
    return this.current;
  }

  get plan(): Plan {
    return this.current.scenario.plan;
  }

  /**
   * The timeline as authored. Read-only, and the companion to {@link plan}: revising or
   * removing a transaction is addressed by id, so a caller has to be able to see the ids.
   */
  get ledger(): Ledger {
    return this.current.scenario.ledger;
  }

  /**
   * The single write primitive every method routes through — and so the one place the id
   * counter is re-floored against what was just written.
   *
   * {@link mint} covers the id a write *asks* for, but not the ids a write CARRIES: a partner
   * arrives at {@link marry} with their own jobs already named, and {@link reviseTransaction}
   * can introduce a whole new set. Neither passes through the mint. Flooring here, rather than
   * in each method, means an authoring path cannot be added that forgets to — and since
   * {@link seqFloor} never decreases, doing it on every write costs nothing but a walk.
   *
   * A refused write throws before reaching here, so nothing it minted is consumed.
   */
  private commit(next: ProjectionState): void {
    this.current = { ...next, nextSeq: seqFloor(next.scenario, next.nextSeq) };
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

  /**
   * Apply one of `job`'s authoring transforms to the job with `id` and commit. Every per-job
   * setter routes through here, so each is the transform's name and nothing else.
   */
  private editJob(id: string, f: (job: Job) => Job): void {
    const plan = this.state.scenario.plan;
    this.commitPlan({ ...plan, jobs: mapJob(plan.jobs, id, f) });
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

  /**
   * Rewrite one job's fields in place, keeping its `id` — see {@link withJobPatch} for what
   * carries through.
   *
   * Editing a job changes the income the projection base compiles, but never re-validates the
   * ledger: the affordability gate is an append-time check ({@link commitEvent}), so a
   * transaction already accepted stays accepted. That matches the app, whose gate also fires
   * only on append. A patch aimed at an id that is not a job is a no-op plan swap.
   */
  updateJob(id: string, patch: JobPatch): void {
    this.editJob(id, (j) => withJobPatch(j, patch));
  }

  /**
   * Drop a job. Unlike {@link removeGoal} there is nothing to guard: a job derives no account
   * an event can reference, so no ledger reference can dangle. Removing an id that is not a
   * job is a no-op.
   */
  removeJob(id: string): void {
    const plan = this.state.scenario.plan;
    this.commitPlan({ ...plan, jobs: plan.jobs.filter((j) => j.id !== id) });
  }

  /** See {@link withMonthlyIncome} — monthly cents in, annualized salary stored. */
  setJobMonthlyIncome(id: string, monthlyCents: number): void {
    this.editJob(id, (j) => withMonthlyIncome(j, monthlyCents));
  }

  /**
   * See {@link withDeferralFraction}. It exists beside {@link updateJob} because 0 *removes*
   * the deferral and a positive fraction preserves the funded account and employer match —
   * an asymmetry a `deferral` patch, which replaces the whole object, cannot express.
   */
  setJobDeferralFraction(id: string, fraction: number): void {
    this.editJob(id, (j) => withDeferralFraction(j, fraction));
  }

  /** See {@link withPayChange} — a permanent raise or cut, at most one per (job, month). */
  addJobPayChange(jobId: string, payChange: JobPayChange): void {
    this.editJob(jobId, (j) => withPayChange(j, payChange));
  }

  /** See {@link withoutPayChange}. */
  removeJobPayChange(jobId: string, month: number): void {
    this.editJob(jobId, (j) => withoutPayChange(j, month));
  }

  /** See {@link withIncomeOverride} — a one-month perturbation, not a new salary segment. */
  addJobIncomeOverride(jobId: string, override: JobIncomeOverride): void {
    this.editJob(jobId, (j) => withIncomeOverride(j, override));
  }

  /** See {@link withoutIncomeOverride}. */
  removeJobIncomeOverride(jobId: string, month: number): void {
    this.editJob(jobId, (j) => withoutIncomeOverride(j, month));
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

  /** See {@link withLinePatch} — span, dated overrides and priority carry through. */
  updateBudgetLine(id: string, patch: BudgetLinePatch): void {
    const plan = this.state.scenario.plan;
    this.commitPlan({ ...plan, budgetLines: withLinePatch(plan.budgetLines, id, patch) });
  }

  /**
   * Drop a budget line. No guard: a line derives no account an event can reference. Removing
   * an id that is not a line is a no-op.
   */
  removeBudgetLine(id: string): void {
    const plan = this.state.scenario.plan;
    this.commitPlan({ ...plan, budgetLines: withoutLine(plan.budgetLines, id) });
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
   * See {@link withGoalPatch}. Editing keeps the `id`, so the `goal-<id>` fund account is
   * stable and no funding reference can dangle — which is why, unlike {@link removeGoal}, this
   * needs no guard.
   */
  updateGoal(id: string, patch: GoalPatch): void {
    const plan = this.state.scenario.plan;
    this.commitPlan({ ...plan, goals: withGoalPatch(plan.goals, id, patch) });
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
    this.commitPlan({ ...plan, goals: withoutGoal(plan.goals, id) });
  }

  /**
   * See {@link withGoalReordered}. {@link addGoal} only appends, so this is the sole way an
   * API caller reprioritizes a goal after authoring it.
   */
  reorderGoal(id: string, direction: "up" | "down"): void {
    const plan = this.state.scenario.plan;
    this.commitPlan({ ...plan, goals: withGoalReordered(plan.goals, id, direction) });
  }

  /**
   * Patch the plan's standing scalars — opening balance, the return and inflation rates, the
   * health-cost fields, the ages, the household levers, the name. The collections are NOT
   * reachable from here, in the type or at runtime (see {@link withPlanPatch}): every goal /
   * job / budget-line edit goes through the method that mints its id and enforces its rules.
   */
  updatePlan(patch: PlanPatch): void {
    this.commitPlan(withPlanPatch(this.state.scenario.plan, patch));
  }

  /** The named shorthand for the scalar the retirement solver reports against. */
  setRetirementTarget(age: number): void {
    this.updatePlan({ retirementAge: age });
  }

  // Ledger transactions

  /**
   * The replay context every ledger write validates against: the plan compiled under
   * {@link nullJurisdiction}, so `Projection` stays free of any rules package.
   */
  private baseConfig(): LedgerBaseConfig {
    const s = this.state;
    return createProjectionBase(s.scenario.plan, {
      jurisdiction: nullJurisdiction,
      startYear: s.startYear,
    });
  }

  /**
   * Validates through {@link addEvent} — including the affordability gate, run under
   * {@link nullJurisdiction} to keep purity — and commits ledger and post-mint `nextSeq` as
   * ONE new state. On failure it throws with the state untouched, so a refused transaction
   * consumes no id.
   */
  private commitEvent(event: NewLifeEvent, nextSeq: number): void {
    const s = this.state;
    const result = addEvent(s.scenario.ledger, this.baseConfig(), event, nullJurisdiction);
    if (!result.ok) {
      throw new Error(`Projection: cannot apply transaction — ${result.conflict}`);
    }
    this.commit({ ...s, scenario: withLedger(s.scenario, result.ledger), nextSeq });
  }

  /** Returns the minted `"person-N"` id. */
  marry(input: MarryInput): string {
    const { id, nextSeq: afterPerson } = mint(this.state, "person", input.id);
    // One counter, threaded person → jobs: each job mints against the seq the previous mint
    // left, so the partner and their jobs draw distinct ids from the same monotonic run. The
    // owner is `id` — the person minted just above — because a partner's jobs belong to the
    // person this call creates, never to the caller.
    let nextSeq = afterPerson;
    const jobs: Job[] = (input.jobs ?? []).map((job) => {
      const minted = mint({ ...this.state, nextSeq }, "job", job.id);
      nextSeq = minted.nextSeq;
      const { id: _drop, ...rest } = job;
      return { ...rest, id: minted.id, ownerId: id };
    });
    const person: Person = {
      id,
      name: input.name,
      birthYear: input.birthYear,
      retirementTargetAge: input.retirementTargetAge ?? 65,
      benefitClaimingAge: input.benefitClaimingAge ?? 67,
      jobs,
    };
    this.commitEvent({ id, type: "RelationshipEvent", month: input.month, person }, nextSeq);
    return id;
  }

  /**
   * Returns the minted `"child-N"` id, which is both the event's id and the durable
   * {@link Child}'s — one id, so the cost stream this spawns and the child it belongs to are
   * addressed the same way, exactly as {@link buyHome} does for a property.
   */
  haveChild(input: HaveChildInput): string {
    const { id, nextSeq } = mint(this.state, "child", input.id);
    this.commitEvent(
      {
        id,
        type: "ChildEvent",
        month: input.month,
        childId: id,
        childName: input.name,
        birthMonth: input.birthMonth ?? input.month,
        annualCostCents: input.annualCostCents,
      },
      nextSeq,
    );
    return id;
  }

  /**
   * The counterpart to {@link marry}: ends the departing partner's income and opens whatever
   * support streams the split carries. REFUSED when the person was never partnered, has
   * already separated, or the month precedes the partnering — all preconditions
   * {@link commitEvent} surfaces as a thrown conflict.
   *
   * Returns the minted `"separation-N"` id — its own, not the partner's, since a separation
   * is an event about a person rather than a durable entity of its own.
   */
  separate(input: SeparateInput): string {
    const { id, nextSeq } = mint(this.state, "separation", input.id);
    this.commitEvent(
      {
        id,
        type: "SeparationEvent",
        month: input.month,
        partnerPersonId: input.partnerPersonId,
        alimonyMonthlyCents: input.alimonyMonthlyCents ?? 0,
        alimonyDurationMonths: input.alimonyDurationMonths ?? 0,
        childSupportMonthlyCents: input.childSupportMonthlyCents ?? 0,
      },
      nextSeq,
    );
    return id;
  }

  /**
   * A lump-sum paydown against an existing liability. Net worth is conserved: the same amount
   * leaves `accountId` as reduces the balance, both recorded by the one event. Returns the
   * minted `"payoff-N"` id.
   */
  payOffDebt(input: PayOffDebtInput): string {
    const { id, nextSeq } = mint(this.state, "payoff", input.id);
    this.commitEvent(
      {
        id,
        type: "DebtPayoffEvent",
        month: input.month,
        liabilityId: input.liabilityId,
        accountId: input.accountId,
        amountCents: input.amountCents,
      },
      nextSeq,
    );
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

  // Transaction lifecycle

  /**
   * Drop a transaction and, transitively, everything it caused — a home purchase takes its
   * mortgage, a child their cost stream. Addressable, not positional: a UI deleting row 3
   * names the event, because it does not know creation order.
   *
   * REFUSED when the remaining ledger would no longer replay — separating a partner you never
   * married — and the conflict names the event that would fail. A refusal throws with the
   * state untouched, the same contract {@link removeGoal} and {@link commitEvent} give.
   *
   * Sequence numbers are never recycled, so a later append cannot collide with the gap this
   * leaves.
   */
  removeTransaction(id: string): void {
    const s = this.state;
    const result = removeEvent(s.scenario.ledger, id, this.baseConfig());
    if (!result.ok) {
      throw new Error(`Projection: cannot remove transaction — ${result.conflict}`);
    }
    this.commit({ ...s, scenario: withLedger(s.scenario, result.ledger) });
  }

  /**
   * Revise a transaction in place, keeping its id and its place in the log. Without this,
   * anything authored *on* an event is write-once — a partner's jobs live on their
   * `RelationshipEvent`.
   *
   * `id` and `type` are fixed (dependencies are tracked by id, meaning by type); changing
   * either means a different event, so remove and add instead. The month is revisable.
   * Validation is the whole-ledger replay {@link removeTransaction} runs, so a revision that
   * would strand a later event is refused and names it; there is no affordability gate, which
   * fires only on append.
   */
  reviseTransaction(id: string, next: NewLifeEvent): void {
    const s = this.state;
    const result = updateEvent(s.scenario.ledger, id, next, this.baseConfig());
    if (!result.ok) {
      throw new Error(`Projection: cannot revise transaction — ${result.conflict}`);
    }
    this.commit({ ...s, scenario: withLedger(s.scenario, result.ledger) });
  }

  /**
   * Swap the whole timeline — how a caller loads a pre-built scenario without discarding the
   * plan it was authored against, which {@link fromJSON} would.
   *
   * The caller owns the incoming ledger's *validity*: this replays nothing, so it is the one
   * ledger write with no gate. It does NOT own the counters. Both are advanced past whatever
   * the import already occupies ({@link seqFloor}), because an imported event holding `child-1`
   * or sitting at `sequenceNumber` 7 would otherwise be handed straight back to the next
   * authored event as its own id or its own place in the log.
   *
   * Prefer the per-transaction methods for anything an authoring flow does; reach for this
   * only when the ledger arrives already-built.
   */
  resetLedger(ledger: Ledger): void {
    const s = this.state;
    // Normalized over the plan AND the incoming ledger, so the standing collections keep their
    // claim on the counter across a reset. Sequence numbers are allowed to skip — the gap this
    // leaves is the same kind a removal leaves.
    this.commit(withNormalizedCounters({ ...s, scenario: withLedger(s.scenario, ledger) }));
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

  /**
   * Both counters are normalized on the way in rather than trusted. A serialized state is the
   * least trustworthy input the API takes — it has been through JSON, may have been hand-edited
   * or truncated, and may have been written by a build whose counters meant something else. A
   * stale `nextSeq` beside a plan holding `job-5` would mint `job-5` again on the first write.
   *
   * Normalization only ever raises a counter, so a well-formed state round-trips unchanged.
   */
  static fromJSON(state: ProjectionState): Projection {
    return new Projection(withNormalizedCounters(state));
  }
}
