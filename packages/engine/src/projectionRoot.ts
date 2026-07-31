/**
 * The `Projection` root — the high-level public API of `@finley/engine`; the functional
 * barrel (`interpretLedger`, `simulateHousehold`, …) remains the low-level surface.
 *
 * Standing edits (`addJob`) route to a {@link Plan}, ledger transactions (`buyHome`) to the
 * {@link Ledger}. Each write derives a new {@link ProjectionState}, so state already handed
 * out stays intact.
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
 * Every authorable thing is add / edit / remove, not add-only: a caller that can author a
 * goal, a job, a budget line or a transaction can also revise and retract it, so the API is a
 * full editor rather than an authoring funnel that has to be escaped through {@link fromState}.
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

import type { Plan, GoalPlan, GoalPatch, PlanPatch } from "./plan";
import { withGoalPatch, withGoalReordered, withoutGoal, withPlanPatch } from "./plan";
import type { Job, JobIncomeOverride, JobPatch, JobPayChange, PersonId } from "./job";
import {
  deferralFractionOf,
  mapJob,
  monthlyIncomeCentsOf,
  withDeferralFraction,
  withIncomeOverride,
  withJobPatch,
  withMonthlyIncome,
  withoutIncomeOverride,
  withoutPayChange,
  withPayChange,
} from "./job";
import type {
  BudgetCategory,
  BudgetLine,
  BudgetLineOverride,
  BudgetLinePatch,
  BudgetTarget,
} from "./budgetLine";
import { withLineOverride, withLinePatch, withoutLine } from "./budgetLine";
import { compileExpenseBudgetLines } from "./compileBudget";
import type { Scenario } from "./scenario";
import { scenarioOf, withPlan, withLedger } from "./scenario";
import type { LifeEvent, NewLifeEvent, RelationshipEvent } from "./ledger/eventTypes";
import { causedByEventId } from "./ledger/eventTypes";
import type { Ledger } from "./ledger/ledger";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import type { Person } from "./person";
import type { ProjectionSeries } from "./projection/simulate";
import type { LiabilityKind } from "./liability";
import type { GrowthMode } from "./cashFlowSeries";
import { addEvent, fundingLookup } from "./ledger/addEvent";
import type { FundingLookup } from "./ledger/addEvent";
import { removeEvent } from "./ledger/removeEvent";
import { updateEvent } from "./ledger/updateEvent";
import { eventsFundedByGoal, validateGoalRemoval } from "./goalFunding";
import {
  evaluateFullRetirementAtAge,
  projectScenarioParts,
  solveRetirement,
} from "./retirementSolver";
import type { RetirementEvaluation, RetirementSolution } from "./retirementTypes";
import { summarizeSimulation } from "./projection/report";
import type { SimulationReport } from "./projection/report";
import type { Household } from "./ledger/household";
import {
  buildPlanAccounts,
  buildPlanGoals,
  createProjectionBase,
  firstInsolventMonth,
  goalFundAccountId,
  planAccountDescriptors,
  PRIMARY_PERSON_ID,
} from "./projectionBase";
import {
  resolveRefs,
  WELL_KNOWN_REF_IDS,
  PRIMARY_PERSON_REF,
  RETIREMENT_REF,
} from "./scenarioRefs";
import { ref } from "./scenarioInput";
import type {
  FromInputResult,
  JobEntry,
  Ref,
  ScenarioInput,
  ScenarioScalars,
} from "./scenarioInput";
import type { PlanAccountDescriptor, ProjectionContext } from "./projectionBase";
import { buildSnapshot, membersAt } from "./projection/snapshot";
import type { HouseholdSnapshot } from "./projection/snapshot";
import { computeGoalProgress } from "./goal";
import type { GoalProgress, SimGoal } from "./goal";
import { assessDti, mortgagePaymentForPurchaseCents } from "./affordability";
import type { DtiAssessment } from "./affordability";
import { assessEarlyRetireeHealthCost } from "./earlyRetireeHealthCheck";
import type { EarlyRetireeHealthFlag } from "./earlyRetireeHealthCheck";
import type { Cents } from "./money";
// Type-only: with the validation jurisdiction required, this module no longer names a fallback.
import type { Jurisdiction } from "./jurisdiction";

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

/**
 * A job as a caller authors it — no `id` and no `ownerId`. The engine issues the id
 * ({@link Projection.addJob}, {@link Projection.addPartnerJob}) and the plane it lands on stamps
 * the owner. Relocating a job between members without re-minting is
 * {@link Projection.reassignJob}, which takes the existing id as an argument rather than letting
 * one ride in here.
 */
export type JobInput = Omit<Job, "id" | "ownerId">;

/**
 * A budget line as a caller authors it — no `id`. Unlike a job, a line is never handed between
 * owners and nothing outside the engine needs to choose its name, so there is no reason for a
 * caller to supply one: {@link Projection.addBudgetLine} always mints.
 */
export type BudgetLineInput = Omit<BudgetLine, "id">;

export type GoalInput = Omit<GoalPlan, "id">;

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
}

interface TakeLoanCommon {
  readonly month: number;
  readonly ownerId: PersonId;
  readonly openingBalanceCents: number;
  readonly apr: number;
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
}

/**
 * What may be changed about a transaction already in the log — its DATA, never its identity.
 *
 * One variant per authoring verb, discriminated on the same `type` names
 * {@link import("./scenarioInput").EventEntry} uses, so a revision states which kind of event it
 * expects and revising a loan as though it were a home is a refusal rather than nonsense. Every
 * field is optional: an absent one keeps what the event already says.
 *
 * No variant carries an id, and none carries a nested entity. The event id, the person a
 * marriage created and their jobs, the child, the liability, the property and its mortgage all
 * survive a revision untouched — {@link revisedEvent} rebuilds from the existing event rather
 * than from the caller, so identity is preserved by construction and a field added to an event
 * type is carried through without being re-listed here.
 *
 * Nested entities are added and removed through their own methods, which mint or target ids
 * properly: {@link Projection.addPartnerJob}, {@link Projection.removePartnerJob},
 * {@link Projection.replacePartnerJob}.
 *
 * The account fields (`downPaymentSourceIds`, `accountId`) name accounts that already exist —
 * target handles, the same ones {@link BuyHomeInput} and {@link PayOffDebtInput} take. They
 * mint nothing.
 */
export type TransactionRevision =
  | {
      readonly type: "marry";
      readonly month?: number;
      readonly name?: string;
      readonly birthYear?: number;
      readonly retirementTargetAge?: number;
      readonly benefitClaimingAge?: number;
    }
  | {
      readonly type: "haveChild";
      readonly month?: number;
      readonly name?: string;
      readonly birthMonth?: number;
      readonly annualCostCents?: Cents;
    }
  | {
      readonly type: "separate";
      readonly month?: number;
      readonly alimonyMonthlyCents?: Cents;
      readonly alimonyDurationMonths?: number;
      readonly childSupportMonthlyCents?: Cents;
    }
  | {
      /**
       * `kind` is fixed — a card and a term loan are different instruments, not one with a
       * different field set — so exactly one of `creditLimitCents`/`termMonths` applies, and
       * the other is refused rather than ignored.
       */
      readonly type: "takeLoan";
      readonly month?: number;
      readonly openingBalanceCents?: Cents;
      readonly apr?: number;
      readonly creditLimitCents?: Cents;
      readonly termMonths?: number;
    }
  | {
      readonly type: "buyHome";
      readonly month?: number;
      readonly purchasePriceCents?: Cents;
      readonly downPaymentCents?: Cents;
      readonly downPaymentSourceIds?: readonly string[];
      readonly mortgageApr?: number;
      readonly mortgageTermMonths?: number;
      readonly appreciationMode?: GrowthMode;
    }
  | {
      readonly type: "payOffDebt";
      readonly month?: number;
      readonly accountId?: string;
      readonly amountCents?: Cents;
    };

/** The event kind each revision verb addresses — the pairing `reviseTransaction` enforces. */
const REVISED_EVENT_TYPE: Record<TransactionRevision["type"], LifeEvent["type"]> = {
  marry: "RelationshipEvent",
  haveChild: "ChildEvent",
  separate: "SeparationEvent",
  takeLoan: "LoanEvent",
  buyHome: "HomePurchaseEvent",
  payOffDebt: "DebtPayoffEvent",
};

