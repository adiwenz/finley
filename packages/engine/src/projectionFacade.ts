/**
 * The `Projection` facade — the stateful door onto `@finley/engine`.
 *
 * It owns exactly one thing: the mutable `current` state, and the discipline of only ever
 * replacing it with a state derived by a plain function. Everything a method actually *does*
 * lives elsewhere — the authoring rules in `./authoring/*`, the simulation pass in
 * `./projectionRun`, the retirement search in `./retirementOutlook` — so which plane a job is
 * stored on, what blocks a goal's removal, how a revision rebuilds an event and how a run is
 * assembled are all facts this class never has to know. What is left here is the shape of the
 * API: what a caller may ask, in what vocabulary, and against what state.
 *
 * The methods stay because a facade is the point — a caller holds one object, not a toolkit of
 * state functions it has to sequence correctly. The bodies are one line each because that is the
 * only way the facade stays a *surface* rather than becoming the implementation again.
 *
 * `index.ts` republishes this class and the types its methods name; it is the package's export
 * map, and nothing here is reachable except through it.
 *
 * Standing edits (`addJob`) route to a {@link Plan}, ledger transactions (`buyHome`) to the
 * {@link Ledger}. Each write derives a new {@link ProjectionState}, so state already handed out
 * stays intact.
 *
 * ## Where identity comes from
 *
 * Two kinds of door, split on who names things — authoring mints, restoring preserves:
 *
 *  - {@link Projection.init} **authors**, imperatively. It takes the plan's scalars and nothing
 *    else, handing back an empty projection to build up with the authoring methods.
 *  - {@link Projection.fromInput} **authors**, declaratively. It takes an id-free `ScenarioInput`
 *    and mints every identity off the shared counter. It is `init` plus the entries.
 *  - {@link Projection.fromState} **restores**. It takes a whole `ProjectionState` whose ids were
 *    issued earlier, and floors the counters past everything it holds.
 *
 * Nothing else adopts caller-named data. No authoring method takes an `id`; no method takes an
 * id-bearing `Plan`, `Ledger` or `LifeEvent`. An editing method may take an existing id as the
 * TARGET it addresses — `updateJob(jobId, …)`, `reviseTransaction(eventId, …)` — but what it is
 * handed can never replace that id or any identity nested beneath it. The two operations that
 * genuinely need to name an existing identity say so in their signature rather than accepting it
 * in a payload: {@link Projection.reassignJob} moves a job between members keeping its id, and
 * {@link Projection.reviseTransaction} changes an event's data while rebuilding it from what is
 * already in the log. `authoringInputs.guard.test.ts` holds that boundary to the compiler.
 *
 * Every authorable thing is add / edit / remove, not add-only: a caller that can author a goal, a
 * job, a budget line or a transaction can also revise and retract it, so the API is a full editor
 * rather than an authoring funnel that has to be escaped through {@link fromState}.
 *
 * No undo stack. Reversal is addressable, not positional: {@link Projection.removeTransaction}
 * names the event to drop, because a UI deleting row 3 does not know creation order.
 *
 * `Projection` holds a jurisdiction twice over, answering two different questions. `run()` takes
 * one per call — "what does this scenario look like under these rules?" — and stays independent,
 * so one plan re-runs under any rule set. The *validation* jurisdiction is fixed at construction
 * — "is this write permitted?" — and is what the write-time affordability gate decides on, so a
 * jurisdiction-dependent authoring gate (the §4.5 down-payment check nets funds after
 * capital-gains tax) fires the same way it does in the app.
 *
 * Only the second question is meant to be varied freely: authoring under one jurisdiction and
 * projecting under another is legal, not an error. The validation jurisdiction is behaviour
 * rather than data — never serialised into {@link ProjectionState}, supplied fresh beside the
 * state each time a handle is constructed (which is why {@link ProjectionResult} records a
 * `jurisdictionId`, not the jurisdiction itself).
 *
 * It is **required**, with no default. A default would have to be `nullJurisdiction`, and a
 * caller who meant to validate under real tax rules but forgot the argument would silently get
 * the tax-free answer — the false-accept this contract exists to prevent, reintroduced by
 * omission. Standalone use is unaffected: `nullJurisdiction` is part of this package, so
 * `fromInput(input, nullJurisdiction)` needs no rules package — it just has to say so out loud.
 */

