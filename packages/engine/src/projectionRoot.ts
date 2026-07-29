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

import type { Plan, GoalPlan } from "./plan";
import type { Job, JobIncomeOverride, JobPayChange, PersonId } from "./job";
import type { BudgetLine } from "./budgetLine";
import type { Scenario } from "./scenario";
import { scenarioOf, withPlan, withLedger } from "./scenario";
import type { NewLifeEvent } from "./ledger/eventTypes";
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
import { createProjectionBase, firstInsolventMonth, RETIREMENT_ID } from "./projectionBase";
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
 * Every {@link Job} field except the stable `id`. `ownerId` IS patchable, so an edit can
 * reassign a job to another household member — the same move the Jobs form makes by changing
 * the draft's owner.
 */
export type JobPatch = Partial<Omit<Job, "id">>;

/** Every {@link BudgetLine} field except the stable `id`. */
export type BudgetLinePatch = Partial<Omit<BudgetLine, "id">>;

/**
 * The plan's standing **scalars** — every {@link Plan} field except the three collections
 * (`goals`, `jobs`, `budgetLines`).
 *
 * The exclusion is the point, not tidiness: each collection has methods that mint stable ids
 * and enforce rules — {@link Projection.removeGoal} refuses while an event still spends from
 * a goal's fund account. A bare `Partial<Plan>` would let `updatePlan({ goals: [] })` walk
 * straight past that guard, so the one free-form setter is confined to the fields that carry
 * no such rule.
 */