/**
 * Rebuild an event with a revision's named fields applied.
 *
 * Every arm spreads `current` first, so identity — the event's own id, `childId`,
 * `partnerPersonId`, `liabilityId`, `ownerId`, `propertyId`, `mortgageLiabilityId`, the person
 * and their jobs — is carried rather than re-listed. Only `sequenceNumber` is dropped, because
 * the ledger reassigns it. The revision's variant is known to match `current.type`:
 * {@link Projection.reviseTransaction} refuses the pairing before calling here, which is what
 * makes each cast below sound.
 */
function revisedEvent(current: LifeEvent, revision: TransactionRevision): NewLifeEvent {
  const { sequenceNumber: _reassigned, ...kept } = current;
  const at = <T extends TransactionRevision["type"]>(_t: T) =>
    revision as Extract<TransactionRevision, { type: T }>;

  switch (current.type) {
    case "RelationshipEvent": {
      const r = at("marry");
      return {
        ...kept,
        month: r.month ?? current.month,
        // The person is spread, so their id and their whole job list ride through untouched.
        person: {
          ...current.person,
          name: r.name ?? current.person.name,
          birthYear: r.birthYear ?? current.person.birthYear,
          retirementTargetAge: r.retirementTargetAge ?? current.person.retirementTargetAge,
          benefitClaimingAge: r.benefitClaimingAge ?? current.person.benefitClaimingAge,
        },
      } as NewLifeEvent;
    }
    case "ChildEvent": {
      const r = at("haveChild");
      return {
        ...kept,
        month: r.month ?? current.month,
        childName: r.name ?? current.childName,
        birthMonth: r.birthMonth ?? current.birthMonth,
        annualCostCents: r.annualCostCents ?? current.annualCostCents,
      } as NewLifeEvent;
    }
    case "SeparationEvent": {
      const r = at("separate");
      return {
        ...kept,
        month: r.month ?? current.month,
        alimonyMonthlyCents: r.alimonyMonthlyCents ?? current.alimonyMonthlyCents,
        alimonyDurationMonths: r.alimonyDurationMonths ?? current.alimonyDurationMonths,
        childSupportMonthlyCents: r.childSupportMonthlyCents ?? current.childSupportMonthlyCents,
      } as NewLifeEvent;
    }
    case "LoanEvent": {
      const r = at("takeLoan");
      const wrongArm =
        current.kind === "creditCard" ? r.termMonths !== undefined : r.creditLimitCents !== undefined;
      if (wrongArm) {
        throw new Error(
          `Projection: cannot revise transaction — a ${current.kind} loan takes ` +
            `${current.kind === "creditCard" ? "creditLimitCents" : "termMonths"}, not the other`,
        );
      }
      const common = {
        ...kept,
        month: r.month ?? current.month,
        openingBalanceCents: r.openingBalanceCents ?? current.openingBalanceCents,
        apr: r.apr ?? current.apr,
      };
      return (
        current.kind === "creditCard"
          ? { ...common, creditLimitCents: r.creditLimitCents ?? current.creditLimitCents }
          : { ...common, termMonths: r.termMonths ?? current.termMonths }
      ) as NewLifeEvent;
    }
    case "HomePurchaseEvent": {
      const r = at("buyHome");
      const appreciationMode = r.appreciationMode ?? current.appreciationMode;
      return {
        ...kept,
        month: r.month ?? current.month,
        purchasePriceCents: r.purchasePriceCents ?? current.purchasePriceCents,
        downPaymentCents: r.downPaymentCents ?? current.downPaymentCents,
        downPaymentSourceIds: r.downPaymentSourceIds ?? current.downPaymentSourceIds,
        mortgageApr: r.mortgageApr ?? current.mortgageApr,
        mortgageTermMonths: r.mortgageTermMonths ?? current.mortgageTermMonths,
        ...(appreciationMode !== undefined ? { appreciationMode } : {}),
      } as NewLifeEvent;
    }
    case "DebtPayoffEvent": {
      const r = at("payOffDebt");
      return {
        ...kept,
        month: r.month ?? current.month,
        accountId: r.accountId ?? current.accountId,
        amountCents: r.amountCents ?? current.amountCents,
      } as NewLifeEvent;
    }
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
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
}

/**
 * One pipeline pass under a specific jurisdiction, frozen. Carries every artifact the pass
 * produces so a caller answers the graph, the snapshot roster, and the debug report from a
 * SINGLE simulation — the {@link household} the snapshot reads and the {@link report} the
 * debug panel shows are derived from the very {@link series} the chart draws, never a re-run.
 */
export interface ProjectionResult {
  readonly jurisdictionId: string;
  readonly series: ProjectionSeries;
  /** First month the shortfall cascade exhausted all credit, or `null` if solvent throughout. */
  readonly firstInsolventMonth: number | null;
  /** The interpreted roster the snapshot panel and owner picker read. */
  readonly household: Household;
  /** The debug panel / download view of this run — summarized off {@link series}, not a second pass. */
  readonly report: SimulationReport;

  // Reads over this pass. Methods rather than more fields, because each is a question a
  // caller asks about ONE month or ONE goal — computing all of them eagerly would price
  // every run at the cost of every panel. They close over the artifacts above, so no
  // caller has to hold `household` and `series` side by side to ask.

  /** Household cross-section at `month` — who is present, what is owned, what is owed. */
  readonly snapshot: (month: number) => HouseholdSnapshot;
  /** Who is in the household at `month`; a partner joins and leaves on their own dates. */
  readonly membersAt: (month: number) => Person[];
  /**
   * Every plan goal beside how it is tracking against THIS run, in funding-priority order.
   * Paired, because a row needs both and the two lists are index-aligned only by construction.
   */
  readonly goalProgress: () => readonly { readonly goal: SimGoal; readonly progress: GoalProgress }[];
  /** The soft debt-to-income read on a purchase that has not been authored yet. */
  readonly assessHomePurchase: (input: HomePurchaseInput) => HomePurchaseAssessment;
}

/** A purchase being *considered* — the same numbers a `buyHome` transaction would carry. */
export interface HomePurchaseInput {
  /** The month it would land; gross income and existing debt are read there. */
  readonly month: number;
  readonly purchasePriceCents: Cents;
  readonly downPaymentCents: Cents;
  /** Fractional annual rate (0.065), matching `HomePurchaseEvent.mortgageApr`. */
  readonly apr: number;
  readonly termMonths: number;
}

/**
 * The soft guideline read, never a gate: authoring a home purchase is refused on funding, not
 * on debt-to-income, so this classifies and the caller decides whether to say anything.
 */
export interface HomePurchaseAssessment {
  readonly assessment: DtiAssessment;
  /** The level monthly mortgage payment the purchase would add. */
  readonly monthlyMortgageCents: Cents;
  /** Gross monthly income the ratios are measured against (0 → nothing is flagged). */
  readonly monthlyGrossCents: Cents;
  /** True when either the front- or back-end guideline is exceeded. */
  readonly exceeded: boolean;
}

/** What {@link Projection.retirement} answers: the whole retirement question, in one value. */
export interface RetirementOutlook {
  /** The earliest ages the search reached, partial and full; `null` where the money runs out. */
  readonly solution: RetirementSolution;
  /**
   * {@link solution}'s full-retirement age as months from "now", or `null` with the age — what
   * a chart draws its retirement reference line at.
   */
  readonly fullRetirementMonth: number | null;
  /**
   * The plan's own `retirementAge`, evaluated as a full retirement. `nearestFeasibleAge` is
   * resolved here: the pinned age when it survives, else the earliest age the same search
   * found.
   */
  readonly target: RetirementEvaluation;
  /** Whether retiring on this plan opens a pre-coverage health gap, and how large. */
  readonly earlyRetireeHealth: EarlyRetireeHealthFlag;
}

/** One expense line as it stands at a month. See {@link Projection.expenseRowsAt}. */
export interface ResolvedExpenseRow {
  readonly lineId: string;
  readonly label: string;
  readonly category: BudgetCategory;
  /** In that month's dollars — the figure the projection charges and the graph draws. */
  readonly monthlyCents: Cents;
  /** True when a dated override, rather than the base amount, is what is showing. */
  readonly overridden: boolean;
}

/**
 * Owner tag for the throwaway compilation behind {@link Projection.expenseRowsAt}. Expense
 * owners are inert in the pipeline; the preview never reaches a simulation.
 */
const EXPENSE_PREVIEW_OWNER = "expense-preview";

/**
 * Feed the guideline arithmetic the household's real numbers at the purchase month: gross
 * income is every active income stream's rate, and the debt already being serviced is the
 * projected month's scheduled liability payments — 0 where nothing is owed or the month sits
 * past the horizon. Housing counts only the new mortgage; total debt counts it on top of the
 * rest. With zero gross income {@link assessDti} flags nothing, so an unearning month cannot
 * produce a divide-by-zero warning.
 */
function assessHomePurchase(
  household: Household,
  series: ProjectionSeries,
  input: HomePurchaseInput,
): HomePurchaseAssessment {
  const monthlyMortgageCents = mortgagePaymentForPurchaseCents(
    input.purchasePriceCents,
    input.downPaymentCents,
    input.apr,
    input.termMonths,
  );
  const monthlyGrossCents = buildSnapshot(household, input.month, series).income.reduce(
    (sum, s) => sum + s.monthlyCents,
    0,
  );
  const existingDebtCents = series.months[input.month]?.flows?.liabilityPaymentsCents ?? 0;
  const assessment = assessDti(
    monthlyGrossCents,
    monthlyMortgageCents,
    existingDebtCents + monthlyMortgageCents,
  );
  return {
    assessment,
    monthlyMortgageCents,
    monthlyGrossCents,
    exceeded: assessment.frontEndExceeded || assessment.backEndExceeded,
  };
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
 * Issue the next id. `<kind>-<n>` off ONE counter shared by every kind, so a job, a goal and a
 * loan can never be handed the same number and an id says what it names.
 *
 * There is no override: no authoring input carries an `id`, so identity has a single source.
 * Ids that arrive from OUTSIDE — an imported state, an event a revision introduces — never pass
 * through here at all; {@link seqFloor} steps the counter past those instead.
 */
function mint(state: ProjectionState, kind: MintedKind): { id: string; nextSeq: number } {
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
 * RESTORED data can invalidate.
 *
 * Restored is the whole of it: authoring mints, so nothing an authoring call produces can be
 * ahead of the counter. Ids reach a scenario without passing through {@link mint} only when
 * {@link Projection.fromState} adopts state that already holds them — which is why that is the
 * one place this runs on the way in.
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
    const plan = this.planSite("jobs", id);
    this.commitPlan({ ...plan, jobs: mapJob(plan.jobs, id, f) });
  }

  /**
   * The plan, once it is known to hold `id` in `collection` — or a refusal naming the id.
   *
   * An edit aimed at something that is not there is a caller error, not a smaller edit: the id
   * came from somewhere that no longer agrees with this state, so the write the caller believes
   * it made has not happened. One contract across every authored collection and both planes
   * ({@link partnerJobSite} for a partner's jobs), so a caller never has to know which kind of
   * thing it asked for in order to handle the answer.
   */
  private planSite(collection: "jobs" | "goals" | "budgetLines", id: string): Plan {
    const plan = this.state.scenario.plan;
    const noun = collection === "budgetLines" ? "budget line" : collection.slice(0, -1);
    if (!plan[collection].some((entry: { id: string }) => entry.id === id)) {
      throw new Error(`Projection: cannot edit a ${noun} — no ${noun} "${id}" on this plan`);
    }
    return plan;
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
    const s = this.state;
    const { id, nextSeq } = mint(s, "job");
    const newJob: Job = { ...job, id, ownerId: personId };
    this.commitPlan({ ...s.scenario.plan, jobs: [...(s.scenario.plan.jobs ?? []), newJob] }, nextSeq);
    return id;
  }

  /**
   * Rewrite one job wholesale, keeping its `id` and its list position — the counterpart to
   * {@link updateJob}'s field-wise patch, for a caller holding a whole new definition rather
   * than a diff.
   *
   * The difference is what an *absent* field means. A patch carries only what it names, so it
   * can never clear a field; this replaces, so a job arriving with no `deferral` and no `name`
   * comes out with neither. That is what a form re-submitted with the 401(k) rate zeroed and
   * the name blanked has to mean.
   *
   * `ownerId` stays as it was — reassignment is a two-plane move, not a field edit (a partner's
   * jobs do not live on the plan at all). Refused for an id the plan does not hold.
   */
  replaceJob(id: string, job: JobInput): void {
    this.editJob(id, (prior) => ({ ...job, id: prior.id, ownerId: prior.ownerId }));
  }

  /**
   * Rewrite one job's fields in place, keeping its `id` — see {@link withJobPatch} for what
   * carries through.
   *
   * Editing a job changes the income the projection base compiles, but never re-validates the
   * ledger: the affordability gate is an append-time check ({@link commitEvent}), so a
   * transaction already accepted stays accepted. That matches the app, whose gate also fires
   * only on append. Refused for an id the plan does not hold.
   */
  updateJob(id: string, patch: JobPatch): void {
    this.editJob(id, (j) => withJobPatch(j, patch));
  }

  /**
   * Drop a job. Unlike {@link removeGoal} there is nothing to guard: a job derives no account
   * an event can reference, so no ledger reference can dangle. Refused for an id the plan does
   * not hold.
   */
  removeJob(id: string): void {
    const plan = this.planSite("jobs", id);
    this.commitPlan({ ...plan, jobs: plan.jobs.filter((j) => j.id !== id) });
  }

  // Jobs on the other plane
  //
  // A household member's jobs live on one of two planes, and which one is a fact about the
  // member, not about the edit: the primary person's are standing plan data, a partner's ride
  // the `RelationshipEvent` that brought them into the household. The methods above write the
  // first plane; the four below write the second, through the same replay-validated path
  // {@link reviseTransaction} uses.
  //
  // They exist so that no caller ever has to rebuild `event.person.jobs` itself: that array is
  // the whole authoring surface of a partner's income, and rebuilding it outside this class
  // means minting ids off a counter this class does not control.

  /** The `RelationshipEvent` a partner joined on, or a refusal naming the person. */
  private relationshipFor(personId: PersonId): RelationshipEvent {
    for (const event of this.state.scenario.ledger.events) {
      if (event.type === "RelationshipEvent" && event.person.id === personId) return event;
    }
    throw new Error(
      `Projection: cannot author a partner job — no partner "${personId}" in this timeline`,
    );
  }

  /** The event and job for a partner-owned job id, or a refusal naming the id — see
   * {@link planSite} for why an id that is not there is refused rather than skipped. */
  private partnerJobSite(jobId: string): { event: RelationshipEvent; job: Job } {
    for (const event of this.state.scenario.ledger.events) {
      if (event.type !== "RelationshipEvent") continue;
      const job = event.person.jobs.find((j) => j.id === jobId);
      if (job !== undefined) return { event, job };
    }
    throw new Error(
      `Projection: cannot edit a partner job — no partner holds a job "${jobId}"`,
    );
  }

  /**
   * Commit a partner's rewritten job list. Routed through {@link updateEvent} — the same
   * whole-ledger replay {@link reviseTransaction} validates with — so a revision that would
   * strand a later event is refused with the state untouched, and the ledger and the counter
   * land as ONE new state (a refused write consumes no id).
   */
  private commitPartnerJobs(
    event: RelationshipEvent,
    jobs: readonly Job[],
    nextSeq?: number,
  ): void {
    const s = this.state;
    const next: NewLifeEvent = { ...event, person: { ...event.person, jobs } };
    const result = updateEvent(s.scenario.ledger, event.id, next, this.baseConfig());
    if (!result.ok) {
      throw new Error(`Projection: cannot revise transaction — ${result.conflict}`);
    }
    this.commit({
      ...s,
      scenario: withLedger(s.scenario, result.ledger),
      ...(nextSeq !== undefined ? { nextSeq } : {}),
    });
  }

  /**
   * Add a job to a partner — the ledger-plane counterpart of {@link addJob}, returning the
   * minted `"job-N"` id.
   *
   * The id comes off the SAME counter every other minted id does, in the same `job-N` shape:
   * one namespace across both planes, which is what lets {@link seqFloor} recognize a partner's
   * job on the way back in and step the counter past it.
   *
   * The id is always minted; a caller cannot name a job. Moving an EXISTING job onto this
   * plane keeps its id, and is {@link reassignJob} — which names that id as an argument rather
   * than accepting one here.
   */
  addPartnerJob(personId: PersonId, job: JobInput): string {
    const event = this.relationshipFor(personId);
    const { id, nextSeq } = mint(this.state, "job");
    const newJob: Job = { ...job, id, ownerId: personId };
    this.commitPartnerJobs(event, [...event.person.jobs, newJob], nextSeq);
    return id;
  }

  /**
   * Rewrite one partner-owned job wholesale, keeping its id, owner and list position — see
   * {@link replaceJob}, of which this is the ledger-plane counterpart, for why an absent field
   * clears rather than carries through.
   */
  replacePartnerJob(jobId: string, job: JobInput): void {
    const { event } = this.partnerJobSite(jobId);
    this.commitPartnerJobs(
      event,
      event.person.jobs.map((j) =>
        j.id === jobId ? ({ ...job, id: j.id, ownerId: j.ownerId } as Job) : j,
      ),
    );
  }

  /**
   * Hand a job to another household member, keeping its `id` — and with it every adjustment
   * addressed by that id: one-month income overrides, permanent pay changes, the employer match.
   *
   * This is the ONE operation that needs an already-issued job id, and it takes it as an
   * argument rather than letting one ride in on a {@link JobInput}, so authoring a job and
   * relocating one stay different verbs and no caller can name a job into existence.
   *
   * A move crosses the two planes — the primary person's jobs are standing plan data, a
   * partner's ride their `RelationshipEvent` — so it is a removal from one and a landing on the
   * other. Both happen here, in that order (the id is never live in both places), and the target
   * member is proved to exist BEFORE the source gives the job up, so a bad owner cannot strip a
   * job from whoever holds it. A refusal from either plane throws with the handle discarded, so
   * a job can never end up in neither list.
   *
   * `job` carries the fields the move lands with, so a form that re-owns a job and edits it is
   * one write. An `ownerId` is not among them: the target names the owner.
   */
  reassignJob(jobId: string, toOwnerId: PersonId, job: JobInput): void {
    // Proved BEFORE the source gives the job up: a member is either the primary person, whose
    // jobs are standing plan data, or a partner, whose ride their `RelationshipEvent`. Anyone
    // else is not in the household, and a job handed to them would vanish from both planes.
    const toPartner = this.isPartner(toOwnerId);
    if (!toPartner && toOwnerId !== PRIMARY_PERSON_ID) {
      throw new Error(
        `Projection: cannot reassign a job — no household member "${toOwnerId}" to own it`,
      );
    }

    const plan = this.state.scenario.plan;
    if (plan.jobs.some((j) => j.id === jobId)) {
      this.commitPlan({ ...plan, jobs: plan.jobs.filter((j) => j.id !== jobId) });
    } else {
      // Refuses an id neither plane holds, naming it.
      const { event } = this.partnerJobSite(jobId);
      this.commitPartnerJobs(
        event,
        event.person.jobs.filter((j) => j.id !== jobId),
      );
    }

    const landed: Job = { ...job, id: jobId, ownerId: toOwnerId };
    if (toPartner) {
      // Re-read: the removal above committed a new state, so the event captured before it is
      // stale.
      const event = this.relationshipFor(toOwnerId);
      this.commitPartnerJobs(event, [...event.person.jobs, landed]);
    } else {
      const after = this.state.scenario.plan;
      this.commitPlan({ ...after, jobs: [...after.jobs, landed] });
    }
  }

  /** Whether this member's jobs live on the ledger plane — i.e. they joined as a partner. */
  private isPartner(personId: PersonId): boolean {
    return this.state.scenario.ledger.events.some(
      (e) => e.type === "RelationshipEvent" && e.person.id === personId,
    );
  }

  /** Apply one of `job`'s authoring transforms to a partner-owned job — see {@link editJob}. */
  private editPartnerJob(jobId: string, f: (job: Job) => Job): void {
    const { event } = this.partnerJobSite(jobId);
    this.commitPartnerJobs(
      event,
      event.person.jobs.map((j) => (j.id === jobId ? f(j) : j)),
    );
  }

  /** See {@link updateJob} — the field-wise patch, on a partner's plane. */
  updatePartnerJob(jobId: string, patch: JobPatch): void {
    this.editPartnerJob(jobId, (j) => withJobPatch(j, patch));
  }

  /** Drop a partner-owned job. See {@link removeJob}: there is nothing to guard. */
  removePartnerJob(jobId: string): void {
    const { event } = this.partnerJobSite(jobId);
    this.commitPartnerJobs(
      event,
      event.person.jobs.filter((j) => j.id !== jobId),
    );
  }

  // Adjustments to ONE job, addressed by its id alone.
  //
  // Owner-aware: one counter issues job ids across both planes, so an id names one job in the
  // household or nothing at all — "give job-3 a raise" has one answer, and the caller does not
  // have to know which plane job-3 is authored on to ask for it. The methods that CREATE or
  // replace a job stay plane-explicit, because creating one needs the person it belongs to.

  /** Whichever plane holds `jobId`, or a refusal naming it. */
  private editJobAnywhere(jobId: string, f: (job: Job) => Job): void {
    if (this.state.scenario.plan.jobs.some((j) => j.id === jobId)) {
      this.editJob(jobId, f);
      return;
    }
    for (const event of this.state.scenario.ledger.events) {
      if (event.type !== "RelationshipEvent") continue;
      if (event.person.jobs.some((j) => j.id === jobId)) {
        this.editPartnerJob(jobId, f);
        return;
      }
    }
    throw new Error(`Projection: cannot edit a job — no job "${jobId}" in this household`);
  }

  /** See {@link withMonthlyIncome} — monthly cents in, annualized salary stored. */
  setJobMonthlyIncome(id: string, monthlyCents: number): void {
    this.editJobAnywhere(id, (j) => withMonthlyIncome(j, monthlyCents));
  }

  /**
   * See {@link withDeferralFraction}. It exists beside {@link updateJob} because 0 *removes*
   * the deferral and a positive fraction preserves the funded account and employer match —
   * an asymmetry a `deferral` patch, which replaces the whole object, cannot express.
   */
  setJobDeferralFraction(id: string, fraction: number): void {
    this.editJobAnywhere(id, (j) => withDeferralFraction(j, fraction));
  }

  /** See {@link withPayChange} — a permanent raise or cut, at most one per (job, month). */
  addJobPayChange(jobId: string, payChange: JobPayChange): void {
    this.editJobAnywhere(jobId, (j) => withPayChange(j, payChange));
  }

  /** See {@link withoutPayChange}. */
  removeJobPayChange(jobId: string, month: number): void {
    this.editJobAnywhere(jobId, (j) => withoutPayChange(j, month));
  }

  /** See {@link withIncomeOverride} — a one-month perturbation, not a new salary segment. */
  addJobIncomeOverride(jobId: string, override: JobIncomeOverride): void {
    this.editJobAnywhere(jobId, (j) => withIncomeOverride(j, override));
  }

  /** See {@link withoutIncomeOverride}. */
  removeJobIncomeOverride(jobId: string, month: number): void {
    this.editJobAnywhere(jobId, (j) => withoutIncomeOverride(j, month));
  }

  /** Returns the minted `"line-N"` id — always minted; a caller cannot name a line. */
  addBudgetLine(line: BudgetLineInput): string {
    const s = this.state;
    const { id, nextSeq } = mint(s, "line");
    const newLine: BudgetLine = { id, ...line };
    const plan = s.scenario.plan;
    this.commitPlan({ ...plan, budgetLines: [...plan.budgetLines, newLine] }, nextSeq);
    return id;
  }

  /**
   * See {@link withLinePatch} — span, dated overrides and priority carry through. Refused for
   * an id the plan does not hold.
   */
  updateBudgetLine(id: string, patch: BudgetLinePatch): void {
    const plan = this.planSite("budgetLines", id);
    this.commitPlan({ ...plan, budgetLines: withLinePatch(plan.budgetLines, id, patch) });
  }

  /**
   * Layer a dated amount override onto one line — the "just this month" / "from here forward"
   * answer, which is a fact about the line rather than a new authored amount (see
   * {@link withLineOverride} for the one-per-(scope, month) rule).
   *
   * Beside {@link updateBudgetLine} rather than inside it: a patch REPLACES the `overrides`
   * array it is given, so routing an override through one would drop every other dated change
   * on the line unless the caller re-sent them all — exactly the read-modify-write this API
   * exists to keep out of callers.
   */
  addBudgetLineOverride(lineId: string, override: BudgetLineOverride): void {
    const plan = this.planSite("budgetLines", lineId);
    this.commitPlan({ ...plan, budgetLines: withLineOverride(plan.budgetLines, lineId, override) });
  }

  /**
   * Drop a budget line. Nothing to guard beyond its existence: a line derives no account an
   * event can reference, so no ledger reference can dangle.
   */
  removeBudgetLine(id: string): void {
    const plan = this.planSite("budgetLines", id);
    this.commitPlan({ ...plan, budgetLines: withoutLine(plan.budgetLines, id) });
  }

  /** Appended, so lowest funding priority. Returns the minted `"goal-N"` id. */
  addGoal(goal: GoalInput): string {
    const s = this.state;
    const { id, nextSeq } = mint(s, "goal");
    const newGoal = { id, ...goal } as GoalPlan;
    const plan = s.scenario.plan;
    this.commitPlan({ ...plan, goals: [...plan.goals, newGoal] }, nextSeq);
    return id;
  }

  /**
   * See {@link withGoalPatch}. Editing keeps the `id`, so the `fund-<id>` fund account is
   * stable and no funding reference can dangle — which is why, unlike {@link removeGoal}, this
   * needs no funding guard. Refused for an id the plan does not hold.
   */
  updateGoal(id: string, patch: GoalPatch): void {
    const plan = this.planSite("goals", id);
    this.commitPlan({ ...plan, goals: withGoalPatch(plan.goals, id, patch) });
  }

  /**
   * Drop a goal and, with it, the derived fund account that is its balance. REFUSED while
   * any event still spends from that account: the account would vanish out from under a
   * reference the ledger keeps, so the removal is a no-op and this throws with the state
   * untouched — the same contract {@link commitEvent} gives a refused transaction.
   *
   * Removing a goal that no event funds is a plain plan swap; an id the plan does not hold is
   * refused like any other edit. Callers wanting to ask before acting call
   * {@link validateGoalRemoval}.
   */
  removeGoal(id: string): void {
    const plan = this.planSite("goals", id);
    const check = validateGoalRemoval(plan.goals, id, this.state.scenario.ledger);
    if (!check.ok) {
      throw new Error(`Projection: cannot remove goal — ${check.reason}`);
    }
    this.commitPlan({ ...plan, goals: withoutGoal(plan.goals, id) });
  }

  /**
   * See {@link withGoalReordered}. {@link addGoal} only appends, so this is the sole way an
   * API caller reprioritizes a goal after authoring it.
   *
   * Refused at the ends, like any other edit that cannot happen: "move the first goal up" is a
   * caller believing it changed the funding order when it did not, and priority IS the order.
   * A UI offering the control disables it there rather than calling and ignoring the answer.
   */
  reorderGoal(id: string, direction: "up" | "down"): void {
    const plan = this.planSite("goals", id);
    const index = plan.goals.findIndex((g) => g.id === id);
    const edge = direction === "up" ? 0 : plan.goals.length - 1;
    if (index === edge) {
      const place = direction === "up" ? "first" : "last";
      throw new Error(`Projection: cannot reorder goal — "${id}" is already ${place}`);
    }
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
   * The replay context every ledger write validates against: the plan compiled under the
   * construction-time {@link validationJurisdiction}, so a jurisdiction-gated authoring check
   * sees the same numbers the app does rather than the tax-free `nullJurisdiction` answer.
   */
  private baseConfig(): LedgerBaseConfig {
    const s = this.state;
    return createProjectionBase(s.scenario.plan, {
      jurisdiction: this.validationJurisdiction,
      startYear: s.startYear,
    });
  }

  /**
   * Validates through {@link addEvent} — including the affordability gate, run under the
   * construction-time {@link validationJurisdiction} so the §4.5 down-payment check nets funds
   * after that jurisdiction's tax — and commits ledger and post-mint `nextSeq` as ONE new state.
   * On failure it throws with the state untouched, so a refused transaction consumes no id.
   */
  private commitEvent(event: NewLifeEvent, nextSeq: number): void {
    const s = this.state;
    const result = addEvent(
      s.scenario.ledger,
      this.baseConfig(),
      event,
      this.validationJurisdiction,
    );
    if (!result.ok) {
      throw new Error(`Projection: cannot apply transaction — ${result.conflict}`);
    }
    this.commit({ ...s, scenario: withLedger(s.scenario, result.ledger), nextSeq });
  }

  /** Returns the minted `"person-N"` id. */
  marry(input: MarryInput): string {
    const { id, nextSeq: afterPerson } = mint(this.state, "person");
    // One counter, threaded person → jobs: each job mints against the seq the previous mint
    // left, so the partner and their jobs draw distinct ids from the same monotonic run. The
    // owner is `id` — the person minted just above — because a partner's jobs belong to the
    // person this call creates, never to the caller.
    let nextSeq = afterPerson;
    const jobs: Job[] = (input.jobs ?? []).map((job) => {
      const minted = mint({ ...this.state, nextSeq }, "job");
      nextSeq = minted.nextSeq;
      return { ...job, id: minted.id, ownerId: id };
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
    const { id, nextSeq } = mint(this.state, "child");
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
    const { id, nextSeq } = mint(this.state, "separation");
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
    const { id, nextSeq } = mint(this.state, "payoff");
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
    const { id, nextSeq } = mint(this.state, "loan");
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
   * The mortgage liability id derives from the minted property id, parent-suffixed
   * (`<propertyId>-mortgage`) so a sort groups it under its home. Subject to the down-payment
   * hard block.
   */
  buyHome(input: BuyHomeInput): string {
    const { id, nextSeq } = mint(this.state, "home");
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
        mortgageLiabilityId: `${id}-mortgage`,
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
   * Revise a transaction's DATA in place — its amounts, its month, the names on it — keeping
   * its id, its place in the log, and every identity it carries. Without this, anything
   * authored *on* an event is write-once.
   *
   * The revision names only what changes ({@link TransactionRevision}); it cannot carry an id,
   * a person, a job list or any other nested entity, and the event is rebuilt from what is
   * already in the log rather than from the caller. So a revision can no more re-point a
   * `liabilityId` or swap a partner's job list than it can rename the event. Nested entities are
   * added and removed through their own methods, which mint and target ids properly.
   *
   * `type` is fixed as well as `id` — dependencies are tracked by id, meaning by type — so a
   * revision that names the wrong verb for the event is refused rather than reinterpreted.
   * Changing either means a different event: remove and add instead.
   *
   * Validation is the whole-ledger replay {@link removeTransaction} runs, so a revision that
   * would strand a later event is refused and names it; there is no affordability gate, which
   * fires only on append.
   */
  reviseTransaction(id: string, revision: TransactionRevision): void {
    const s = this.state;
    const current = s.scenario.ledger.events.find((e) => e.id === id);
    if (current === undefined) {
      throw new Error(`Projection: cannot revise transaction — no transaction "${id}"`);
    }
    const expected = REVISED_EVENT_TYPE[revision.type];
    if (current.type !== expected) {
      throw new Error(
        `Projection: cannot revise transaction — "${id}" is a ${current.type}, ` +
          `which a "${revision.type}" revision does not address`,
      );
    }
    const result = updateEvent(s.scenario.ledger, id, revisedEvent(current, revision), this.baseConfig());
    if (!result.ok) {
      throw new Error(`Projection: cannot revise transaction — ${result.conflict}`);
    }
    this.commit({ ...s, scenario: withLedger(s.scenario, result.ledger) });
  }

  // Run

  /**
   * Read-only — never swaps the current state. Delegates to {@link projectScenarioParts}, the
   * pipeline the chart and solver panel already share, and summarizes the report off the same
   * series so the debug view reuses the run the chart drew rather than simulating twice.
   *
   * `meta` echoes the whole authored plan plus the run's jurisdiction id, so knobs the sim
   * input compiles away — life expectancy, retirement age, health lines — survive into the
   * report and its download.
   */
  run(jurisdiction: Jurisdiction): ProjectionResult {
    const s = this.state;
    const { household, simInput, series } = projectScenarioParts(s.scenario, {
      jurisdiction,
      startYear: s.startYear,
    });
    const report = summarizeSimulation(
      simInput,
      series,
      { plan: s.scenario.plan, jurisdictionId: jurisdiction.id },
      jurisdiction,
    );
    const plan = s.scenario.plan;
    return Object.freeze({
      jurisdictionId: jurisdiction.id,
      series,
      firstInsolventMonth: firstInsolventMonth(series),
      household,
      report,
      snapshot: (month: number) => buildSnapshot(household, month, series),
      membersAt: (month: number) => membersAt(household, month),
      goalProgress: () => {
        const accounts = buildPlanAccounts(plan);
        return buildPlanGoals(plan).map((goal) => ({
          goal,
          progress: computeGoalProgress(goal, series, accounts),
        }));
      },
      assessHomePurchase: (input: HomePurchaseInput) =>
        assessHomePurchase(household, series, input),
    });
  }

  /**
   * The accounts this plan implies, named and typed — the three standing ones plus a fund
   * account per goal. Derived from the plan, so a goal added a moment ago already has one.
   */
  accountDescriptors(): readonly PlanAccountDescriptor[] {
    return planAccountDescriptors(this.plan);
  }

  /**
   * The context the retirement searches run in. Their own question, not {@link run}'s: each
   * re-simulates the scenario at a *candidate* retirement age, so none of them can be answered
   * off a completed pass — which is why {@link retirement} is a separate call and `run` never
   * pays for one it was not asked for.
   */
  private projectionContext(jurisdiction: Jurisdiction): ProjectionContext {
    return { jurisdiction, startYear: this.state.startYear };
  }

  /**
   * The pre-coverage health gap: retiring before the jurisdiction's public-coverage age with an
   * authored health line under the self-funded benchmark. Priced in **today's dollars** — at
   * the plan's own start year rather than indexed out to the retirement year — because the
   * authored line it is compared against is today's-dollars too, and pitting a nominal cost
   * against a real budget would flag every plan. Never fires at or after the coverage age.
   *
   * A jurisdiction naming no coverage age has no gap window at all, so the flag stays quiet
   * rather than treating "unknown" as "never covered".
   */
  private earlyRetireeHealth(jurisdiction: Jurisdiction): EarlyRetireeHealthFlag {
    const plan = this.plan;
    return assessEarlyRetireeHealthCost({
      retirementAge: plan.retirementAge,
      publicHealthCoverageAge: jurisdiction.publicHealthCoverageAge ?? 0,
      authoredHealthMonthlyCents: plan.healthMonthlyCents,
      selfFundedBenchmarkMonthlyCents:
        jurisdiction.healthCostBenchmarkMonthlyCents?.({
          age: plan.retirementAge,
          year: this.state.startYear,
        }) ?? 0,
    });
  }

  /**
   * One cohesive public query over one scenario and one context: "when can this household
   * retire, and does the age it picked work?" Internally it performs both the search for the
   * earliest feasible ages and the evaluation at the plan's target age; neither is a separate
   * call a caller can make, because neither is a separate answer.
   *
   * Cohesive because the parts are not independent. The target's fallback when the pinned age
   * fails is an age the SAME search found, so a caller assembling the pieces itself would have
   * to re-derive that rule — which is how a panel and a chart come to disagree about a
   * household that cannot retire at all.
   *
   * Separate from {@link run} on purpose. `run` is one simulation; this is a *search* over
   * many, each at a candidate age — so a caller that only wants the graph never pays for it.
   */
  retirement(jurisdiction: Jurisdiction): RetirementOutlook {
    const ctx = this.projectionContext(jurisdiction);
    const plan = this.plan;
    const solution = solveRetirement(this.state.scenario, ctx);
    const evaluation = evaluateFullRetirementAtAge(this.state.scenario, plan.retirementAge, ctx);
    return Object.freeze({
      solution,
      // The headline is the FULL retirement age: everyone stops all their jobs.
      fullRetirementMonth:
        solution.fullRetirementAge === null
          ? null
          : Math.max(0, (solution.fullRetirementAge - plan.currentAge) * 12),
      target: {
        ...evaluation,
        // One rule for the pin and its fallback: an age the plan cannot reach falls back to the
        // earliest age the same search found, so the two can never name different households.
        nearestFeasibleAge: evaluation.feasible
          ? evaluation.retirementAge
          : solution.fullRetirementAge,
      },
      earlyRetireeHealth: this.earlyRetireeHealth(jurisdiction),
    });
  }

  /**
   * Every job in the household, both planes at once: the primary person's stand on the plan, a
   * partner's ride the {@link RelationshipEvent} that brought them in. Ownership is on the job,
   * so a caller reading pay or deferral never has to know which plane it came off.
   */
  private householdJobs(): readonly Job[] {
    const s = this.state.scenario;
    const jobs: Job[] = [...s.plan.jobs];
    for (const event of s.ledger.events) {
      if (event.type === "RelationshipEvent") jobs.push(...event.person.jobs);
    }
    return jobs;
  }

  /**
   * What a job pays a month **as authored** — its starting salary, not what any given month
   * resolves to once growth, spans and overrides are applied. That is deliberately the figure a
   * job's headline shows: a dated change is listed beside it rather than folded into it.
   */
  jobMonthlyIncomeCents(jobId: string): Cents {
    return monthlyIncomeCentsOf(this.jobOrThrow(jobId));
  }

  /** A job id names one job across both planes, or it names nothing — never a silent 0. */
  private jobOrThrow(jobId: string): Job {
    const job = this.householdJobs().find((j) => j.id === jobId);
    if (job === undefined) {
      throw new Error(`Projection: cannot read a job — no job "${jobId}" in this household`);
    }
    return job;
  }

  /**
   * One job's elected pre-tax 401(k) fraction of gross. Absent election reads as 0, so a
   * caller never has to distinguish "no deferral" from "deferring nothing" — the read
   * counterpart of {@link setJobDeferralFraction}, which erases a 0 rather than recording it.
   */
  jobDeferralFraction(jobId: string): number {
    return deferralFractionOf(this.jobOrThrow(jobId));
  }

  /** The same, summed over one person's jobs — nobody holds a single privileged job. */
  personMonthlyIncomeCents(personId: PersonId): Cents {
    return this.householdJobs()
      .filter((j) => j.ownerId === personId)
      .reduce((sum, j) => sum + monthlyIncomeCentsOf(j), 0);
  }

  /** Standing pay across every earner. Sizing a household's budget off one earner's is wrong. */
  householdMonthlyIncomeCents(): Cents {
    return this.householdJobs().reduce((sum, j) => sum + monthlyIncomeCentsOf(j), 0);
  }

  /**
   * One person's pre-tax 401(k) deferral as a fraction of their gross, blended across their
   * jobs — each job elects its own, so the household-level figure is a weighted average and not
   * any one election. 0 when they earn nothing.
   */
  personDeferralFraction(personId: PersonId): number {
    const jobs = this.householdJobs().filter((j) => j.ownerId === personId);
    const grossCents = jobs.reduce((sum, j) => sum + j.salary.startingSalaryCents, 0);
    if (grossCents <= 0) return 0;
    const deferredCents = jobs.reduce(
      (sum, j) => sum + j.salary.startingSalaryCents * deferralFractionOf(j),
      0,
    );
    return deferredCents / grossCents;
  }

  /**
   * Every expense line resolved to what it is **at `month`**: base amount, any dated override
   * layered on, and the price growth accrued by then. The amounts come off the very series the
   * simulator charges, so an editor showing a month and the projection running it cannot drift.
   *
   * Resolved rows, not the compiled series they are read from: a caller wants the number and
   * whether an override is what is showing, and the compiler's `SimOwnedSeries` is an internal
   * with a lifetime and an owner tag that mean nothing outside the pipeline.
   *
   * Contribution lines are absent by construction — they pay a literal amount into an account
   * and have no month-resolved value to preview.
   */
  expenseRowsAt(month: number): readonly ResolvedExpenseRow[] {
    const plan = this.plan;
    const lines = plan.budgetLines.filter((line) => line.target.kind === "expense");
    const compiled = new Map(
      compileExpenseBudgetLines(lines, EXPENSE_PREVIEW_OWNER, plan.inflationPct / 100).map((s) => [
        s.lineId,
        s.series,
      ]),
    );
    return lines.map((line) => ({
      lineId: line.id,
      label: line.label,
      category: line.category,
      monthlyCents: compiled.get(line.id)?.getMonthlyCents(month) ?? 0,
      overridden: (line.overrides ?? []).some(
        (o) =>
          (o.scope === "thisMonthOnly" && o.month === month) ||
          (o.scope === "fromHereForward" && o.month <= month),
      ),
    }));
  }

  /**
   * The timeline events a goal's fund account pays for — what blocks its deletion, in timeline
   * order. {@link removeGoal} refuses on the same reading; this is it asked ahead of time, so a
   * caller can say which events to fix first instead of only that it cannot.
   */
  eventsFundedByGoal(goalId: string): readonly LifeEvent[] {
    const s = this.state.scenario;
    return eventsFundedByGoal(s.plan.goals, goalId, s.ledger);
  }

  /**
   * The funding question against the ledger so far — which liquid accounts could pay a
   * money-out event at a month, and what a chosen set nets after tax. Built from the SAME
   * {@link baseConfig} and {@link validationJurisdiction} the affordability gate decides on,
   * so an authoring picker and the §4.5 down-payment gate can never tell the user different
   * stories. Read-only, like {@link run}.
   */
  funding(): FundingLookup {
    return fundingLookup(this.state.scenario.ledger, this.baseConfig(), this.validationJurisdiction);
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
   * Open a handle over state that arrives from outside — a reload, a round-trip, an import.
   * Both counters are normalized on the way in rather than trusted: a serialized state is the
   * least trustworthy input the API takes — through JSON, possibly hand-edited or truncated,
   * possibly written by a build whose counters meant something else. A stale `nextSeq` beside
   * a plan holding `job-5` would mint `job-5` again on the first write.
   *
   * Normalization only ever RAISES a counter, and is idempotent from the second pass on, so a
   * reload can never walk one upward. It is not quite an identity on a freshly authored state:
   * both counters share one floor ({@link seqFloor}) but `commit` maintains only `nextSeq` as a
   * write lands, so restoring is where `Ledger.nextSequenceNumber` catches up to it. Raising it
   * is always safe — the invariant is "strictly above every event" — and it reissues nothing.
   *
   * This is the SINGLE flooring path — there is no "trusted" variant that skips it, because
   * `commit` floors after every write anyway, so a skip would save one walk and reopen the
   * silent-collision hole.
   *
   * It is also the ONLY restoration api: there is no variant taking a bare `Scenario`, because
   * such a call is this one with `nextSeq` unknown — which the flooring works out anyway — and
   * two entry points differing only in what they leave unsaid is how they end up meaning
   * different things.
   *
   * `jurisdiction` is supplied fresh here, not read back from the state: a jurisdiction is
   * behaviour and was never serialised. Required, the same as {@link fromInput} — a reload is
   * exactly where a forgotten argument would quietly downgrade an authoring gate.
   */
  static fromState(state: ProjectionState, jurisdiction: Jurisdiction): Projection {
    return new Projection(withNormalizedCounters(state), jurisdiction);
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
    const { startYear, ...plan } = scalars;
    // The counter opens at 1 and the normalization has nothing to floor past: an empty projection
    // is the one state that provably holds no id at all.
    return Projection.fromState(
      { scenario: scenarioOf({ ...plan, jobs: [], goals: [], budgetLines: [] }), startYear, nextSeq: 1 },
      jurisdiction,
    );
  }

  /**
   * Build a projection from a declarative, id-free {@link ScenarioInput}: every id is minted
   * through this handle's own counter, so no caller ever names one. The authoring counterpart to
   * {@link fromState} — that RESTORES state whose ids are already present and floors the counter
   * past them; this AUTHORS one, advancing the counter as it mints.
   *
   * Two phases, mirroring {@link resolveRefs}'s resolution model. First the plan plane
   * (`jobs`, `goals`, `budgetLines`) — no month, applied as one block through the standing-edit
   * methods; then `events` in the month-sorted `order` {@link resolveRefs} returns, each applied
   * through the matching authoring method so its write-time gate (an unaffordable down payment,
   * separating before marrying) fires exactly as it does for a live edit. No {@link validateLedger}
   * gate here: this path validates per event as it mints, not the whole ledger after the fact.
   *
   * Refs are translated to ids through a registry filled as entries apply, seeded so a well-known
   * ref ({@link WELL_KNOWN_REF_IDS}) resolves to itself. `resolveRefs` has already proved every
   * ref resolves at the point it is used, so a lookup miss here is an engine bug, not a bad
   * document — surfaced as a thrown internal error rather than a refusal. The registry is local to
   * this call and dies with it: a ref names things while the document is being applied and is
   * never written into `Plan` or `Ledger`.
   *
   * An input names no ids at all, so nothing here can collide with an id the counter will later
   * issue. State that ARRIVES with ids — a reload, a round-trip through {@link toJSON} — belongs
   * to {@link fromState}, which floors the counter past them instead of minting.
   *
   * All-or-nothing: the handle is local until the last write lands, so a refused document — a bad
   * ref graph, or any refusal a method raises — returns `{ ok: false }` naming the offending entry
   * and yields no partial projection.
   */
  static fromInput(input: ScenarioInput, jurisdiction: Jurisdiction): FromInputResult {
    const resolved = resolveRefs(input);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    // Everything but the entry planes and the frozen `startYear` IS the plan's scalars; the three
    // id-bearing collections start EMPTY and are filled by the minting methods below. That is
    // what makes this an authoring path: the state it starts from holds no id at all, so the
    // normalization `fromState` applies has nothing to floor past and the counter opens at 1.
    const { jobs, goals, budgetLines, events: _events, ...scalars } = input;
    const projection = Projection.init(scalars, jurisdiction);

    const registry = new Map<Ref, string>();
    for (const id of WELL_KNOWN_REF_IDS) registry.set(ref(id), id);
    const idFor = (name: Ref): string => {
      const id = registry.get(name);
      if (id === undefined) throw new Error(`fromInput: ref "${name}" was accepted but never bound`);
      return id;
    };
    const bind = (name: Ref | undefined, id: string): void => {
      if (name !== undefined) registry.set(name, id);
    };

    // An id-free job to a {@link JobInput}: the deferral's account ref becomes an account id
    // (absent, it funds the standing 401(k)). `ownerRef` is resolved by the caller — a plan job
    // names its owner, a partner's job takes the owner `marry` mints — so it is dropped here.
    const toJobInput = (job: JobEntry): JobInput => {
      const { ref: _ref, ownerRef: _ownerRef, deferral, ...rest } = job;
      if (deferral === undefined) return rest;
      const { fundAccountRef, ...deferralRest } = deferral;
      return { ...rest, deferral: { ...deferralRest, fundAccountId: idFor(fundAccountRef ?? RETIREMENT_REF) } };
    };

    const refusal = (reason: string): FromInputResult => ({ ok: false, error: { reason } });
    const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

    try {
      // Goals before jobs and budget lines: both can name a goal's fund account, and a goal
      // points at nothing, so this order binds every account ref before it is read. The plan
      // plane is mutually visible in `resolveRefs`, but application still needs a valid topological
      // order, and goals-first is one.
      for (const goal of goals ?? []) {
        const { ref, ...rest } = goal;
        bind(ref, goalFundAccountId({ ...rest, id: projection.addGoal(rest) }));
      }
      for (const job of jobs ?? []) {
        bind(job.ref, projection.addJob(idFor(job.ownerRef ?? PRIMARY_PERSON_REF), toJobInput(job)));
      }
      for (const line of budgetLines ?? []) {
        const { ref, target, ...rest } = line;
        const resolvedTarget: BudgetTarget =
          target.kind === "account"
            ? { kind: "account", accountId: idFor(target.accountRef), taxTreatment: target.taxTreatment }
            : { kind: "expense" };
        bind(ref, projection.addBudgetLine({ ...rest, target: resolvedTarget }));
      }
    } catch (e) {
      return refusal(messageOf(e));
    }

    for (const { entry, index } of resolved.order) {
      try {
        switch (entry.type) {
          case "marry":
            bind(
              entry.ref,
              projection.marry({
                month: entry.month,
                name: entry.name,
                birthYear: entry.birthYear,
                ...(entry.retirementTargetAge !== undefined ? { retirementTargetAge: entry.retirementTargetAge } : {}),
                ...(entry.benefitClaimingAge !== undefined ? { benefitClaimingAge: entry.benefitClaimingAge } : {}),
                ...(entry.jobs !== undefined ? { jobs: entry.jobs.map(toJobInput) } : {}),
              }),
            );
            break;
          case "haveChild":
            bind(
              entry.ref,
              projection.haveChild({
                month: entry.month,
                name: entry.name,
                annualCostCents: entry.annualCostCents,
                ...(entry.birthMonth !== undefined ? { birthMonth: entry.birthMonth } : {}),
              }),
            );
            break;
          case "takeLoan": {
            const common = {
              month: entry.month,
              ownerId: idFor(entry.ownerRef),
              openingBalanceCents: entry.openingBalanceCents,
              apr: entry.apr,
            };
            bind(
              entry.ref,
              projection.takeLoan(
                entry.kind === "creditCard"
                  ? { ...common, kind: "creditCard", creditLimitCents: entry.creditLimitCents }
                  : { ...common, kind: entry.kind, termMonths: entry.termMonths },
              ),
            );
            break;
          }
          case "buyHome":
            bind(
              entry.ref,
              projection.buyHome({
                month: entry.month,
                ownerId: idFor(entry.ownerRef),
                purchasePriceCents: entry.purchasePriceCents,
                downPaymentCents: entry.downPaymentCents,
                downPaymentSourceIds: entry.downPaymentSourceRefs.map(idFor),
                mortgageApr: entry.mortgageApr,
                mortgageTermMonths: entry.mortgageTermMonths,
                ...(entry.appreciationMode !== undefined ? { appreciationMode: entry.appreciationMode } : {}),
              }),
            );
            break;
          case "separate":
            bind(
              entry.ref,
              projection.separate({
                month: entry.month,
                partnerPersonId: idFor(entry.partnerRef),
                ...(entry.alimonyMonthlyCents !== undefined ? { alimonyMonthlyCents: entry.alimonyMonthlyCents } : {}),
                ...(entry.alimonyDurationMonths !== undefined ? { alimonyDurationMonths: entry.alimonyDurationMonths } : {}),
                ...(entry.childSupportMonthlyCents !== undefined ? { childSupportMonthlyCents: entry.childSupportMonthlyCents } : {}),
              }),
            );
            break;
          case "payOffDebt":
            bind(
              entry.ref,
              projection.payOffDebt({
                month: entry.month,
                liabilityId: idFor(entry.liabilityRef),
                accountId: idFor(entry.accountRef),
                amountCents: entry.amountCents,
              }),
            );
            break;
          default: {
            const exhaustive: never = entry;
            return exhaustive;
          }
        }
      } catch (e) {
        return {
          ok: false,
          error: { reason: messageOf(e), eventIndex: index, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) },
        };
      }
    }

    return { ok: true, projection };
  }
}

// ---------------------------------------------------------------------------
// The facade's vocabulary
// ---------------------------------------------------------------------------
//
// What an application may name. `Projection` is the whole authoring surface and the whole
// read surface over authored state, but a caller still has to spell the types its methods
// take and return, quote a well-known id, and turn a number a user typed into cents. Those
// are re-exported here so that ONE module states an app's entire dependency on the engine —
// and so adding to it is a deliberate edit with a reason beside it.
//
// The line, drawn once: if answering the question needs the projection — the plan, the
// ledger, the household, the run — it is a METHOD above, and it returns what the caller
// actually wanted rather than a compiler artifact to finish assembling. What appears below
// could not be a method without inventing a reason to hold one: a unit conversion with no
// state to convert against, a label for an enum value, an id the engine names.
//
// Nothing that WRITES appears here, and nothing that writes may be added. The authoring
// transforms (`withPayChange`, `withGoalPatch`, `addEvent`, `updateEvent`, …) stay on the
// functional barrel, where the engine's own internals and its tests reach them. An app that
// could import one would have a second write path around the id counter, the goal-funding
// guard and the affordability gate — which is the arrangement this module exists to replace.

// The authored model, and the artifacts a run produces.
export type { Plan, PlanPatch, GoalPlan, GoalPatch, GoalAccountType, SurplusCashDestination } from "./plan";
// The declarative, id-free authoring input {@link fromInput} consumes, and the result it
// answers with — how seed data and presets describe a whole scenario without naming an id.
export type { ScenarioInput, FromInputResult } from "./scenarioInput";
export type {
  Job,
  JobPatch,
  JobDeferral,
  JobIncomeOverride,
  JobPayChange,
  PersonId,
  SalaryTrajectory,
} from "./job";
export type { Person } from "./person";
export type { SimGoal, GoalProgress, GoalCompletion, GoalDisposal, GoalDisposition } from "./goal";
export type {
  BudgetLine,
  BudgetLinePatch,
  BudgetLineOverride,
  BudgetCategory,
  TaxTreatment,
} from "./budgetLine";
export type { Scenario } from "./scenario";
export type { Ledger } from "./ledger/ledger";
export type { LifeEvent, NewLifeEvent, RelationshipEvent } from "./ledger/eventTypes";
export type { Household } from "./ledger/household";
export type { FundingLookup } from "./ledger/addEvent";
export type { FundingAvailability, FundingSourceBalance } from "./ledger/interpretState";
export type { HouseholdSnapshot, SnapshotSeries } from "./projection/snapshot";
export type { ProjectionSeries, ProjectionMonth, IncomeSourceCategory } from "./projection/simulate.types";
export type { SharedContributionScheme } from "./projection/waterfall.types";
export type { SpendingItem } from "./projection/spendingItems";
export type { SimulationReport } from "./projection/report";
export type { PlanAccountDescriptor, ProjectionContext } from "./projectionBase";
export type { RetirementEvaluation, RetirementSolution } from "./retirementTypes";
export type { EarlyRetireeHealthFlag } from "./earlyRetireeHealthCheck";
export type { DtiAssessment } from "./affordability";
export type { LiabilityKind } from "./liability";
export type { Jurisdiction } from "./jurisdiction";
export type { Cents } from "./money";

// Money as the user types it. Neither reads nor writes anything — a form has cents to hand
// the facade before there is any state for the facade to hold, so a `Projection` method
// would be an instance in search of a use.
export { dollarsToCents, centsToDollars } from "./cashFlowSeries";

// A total function of one enum value, with no projection to ask.
export { liabilityKindLabel } from "./liability";

// Ids and thresholds the engine owns and an app has to quote back: the primary person, the
// standing accounts, the synthetic revolving card, and the DTI guidelines a warning cites.
export { RETIREMENT_ID } from "./ids";
export { PRIMARY_PERSON_ID, CONTRIBUTION_TARGETS } from "./projectionBase";
export { SYNTHETIC_CARD_ID } from "./liability";
export { DTI_FRONT_END_THRESHOLD, DTI_BACK_END_THRESHOLD } from "./affordability";

// Declarative authoring: the app's seed plans and starter scenarios are `ScenarioInput`
// documents, so they need the entry types, the `ref` constructor that names things inside one,
// and the pre-branded refs for what the engine provides rather than the document declaring it.
// Naming these is not reaching past the facade — `fromInput` is a facade method, and an input
// carries no ids, so nothing here lets a caller author identity.
export type { BudgetLineEntry, JobEntry, GoalEntry, EventEntry } from "./scenarioInput";
export { ref } from "./scenarioInput";
export {
  PRIMARY_PERSON_REF,
  SAVINGS_REF,
  RETIREMENT_REF,
  BROKERAGE_REF,
  SYNTHETIC_CARD_REF,
} from "./scenarioRefs";