import type { Plan, PlanPatch, GoalPatch } from "./plan";
import type { JobIncomeOverride, JobPatch, JobPayChange, PersonId } from "./job";
import type { BudgetLineOverride, BudgetLinePatch } from "./budgetLine";
import type { LifeEvent } from "./ledger/eventTypes";
import type { Ledger } from "./ledger/ledger";
import type { FundingLookup } from "./ledger/addEvent";
import { planAccountDescriptors } from "./projectionBase";
import type { PlanAccountDescriptor } from "./projectionBase";
import type { ScenarioInput, ScenarioScalars, FromInputResult } from "./scenarioInput";
import type { Cents } from "./money";
// Type-only: with the validation jurisdiction required, this module no longer names a fallback.
import type { Jurisdiction } from "./jurisdiction";

// The two derived-output queries, each a plain function of state declared beside the artifact it
// answers with — so neither the simulation pipeline nor the retirement search is named here.
import { runProjection } from "./projectionRun";
import type { ProjectionResult } from "./projectionRun";
import { buildRetirementOutlook } from "./retirementOutlook";
import type { RetirementOutlook } from "./retirementOutlook";

import type { ProjectionState, Written } from "./authoring/state";
import { emptyState } from "./authoring/state";
import { withFlooredIdCounter } from "./authoring/mint";
import { restoreState } from "./authoring/restore";
import { projectionFunding } from "./authoring/eventWrite";
import { updateProjectionPlan } from "./authoring/planScalars";
import type { JobInput } from "./authoring/jobs";
import {
  addProjectionJob,
  addProjectionJobIncomeOverride,
  addProjectionJobPayChange,
  addProjectionPartnerJob,
  householdMonthlyIncomeCentsOf,
  jobDeferralFractionOf,
  jobMonthlyIncomeCentsOf,
  personDeferralFractionOf,
  personMonthlyIncomeCentsOf,
  reassignProjectionJob,
  removeProjectionJob,
  removeProjectionJobIncomeOverride,
  removeProjectionJobPayChange,
  removeProjectionPartnerJob,
  replaceProjectionJob,
  replaceProjectionPartnerJob,
  setProjectionJobDeferralFraction,
  setProjectionJobMonthlyIncome,
  updateProjectionJob,
  updateProjectionPartnerJob,
} from "./authoring/jobs";
import type { BudgetLineInput, ResolvedExpenseRow } from "./authoring/budgetLines";
import {
  addProjectionBudgetLine,
  addProjectionBudgetLineOverride,
  removeProjectionBudgetLine,
  resolveExpenseRows,
  updateProjectionBudgetLine,
} from "./authoring/budgetLines";
import type { GoalInput } from "./authoring/goals";
import {
  addProjectionGoal,
  projectionEventsFundedByGoal,
  removeProjectionGoal,
  reorderProjectionGoal,
  updateProjectionGoal,
} from "./authoring/goals";
import type {
  HaveChildInput,
  HaveExistingChildInput,
  MarryInput,
  SeparateInput,
  StartPartneredInput,
} from "./authoring/relationships";
import {
  applyChild,
  applyHaveExistingChild,
  applyMarriage,
  applySeparation,
  applyStartPartnered,
} from "./authoring/relationships";
import type { BuyHomeInput } from "./authoring/housing";
import { applyHomePurchase } from "./authoring/housing";
import type { CarryLoanInput, PayOffDebtInput, TakeLoanInput } from "./authoring/liabilities";
import { applyCarryLoan, applyDebtPayoff, applyLoan } from "./authoring/liabilities";
import type { TransactionRevision } from "./authoring/revise";
import { removeProjectionTransaction, reviseProjectionTransaction } from "./authoring/revise";
import { interpretScenarioInput } from "./authoring/fromInput";

export class Projection {
  /** The only mutable field; writes swap in a fresh state rather than mutating it. */
  private current: ProjectionState;

  /**
   * The jurisdiction every write validates against — behaviour, not state, so it is passed
   * beside the state at construction and never serialised. `run()` ignores it entirely.
   */
  private readonly validationJurisdiction: Jurisdiction;