export type PlanPatch = Partial<Omit<Plan, "goals" | "jobs" | "budgetLines">>;

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

  /**
   * The timeline as authored. Read-only, and the companion to {@link plan}: revising or
   * removing a transaction is addressed by id, so a caller has to be able to see the ids.
   */
  get ledger(): Ledger {
    return this.current.scenario.ledger;
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

  /**
   * Rewrite the job list through `f`. Every per-job edit routes through here, so "which job"
   * and "leave the rest alone" are answered once rather than in each setter.
   */
  private mapJobs(f: (job: Job) => Job): void {
    const plan = this.state.scenario.plan;
    this.commitPlan({ ...plan, jobs: plan.jobs.map(f) });
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
   * Rewrite one job's fields in place, keeping its `id`. A patch, not a whole job: the caller
   * names only what changes, so everything it does not name — the other salary fields, the
   * deferral's `fundAccountId` and employer match, accumulated {@link JobPayChange}s and
   * {@link JobIncomeOverride}s, any field added to {@link Job} later — carries through.
   *
   * Editing a job changes the income the projection base compiles, but never re-validates the
   * ledger: the affordability gate is an append-time check ({@link commitEvent}), so a
   * transaction already accepted stays accepted. A patch aimed at an id that is not a job is
   * a no-op plan swap.
   */
  updateJob(id: string, patch: JobPatch): void {
    this.mapJobs((j) => (j.id === id ? ({ ...j, ...patch } as Job) : j));
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

  /**
   * Set a job's pay in **monthly** cents, the denomination a person states income in;
   * {@link Job} stores the annualized figure. Shorthand for the `salary` half of
   * {@link updateJob}, leaving the growth rate alone.
   */
  setJobMonthlyIncome(id: string, monthlyCents: number): void {
    this.mapJobs((j) =>
      j.id === id ? { ...j, salary: { ...j.salary, startingSalaryCents: monthlyCents * 12 } } : j,
    );
  }

  /**
   * Set a job's pre-tax 401(k) deferral as a fraction of ITS gross (0..1). A fraction of 0
   * *removes* the deferral rather than recording a 0% one, and any fraction above 0 preserves
   * the funded account and employer match, which belong to the employment and not to the
   * elected rate. That asymmetry is why this exists beside {@link updateJob}, whose `deferral`
   * patch replaces the whole object.
   */
  setJobDeferralFraction(id: string, fraction: number): void {
    this.mapJobs((j) => {
      if (j.id !== id) return j;
      if (fraction <= 0) {
        const { deferral: _drop, ...rest } = j;
        return rest;
      }
      return {
        ...j,
        deferral: {
          deferralFraction: fraction,
          fundAccountId: j.deferral?.fundAccountId ?? RETIREMENT_ID,
          ...(j.deferral?.employerMatchFraction !== undefined
            ? { employerMatchFraction: j.deferral.employerMatchFraction }
            : {}),
        },
      };
    });
  }

  /**
   * Attach a permanent raise or cut, in force from its month forward. At most one per
   * (job, month) — a second at the same month replaces the first, so re-authoring is
   * idempotent rather than stacking.
   */
  addJobPayChange(jobId: string, payChange: JobPayChange): void {
    this.mapJobs((j) =>
      j.id === jobId
        ? {
            ...j,
            payChanges: [...(j.payChanges ?? []).filter((c) => c.month !== payChange.month), payChange],
          }
        : j,
    );
  }

  /** Drop the pay change at `month`, if any. The field goes away entirely once empty. */
  removeJobPayChange(jobId: string, month: number): void {
    this.mapJobs((j) => {
      if (j.id !== jobId || j.payChanges === undefined) return j;
      const kept = j.payChanges.filter((c) => c.month !== month);
      if (kept.length === 0) {
        const { payChanges: _drop, ...rest } = j;
        return rest;
      }
      return { ...j, payChanges: kept };
    });
  }

  /**
   * Attach a one-month income perturbation — a bonus, a missed paycheck, a correction. Where
   * {@link addJobPayChange} opens a new salary segment, this touches exactly one month. At
   * most one per (job, month).
   */
  addJobIncomeOverride(jobId: string, override: JobIncomeOverride): void {
    this.mapJobs((j) =>
      j.id === jobId
        ? {
            ...j,
            incomeOverrides: [
              ...(j.incomeOverrides ?? []).filter((o) => o.month !== override.month),
              override,
            ],
          }
        : j,
    );
  }

  /** Drop the one-month override at `month`, if any. The field goes away entirely once empty. */
  removeJobIncomeOverride(jobId: string, month: number): void {
    this.mapJobs((j) => {
      if (j.id !== jobId || j.incomeOverrides === undefined) return j;
      const kept = j.incomeOverrides.filter((o) => o.month !== month);
      if (kept.length === 0) {
        const { incomeOverrides: _drop, ...rest } = j;
        return rest;
      }
      return { ...j, incomeOverrides: kept };
    });
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

  /**
   * Rewrite one budget line's fields in place, keeping its `id`. A patch, so what it does not
   * name — the line's `span`, dated `overrides`, explicit `priority` — carries through; those
   * are timeline facts about the line, not part of what a form edits.
   *
   * `target` and `amountSource` are whole discriminated unions and are replaced entire when
   * patched: half a union is not a value, so switching an expense line to a contribution means
   * supplying the new `target` complete. A patch aimed at an id that is not a line is a no-op.
   */
  updateBudgetLine(id: string, patch: BudgetLinePatch): void {
    const plan = this.state.scenario.plan;
    const budgetLines = plan.budgetLines.map((l) =>
      l.id === id ? ({ ...l, ...patch } as BudgetLine) : l,
    );
    this.commitPlan({ ...plan, budgetLines });
  }

  /**
   * Drop a budget line. No guard: a line derives no account an event can reference. Removing
   * an id that is not a line is a no-op.
   */
  removeBudgetLine(id: string): void {
    const plan = this.state.scenario.plan;
    this.commitPlan({ ...plan, budgetLines: plan.budgetLines.filter((l) => l.id !== id) });
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

  /**
   * Patch the plan's standing scalars — opening balance, the return and inflation rates, the
   * health-cost fields, the ages, the household levers, the name. The collections are NOT
   * reachable from here (see {@link PlanPatch}): every goal / job / budget-line edit goes
   * through the method that mints its id and enforces its rules.
   */
  updatePlan(patch: PlanPatch): void {
    // Dropped at runtime, not only in the type: `Projection` is published, and a JavaScript
    // caller passing `{ goals: [] }` would otherwise spread straight past `removeGoal`'s
    // fund-account guard. A type that is the only guard is not a guard.
    const { goals: _g, jobs: _j, budgetLines: _b, ...scalars } = patch as Partial<Plan>;
    this.commitPlan({ ...this.state.scenario.plan, ...scalars });
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
   * The caller owns the incoming ledger's validity: this replays nothing, so it is the one
   * ledger write with no gate. Prefer the per-transaction methods for anything an authoring
   * flow does; reach for this only when the ledger arrives already-built.
   */
  resetLedger(ledger: Ledger): void {
    const s = this.state;
    this.commit({ ...s, scenario: withLedger(s.scenario, ledger) });
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