  private constructor(state: ProjectionState, jurisdiction: Jurisdiction) {
    this.current = state;
    this.validationJurisdiction = jurisdiction;
  }

  /**
   * Run one write over plain {@link ProjectionState} and hand back the next state beside
   * whatever the write returned. The app holds state, not a live handle, so every mutation is
   * a momentary handle built here, written once, and read back — the id-returning methods keep
   * returning their id through `result`.
   *
   * The handle is constructed through {@link fromState}, so the counters are floored on the way
   * in exactly as any imported state is, and `fn` validates against the jurisdiction passed.
   */
  static transact<R>(
    state: ProjectionState,
    jurisdiction: Jurisdiction,
    fn: (projection: Projection) => R,
  ): { state: ProjectionState; result: R } {
    const projection = Projection.fromState(state, jurisdiction);
    const result = fn(projection);
    return { state: projection.state, result };
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
   * The single write primitive every authoring method routes through: derive the next state with
   * a plain function of the current one, adopt it, and re-floor the id counter against what was
   * just written.
   *
   * A write that answers with something — a minted id — returns {@link Written} and that `result`
   * comes back through here; one with nothing to say returns the state alone.
   *
   * Nothing is adopted until the deriving function RETURNS, which is what makes a refusal atomic:
   * a throw anywhere inside it — a missing id, a ledger conflict, a funding guard — leaves
   * `current` exactly as it was, even for a multi-step write like {@link reassignJob} that
   * touches both planes.
   *
   * Adoption goes through {@link withFlooredIdCounter}, which is the safeguard behind restored
   * state: its counters may be stale, so every write from such a handle onward is re-floored
   * against what the scenario actually holds rather than against what the state claimed.
   */
  private write(derive: (state: ProjectionState) => ProjectionState): void;
  private write<R>(derive: (state: ProjectionState) => Written<R>): R;
  private write<R>(
    derive: (state: ProjectionState) => ProjectionState | Written<R>,
  ): R | undefined {
    const derived = derive(this.current);
    // `ProjectionState` has no `state` field, so the discriminator cannot collide with one.
    const answered = "state" in derived;
    this.current = withFlooredIdCounter(answered ? derived.state : derived);
    return answered ? derived.result : undefined;
  }

  // Standing edits

  /**
   * Returns the minted `"job-N"` id.
   *
   * Every {@link JobInput} field carries through: a job arriving here may be an *existing* one
   * moving between household members, and it keeps its one-month overrides, permanent pay
   * changes and display name across the move.
   *
   * For a partner, {@link addPartnerJob}: their jobs are not plan data at all.
   */
  addJob(personId: PersonId, job: JobInput): string {
    return this.write((state) => addProjectionJob(state, personId, job));
  }

  /**
   * Rewrite one job wholesale, keeping its `id` and its list position — the counterpart to
   * {@link updateJob}'s field-wise patch. An absent field CLEARS rather than carries through.
   * Refused for an id the plan does not hold.
   */
  replaceJob(id: string, job: JobInput): void {
    this.write((state) => replaceProjectionJob(state, id, job));
  }

  /**
   * Rewrite one job's fields in place, keeping its `id`. Refused for an id the plan does not
   * hold.
   */
  updateJob(id: string, patch: JobPatch): void {
    this.write((state) => updateProjectionJob(state, id, patch));
  }

  /** Drop a job. Refused for an id the plan does not hold. */
  removeJob(id: string): void {
    this.write((state) => removeProjectionJob(state, id));
  }

  // Jobs on the other plane. A household member's jobs live on the plan or on the
  // `RelationshipEvent` that brought them in; `./authoring/jobs` owns that distinction, and these
  // four name the ledger plane explicitly because creating a job needs the person it belongs to.

  /** Add a job to a partner, returning the minted `"job-N"` id. */
  addPartnerJob(personId: PersonId, job: JobInput): string {
    return this.write((state) =>
      addProjectionPartnerJob(state, this.validationJurisdiction, personId, job),
    );
  }

  /** See {@link replaceJob} — the wholesale rewrite, on a partner's plane. */
  replacePartnerJob(jobId: string, job: JobInput): void {
    this.write((state) =>
      replaceProjectionPartnerJob(state, this.validationJurisdiction, jobId, job),
    );
  }

  /**
   * Hand a job to another household member, keeping its `id` — and with it every adjustment
   * addressed by that id: one-month income overrides, permanent pay changes, the employer match.
   *
   * This is the ONE operation that needs an already-issued job id, and it takes it as an argument
   * rather than letting one ride in on a {@link JobInput}, so authoring a job and relocating one
   * stay different verbs and no caller can name a job into existence.
   */
  reassignJob(jobId: string, toOwnerId: PersonId, job: JobInput): void {
    this.write((state) =>
      reassignProjectionJob(state, this.validationJurisdiction, jobId, toOwnerId, job),
    );
  }

  /** See {@link updateJob} — the field-wise patch, on a partner's plane. */
  updatePartnerJob(jobId: string, patch: JobPatch): void {
    this.write((state) =>
      updateProjectionPartnerJob(state, this.validationJurisdiction, jobId, patch),
    );
  }

  /** Drop a partner-owned job. See {@link removeJob}: there is nothing to guard. */
  removePartnerJob(jobId: string): void {
    this.write((state) =>
      removeProjectionPartnerJob(state, this.validationJurisdiction, jobId),
    );
  }

  // Adjustments to ONE job, addressed by its id alone — either plane, since one counter issues
  // job ids across both and an id therefore names one job in the household or nothing at all.

  /** Monthly cents in, annualized salary stored. */
  setJobMonthlyIncome(id: string, monthlyCents: number): void {
    this.write((state) =>
      setProjectionJobMonthlyIncome(state, this.validationJurisdiction, id, monthlyCents),
    );
  }

  /**
   * Beside {@link updateJob} because 0 *removes* the deferral and a positive fraction preserves
   * the funded account and employer match — an asymmetry a `deferral` patch, which replaces the
   * whole object, cannot express.
   */
  setJobDeferralFraction(id: string, fraction: number): void {
    this.write((state) =>
      setProjectionJobDeferralFraction(state, this.validationJurisdiction, id, fraction),
    );
  }

  /** A permanent raise or cut, at most one per (job, month). */
  addJobPayChange(jobId: string, payChange: JobPayChange): void {
    this.write((state) =>
      addProjectionJobPayChange(state, this.validationJurisdiction, jobId, payChange),
    );
  }

  removeJobPayChange(jobId: string, month: number): void {
    this.write((state) =>
      removeProjectionJobPayChange(state, this.validationJurisdiction, jobId, month),
    );
  }

  /** A one-month perturbation, not a new salary segment. */
  addJobIncomeOverride(jobId: string, override: JobIncomeOverride): void {
    this.write((state) =>
      addProjectionJobIncomeOverride(state, this.validationJurisdiction, jobId, override),
    );
  }

  removeJobIncomeOverride(jobId: string, month: number): void {
    this.write((state) =>
      removeProjectionJobIncomeOverride(state, this.validationJurisdiction, jobId, month),
    );
  }

  /** Returns the minted `"line-N"` id — always minted; a caller cannot name a line. */
  addBudgetLine(line: BudgetLineInput): string {
    return this.write((state) => addProjectionBudgetLine(state, line));
  }

  /** Span, dated overrides and priority carry through. Refused for an id the plan does not hold. */
  updateBudgetLine(id: string, patch: BudgetLinePatch): void {
    this.write((state) => updateProjectionBudgetLine(state, id, patch));
  }

  /**
   * Layer a dated amount override onto one line — the "just this month" / "from here forward"
   * answer. Beside {@link updateBudgetLine} rather than inside it: a patch REPLACES the
   * `overrides` array it is given, so routing an override through one would drop every other
   * dated change on the line unless the caller re-sent them all.
   */
  addBudgetLineOverride(lineId: string, override: BudgetLineOverride): void {
    this.write((state) => addProjectionBudgetLineOverride(state, lineId, override));
  }

  /** Drop a budget line. Nothing to guard beyond its existence. */
  removeBudgetLine(id: string): void {
    this.write((state) => removeProjectionBudgetLine(state, id));
  }

  /** Appended, so lowest funding priority. Returns the minted `"goal-N"` id. */
  addGoal(goal: GoalInput): string {
    return this.write((state) => addProjectionGoal(state, goal));
  }

  /** Editing keeps the `id`, so the `fund-<id>` account is stable and needs no funding guard. */
  updateGoal(id: string, patch: GoalPatch): void {
    this.write((state) => updateProjectionGoal(state, id, patch));
  }

  /**
   * Drop a goal and, with it, the derived fund account that is its balance. REFUSED while any
   * event still spends from that account. Callers wanting to ask before acting call
   * {@link eventsFundedByGoal}.
   */
  removeGoal(id: string): void {
    this.write((state) => removeProjectionGoal(state, id));
  }

  /**
   * {@link addGoal} only appends, so this is the sole way an API caller reprioritizes a goal
   * after authoring it. Refused at the ends: "move the first goal up" is a caller believing it
   * changed the funding order when it did not, and priority IS the order.
   */
  reorderGoal(id: string, direction: "up" | "down"): void {
    this.write((state) => reorderProjectionGoal(state, id, direction));
  }

  /**
   * Patch the plan's standing scalars. The collections are NOT reachable from here, in the type
   * or at runtime: every goal / job / budget-line edit goes through the method that mints its id
   * and enforces its rules.
   */
  updatePlan(patch: PlanPatch): void {
    this.write((state) => updateProjectionPlan(state, patch));
  }

  /** The named shorthand for the scalar the retirement solver reports against. */
  setRetirementTarget(age: number): void {
    this.updatePlan({ retirementAge: age });
  }

  // Ledger transactions

  /** Returns the minted `"person-N"` id. */
  marry(input: MarryInput): string {
    return this.write((state) => applyMarriage(state, this.validationJurisdiction, input));
  }

  /**
   * Author a partner already present at simulation start, keyed on how long the household has been
   * together. The counterpart to {@link marry}, which weds a partner DURING the plan: this one is
   * anchored at its true past month, so a {@link separate} can be dated before "now". Returns the
   * minted `"person-N"` id.
   */
  startPartnered(input: StartPartneredInput): string {
    return this.write((state) => applyStartPartnered(state, this.validationJurisdiction, input));
  }

  /**
   * Returns the minted `"child-N"` id, which is both the event's id and the durable child's —
   * one id, so the cost stream this spawns and the child it belongs to are addressed the same
   * way, exactly as {@link buyHome} does for a property.
   */
  haveChild(input: HaveChildInput): string {
    return this.write((state) => applyChild(state, this.validationJurisdiction, input));
  }

  /**
   * Record a child who was already born, keyed on their age. The birth is anchored at its true
   * past month, so the cost stream clips to the years of childhood that remain. Returns the
   * minted `"child-N"` id.
   */
  haveExistingChild(input: HaveExistingChildInput): string {
    return this.write((state) => applyHaveExistingChild(state, this.validationJurisdiction, input));
  }

  /**
   * The counterpart to {@link marry}. REFUSED when the person was never partnered, has already
   * separated, or the month precedes the partnering. Returns the minted `"separation-N"` id.
   */
  separate(input: SeparateInput): string {
    return this.write((state) => applySeparation(state, this.validationJurisdiction, input));
  }

  /** A lump-sum paydown against an existing liability. Returns the minted `"payoff-N"` id. */
  payOffDebt(input: PayOffDebtInput): string {
    return this.write((state) => applyDebtPayoff(state, this.validationJurisdiction, input));
  }

  /** Returns the minted `"loan-N"` id. */
  takeLoan(input: TakeLoanInput): string {
    return this.write((state) => applyLoan(state, this.validationJurisdiction, input));
  }

  /**
   * Author a loan the household ALREADY carries — a holding opened at the now marker with its
   * current balance and remaining term, so month 0 is its next payment. The counterpart to
   * {@link takeLoan}, which originates a fresh loan during the plan. Returns the minted
   * `"loan-N"` id.
   */
  carryLoan(input: CarryLoanInput): string {
    return this.write((state) => applyCarryLoan(state, this.validationJurisdiction, input));
  }

  /**
   * The mortgage liability id derives from the minted property id, parent-suffixed
   * (`<propertyId>-mortgage`) so a sort groups it under its home. Subject to the down-payment
   * hard block.
   */
  buyHome(input: BuyHomeInput): string {
    return this.write((state) => applyHomePurchase(state, this.validationJurisdiction, input));
  }

  // Transaction lifecycle

  /**
   * Drop a transaction and, transitively, everything it caused. REFUSED when the remaining ledger
   * would no longer replay, and the conflict names the event that would fail.
   */
  removeTransaction(id: string): void {
    this.write((state) => removeProjectionTransaction(state, this.validationJurisdiction, id));
  }

  /**
   * Revise a transaction's DATA in place, keeping its id, its place in the log, and every
   * identity it carries. `type` is fixed as well as `id`, so a revision naming the wrong verb for
   * the event is refused rather than reinterpreted.
   */
  reviseTransaction(id: string, revision: TransactionRevision): void {
    this.write((state) =>
      reviseProjectionTransaction(state, this.validationJurisdiction, id, revision),
    );
  }

  // Run

  /**
   * Project the current state under `jurisdiction` — read-only, and never swaps `current`. The
   * pass itself is `./projectionRun`; `jurisdiction` is taken per call rather than read off the
   * handle, so one authored plan re-projects under any rule set.
   */
  run(jurisdiction: Jurisdiction): ProjectionResult {
    return runProjection(this.current, jurisdiction);
  }

  /**
   * The accounts this plan implies, named and typed — the three standing ones plus a fund
   * account per goal. Derived from the plan, so a goal added a moment ago already has one.
   */
  accountDescriptors(): readonly PlanAccountDescriptor[] {
    return planAccountDescriptors(this.plan);
  }

  /**
   * "When can this household retire, and does the age it picked work?" — one cohesive query,
   * built in `./retirementOutlook`.
   *
   * Separate from {@link run} on purpose. `run` is one simulation; this is a *search* over many,
   * each at a candidate age — so a caller that only wants the graph never pays for it.
   */
  retirement(jurisdiction: Jurisdiction): RetirementOutlook {
    return buildRetirementOutlook(this.current, jurisdiction);
  }

  // Reads over authored state. Each delegates to the module that owns the thing being read, so
  // the plane a job sits on and the shape of a compiled expense line stay out of here.

  /**
   * What a job pays a month **as authored** — its starting salary, not what any given month
   * resolves to once growth, spans and overrides are applied.
   */
  jobMonthlyIncomeCents(jobId: string): Cents {
    return jobMonthlyIncomeCentsOf(this.state, jobId);
  }

  /** One job's elected pre-tax 401(k) fraction of gross; an absent election reads as 0. */
  jobDeferralFraction(jobId: string): number {
    return jobDeferralFractionOf(this.state, jobId);
  }

  /** The same, summed over one person's jobs — nobody holds a single privileged job. */
  personMonthlyIncomeCents(personId: PersonId): Cents {
    return personMonthlyIncomeCentsOf(this.state, personId);
  }

  /** Standing pay across every earner. Sizing a household's budget off one earner's is wrong. */
  householdMonthlyIncomeCents(): Cents {
    return householdMonthlyIncomeCentsOf(this.state);
  }

  /**
   * One person's pre-tax 401(k) deferral as a fraction of their gross, blended across their
   * jobs — each job elects its own, so the household-level figure is a weighted average and not
   * any one election. 0 when they earn nothing.
   */
  personDeferralFraction(personId: PersonId): number {
    return personDeferralFractionOf(this.state, personId);
  }

  /**
   * Every expense line resolved to what it is **at `month`**: base amount, any dated override
   * layered on, and the price growth accrued by then. The amounts come off the very series the
   * simulator charges, so an editor showing a month and the projection running it cannot drift.
   */
  expenseRowsAt(month: number): readonly ResolvedExpenseRow[] {
    return resolveExpenseRows(this.state, month);
  }

  /**
   * The timeline events a goal's fund account pays for — what blocks its deletion, in timeline
   * order. {@link removeGoal} refuses on the same reading; this is it asked ahead of time, so a
   * caller can say which events to fix first instead of only that it cannot.
   */
  eventsFundedByGoal(goalId: string): readonly LifeEvent[] {
    return projectionEventsFundedByGoal(this.state, goalId);
  }

  /**
   * The funding question against the ledger so far — which liquid accounts could pay a
   * money-out event at a month, and what a chosen set nets after tax. Built from the SAME
   * replay context and validation jurisdiction the affordability gate decides on, so an
   * authoring picker and the §4.5 down-payment gate can never tell the user different
   * stories. Read-only, like {@link run}.
   */
  funding(): FundingLookup {
    return projectionFunding(this.current, this.validationJurisdiction);
  }

  // State round-trip

  /**
   * The authoring state this handle wraps — the whole of what persists. Named for what it is:
   * a handle over state, not a serializer. Serializing `nextSeq` with it is what lets a
   * reloaded plan continue the sequence instead of colliding with an existing id.
   */
  toState(): ProjectionState {
    return this.state;
  }

  /**
   * Alias of {@link toState} kept because it is the JS protocol name: `JSON.stringify(projection)`
   * calls it automatically, so persistence keeps working without the caller reaching for
   * `toState()`. Discarding it would be a real loss.
   */
  toJSON(): ProjectionState {
    return this.toState();
  }

  /**
   * Open a handle over state that arrives from outside — a reload, a round-trip, an import. What
   * has to be true of it, and in what order, is `./authoring/restore`: the version gate, both
   * counters floored, then the replay proof.
   *
   * This is the SINGLE restoring path — there is no "trusted" variant that skips the flooring,
   * because {@link write} floors after every write anyway, so a skip would save one walk and
   * reopen the silent-collision hole. It is also the ONLY one: there is no variant taking a bare
   * `Scenario`, because such a call is this one with `nextSeq` unknown — which the flooring works
   * out anyway — and two entry points differing only in what they leave unsaid is how they end up
   * meaning different things.
   *
   * `jurisdiction` is supplied fresh here, not read back from the state: a jurisdiction is
   * behaviour and was never serialised. Required, the same as {@link fromInput} — a reload is
   * exactly where a forgotten argument would quietly downgrade an authoring gate.
   */
  static fromState(state: ProjectionState, jurisdiction: Jurisdiction): Projection {
    return new Projection(restoreState(state, jurisdiction), jurisdiction);
  }

  /**
   * Open an EMPTY projection: the plan's scalars and nothing else, ready to be built up with the
   * authoring methods (`addJob`, `addGoal`, `addBudgetLine`, `marry`, `takeLoan`, …).
   *
   * The imperative half of authoring, next to {@link fromInput}'s declarative one — same door,
   * same rules: every id is minted here, and nothing a caller passes can name one. Which to reach
   * for is a question about the caller, not the engine. A scenario already written down arrives
   * as a document; one being assembled a step at a time — a wizard, a REPL, a test building the
   * two entries it cares about — starts here and grows. `fromInput` is this plus the entries, and
   * says so: it opens with exactly this call.
   *
   * Returns a `Projection` rather than a result, because there is nothing here to refuse: with no
   * entries there are no refs to resolve, no events to gate and no ids to collide. Only
   * {@link fromInput} needs the `{ ok }` union, and only because a document can be wrong.
   *
   * {@link ScenarioScalars} are required in full — a retirement age or an inflation rate is a
   * product decision, and an engine defaulting them would answer a question nobody asked. They
   * are also the only things that must be settled up front: everything else is addable later, and
   * a scalar itself is revisable through {@link updatePlan}.
   */
  static init(scalars: ScenarioScalars, jurisdiction: Jurisdiction): Projection {
    // Through `fromState` rather than straight into the constructor: an empty state passes the
    // version and replay gates trivially, so routing it through them costs nothing and leaves
    // ONE door that adopts a state — no second, unchecked path to keep in step with the first.
    return Projection.fromState(emptyState(scalars), jurisdiction);
  }

  /**
   * Build a projection from a declarative, id-free {@link ScenarioInput}: every id is minted
   * through this handle's own counter, so no caller ever names one. The authoring counterpart to
   * {@link fromState} — that RESTORES state whose ids are already present and floors the counter
   * past them; this AUTHORS one, advancing the counter as it mints.
   *
   * The interpretation is `./authoring/fromInput`, which drives these very methods so each entry
   * lands through the same write-time gate a live edit does. An input names no ids at all, so
   * nothing there can collide with an id the counter will later issue; state that ARRIVES with
   * ids belongs to {@link fromState}.
   */
  static fromInput(input: ScenarioInput, jurisdiction: Jurisdiction): FromInputResult {
    return interpretScenarioInput(input, (scalars) => Projection.init(scalars, jurisdiction));
  }
}
