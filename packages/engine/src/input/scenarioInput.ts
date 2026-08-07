/**
 * The declarative, **ID-free** authoring entry point for the engine: one JSON-shaped value
 * describing a whole scenario — plan *and* timeline — which `Projection.fromInput` consumes,
 * minting every id internally.
 *
 * `ScenarioInput` is an entry point, NOT a replacement for {@link Plan}. `Plan` keeps its ids —
 * it is what `Projection` holds and the simulator compiles. This type only describes how to
 * build one, and the name is deliberate: `Scenario` is already this codebase's word for
 * plan-plus-ledger, and this input covers **both** planes. A partner cannot exist without the
 * relationship event that creates them, so `marry` is an `events` entry, not plan data — there
 * is no plan-only version of this type.
 *
 * Where an ID would appear in `Plan`/`Ledger`, a {@link Ref} appears here instead. A `ref` is a
 * build-time-only, author-chosen name: entries that CREATE something may declare one, entries
 * that POINT at something use it (`ownerRef`, `liabilityRef`, `accountRef`, …), never an id. It
 * never lands in `Plan` or `Ledger`, so it cannot collide with an id or outlive the build.
 *
 * **No entry may name an id.** There is no pin, no override, no escape hatch: `Projection`'s own
 * authoring methods mint every durable id off the shared counter, which is what makes the counter
 * the single authority for identity. An input that wants two entries connected says so with a
 * ref, and reads the minted id back off the built `Plan`/`Ledger`.
 *
 * This is an AUTHORING api, not an import one. Restoring persisted state — ids already issued,
 * counter already advanced — is {@link import("../facade/projectionFacade").Projection.fromState}'s job
 * (fed by `toJSON`); it takes a whole `ProjectionState` and floors the counter past everything it
 * holds. Reach for that when the ids matter, and for this when the scenario is being described
 * for the first time.
 */

import { PRE_NOW_MONTH } from "../projection/nowMarker";
import type { Plan, GoalPlan } from "../plan/plan";
import type { Person } from "../plan/person";
import type { Job, JobDeferral } from "../job/job";
import type { BudgetLine, TaxTreatment } from "../budget/budgetLine";
import type { LiabilityKind } from "../liability/liability";
import type { OriginableLoanKind } from "../authoring/liabilities";
import type { GrowthMode } from "../money/cashFlowSeries";
// Type-only, and cyclic: `Projection` imports these authoring types, so a value import back
// would close the loop. `FromInputResult` names the class only in a field, which a type import
// resolves without a runtime edge.
import type { Projection } from "../facade/projectionFacade";

declare const REF_BRAND: unique symbol;

/**
 * An author-chosen, build-time-only name for something declared in a {@link ScenarioInput}.
 *
 * Branded, so the distinction from an id is real at compile time rather than a comment: a bare
 * `string` — and in particular an id read off a live `Plan` — will not type-check in a `Ref`
 * position, so a pointer field cannot be handed an id by mistake. The brand exists only in the
 * type system; at runtime a `Ref` IS its string.
 *
 * Build one with {@link ref}. The handful of names that address something the engine provides
 * rather than something the document declares are exported pre-branded from `./scenarioRefs`
 * ({@link import("./scenarioRefs").PRIMARY_PERSON_REF} and friends), so fixtures reach for a
 * constant instead of wrapping a raw id.
 */
export type Ref = string & { readonly [REF_BRAND]: true };

/**
 * Name something in a {@link ScenarioInput}. The name is arbitrary and local to one document —
 * it is matched against the other refs in that same input and then discarded, so two documents
 * may freely use the same names and neither leaks into `Plan` or `Ledger`.
 */
export function ref(name: string): Ref {
  return name as Ref;
}

/**
 * Every {@link Plan} field except `goals`/`budgetLines`, which become entries, and `primary`
 * itself — the primary's own scalars (`name`, `birthYear`, `lifeExpectancy`,
 * `benefitClaimingAge`) are flattened back in below, minus `id` (the engine's to mint — always
 * {@link import("../compile/projectionBase").PRIMARY_PERSON_ID}), `jobs` (its own entry plane,
 * {@link ScenarioInput.jobs}) and `continuationJobId` (an id INTO that plane, so it becomes
 * {@link ScenarioInput.continuationJobRef}). A document has no ids to point with.
 */
type PlanScalars = Omit<Plan, "goals" | "budgetLines" | "primary"> &
  Omit<Person, "id" | "jobs" | "continuationJobId">;

/**
 * The `"account"` arm of a {@link import("../budget/budgetLine").BudgetTarget}, but pointing at an
 * account by {@link Ref} rather than id — a contribution line names the standing account it
 * funds ("retirement"), which the build resolves to a real account id.
 */
export type BudgetTargetInput =
  | { readonly kind: "expense" }
  | { readonly kind: "account"; readonly accountRef: Ref; readonly taxTreatment: TaxTreatment };

/**
 * A {@link Job} authored without ids. `ownerRef` defaults to the primary person, so a plain
 * job needs no ref at all; the `deferral`'s funded account is named by {@link Ref}, since a
 * deferral routes into an account the same way a contribution line does.
 */
export interface JobEntry extends Omit<Job, "id" | "ownerId" | "deferral"> {
  readonly ref?: Ref;
  /** Defaults to the primary person. */
  readonly ownerRef?: Ref;
  readonly deferral?: Omit<JobDeferral, "fundAccountId"> & { readonly fundAccountRef?: Ref };
}

/**
 * A {@link GoalPlan} authored without its id. A ref naming this goal resolves to its DERIVED
 * fund account, not to the goal itself — `goalFundAccountId(goal)` — so a contribution or
 * payoff can target where the goal accumulates without a separate account entry.
 */
export interface GoalEntry extends Omit<GoalPlan, "id"> {
  readonly ref?: Ref;
}

/**
 * A {@link BudgetLine} authored without its id, its `target` swapped for the ref-bearing
 * {@link BudgetTargetInput}.
 */
export interface BudgetLineEntry extends Omit<BudgetLine, "id" | "target"> {
  readonly ref?: Ref;
  readonly target: BudgetTargetInput;
}

/**
 * Fields every {@link EventEntry} shares: its build-time `ref` and the month it applies at. No
 * `id` — the authoring method the entry routes through mints one (and, for `takeLoan`/`buyHome`,
 * the liability or property id with it).
 */
interface EventEntryCommon {
  readonly ref?: Ref;
  readonly month: number;
}

/**
 * A job nested inside a {@link MarryEntry} — a {@link JobEntry} with no `ownerRef`.
 *
 * Ownership is implicit and cannot be otherwise: these jobs belong to the partner the very same
 * entry creates, and that person does not exist until the marriage applies, so there is nothing
 * an author could name. Omitting the field rather than ignoring it means the compiler says so,
 * instead of a stated owner being quietly overwritten.
 *
 * `ownerRef?: never` rather than a bare `Omit`, because `Omit` alone only stops a fresh object
 * LITERAL: excess-property checking does not apply to a value that arrives through a variable,
 * so a `JobEntry` built elsewhere and handed in would assign structurally and have its owner
 * dropped in silence — the exact failure this type exists to prevent. Declaring the field as
 * `never` makes it a type error either way.
 */
export type PartnerJobEntry = Omit<JobEntry, "ownerRef"> & {
  readonly ownerRef?: never;
};

/** The incoming partner and their ref-authored jobs — see {@link import("../authoring/relationships").MarryInput}. */
export interface MarryEntry extends EventEntryCommon {
  readonly type: "marry";
  readonly name: string;
  readonly birthYear: number;
  readonly benefitClaimingAge?: number;
  /**
   * See {@link import("../authoring/relationships").MarryInput.lifeExpectancy} — required, and
   * never defaulted from the primary's.
   */
  readonly lifeExpectancy: number;
  readonly jobs?: readonly PartnerJobEntry[];
}

/** A child joining the household — see {@link import("../authoring/relationships").HaveChildInput}. */
export interface HaveChildEntry extends EventEntryCommon {
  readonly type: "haveChild";
  readonly name: string;
  readonly annualCostCents: number;
  readonly birthMonth?: number;
}

/**
 * A partner already present at start — an anchor keyed on how long the household has been
 * together, see {@link import("../authoring/relationships").StartPartneredInput}. It carries no
 * `month`: {@link EventEntryCommon} supplies one, but the entry's own `partneredForMonths` is what
 * dates the anchor, so any `month` an author wrote would be ignored. Omitting it (`?: never`)
 * makes that a type error rather than a silent drop.
 */
export interface StartPartneredEntry extends Omit<EventEntryCommon, "month"> {
  readonly type: "startPartnered";
  readonly month?: never;
  readonly partneredForMonths: number;
  readonly name: string;
  readonly birthYear: number;
  readonly benefitClaimingAge?: number;
  /**
   * See {@link import("../authoring/relationships").MarryInput.lifeExpectancy} — required, and
   * never defaulted from the primary's.
   */
  readonly lifeExpectancy: number;
  readonly jobs?: readonly PartnerJobEntry[];
}

/**
 * A child already born — an anchor keyed on the child's age, see
 * {@link import("../authoring/relationships").HaveExistingChildInput}. Like {@link StartPartneredEntry}
 * its month is computed from `ageMonths`, so it declares no `month`.
 */
export interface HaveExistingChildEntry extends Omit<EventEntryCommon, "month"> {
  readonly type: "haveExistingChild";
  readonly month?: never;
  readonly name: string;
  readonly ageMonths: number;
  readonly annualCostCents: number;
}

/**
 * A loan already on the books — a holding opened at the now marker with current terms, see
 * {@link import("../authoring/liabilities").CarryLoanInput}. Its month is the now marker, not an
 * author choice, so like the anchors above it declares no `month`.
 */
export type CarryLoanEntry = Omit<EventEntryCommon, "month"> & {
  readonly type: "carryLoan";
  readonly month?: never;
  readonly ownerRef: Ref;
  readonly balanceCents: number;
  readonly apr: number;
} & (
    | { readonly kind: "creditCard"; readonly creditLimitCents: number }
    | { readonly kind: Exclude<LiabilityKind, "creditCard">; readonly remainingTermMonths: number }
  );

/**
 * A new liability. The discriminant is `type: "takeLoan"`; the loan's OWN `kind` (card vs term)
 * is a second, independent discriminant — which is precisely why {@link EventEntry} keys on
 * `type`, not `kind`: `kind` is already spoken for here.
 */
export type TakeLoanEntry = EventEntryCommon & {
  readonly type: "takeLoan";
  readonly ownerRef: Ref;
  readonly openingBalanceCents: number;
  readonly apr: number;
} & (
    | { readonly kind: "creditCard"; readonly creditLimitCents: number }
    | {
        readonly kind: Exclude<OriginableLoanKind, "creditCard">;
        readonly termMonths: number;
      }
  );

/**
 * A home already owned at start — a holding opened at the now marker with its current value and,
 * when mortgaged, the mortgage's current balance and remaining term, see
 * {@link import("../authoring/housing").OwnHomeInput}. Like the anchors and {@link CarryLoanEntry}
 * its month is the now marker, not an author choice, so it declares no `month`. Owned outright
 * omits `mortgage`.
 */
export type OwnHomeEntry = Omit<EventEntryCommon, "month"> & {
  readonly type: "ownHome";
  readonly month?: never;
  readonly ownerRef: Ref;
  readonly valueCents: number;
  readonly mortgage?: {
    readonly balanceCents: number;
    readonly remainingTermMonths: number;
    readonly apr: number;
  };
  /** Behavior-free basis metadata for a future sale — read by no current-balance logic. */
  readonly acquiredMonth?: number;
  readonly originalPriceCents?: number;
  readonly appreciationMode?: GrowthMode;
};

/** A home purchase — see {@link import("../authoring/housing").BuyHomeInput}. */
export interface BuyHomeEntry extends EventEntryCommon {
  readonly type: "buyHome";
  readonly ownerRef: Ref;
  readonly purchasePriceCents: number;
  readonly downPaymentCents: number;
  /** Liquid accounts drained for the down payment, in order — each a {@link Ref}. */
  readonly downPaymentSourceRefs: readonly Ref[];
  readonly mortgageApr: number;
  readonly mortgageTermMonths: number;
  readonly appreciationMode?: GrowthMode;
}

/**
 * A partner leaving — see {@link import("../authoring/relationships").SeparateInput}. Mints only an
 * event id and creates no entity, so its `ref` matters only if something later addresses the
 * event itself.
 */
export interface SeparateEntry extends EventEntryCommon {
  readonly type: "separate";
  readonly partnerRef: Ref;
  readonly alimonyMonthlyCents?: number;
  readonly alimonyDurationMonths?: number;
  readonly childSupportMonthlyCents?: number;
}

/**
 * A lump-sum paydown — see {@link import("../authoring/liabilities").PayOffDebtInput}. Like
 * {@link SeparateEntry} it creates no entity, only an event.
 */
export interface PayOffDebtEntry extends EventEntryCommon {
  readonly type: "payOffDebt";
  readonly liabilityRef: Ref;
  readonly accountRef: Ref;
  readonly amountCents: number;
}

/**
 * The timeline plane: one entry per `Projection` authoring method, discriminated on `type` with an
 * exhaustiveness check ({@link eventEntryType}) — the set is complete and closed. Several methods
 * share a {@link import("../ledger/eventTypes").LifeEvent} type (`marry`/`startPartnered` both emit
 * a `RelationshipEvent`; `takeLoan`/`carryLoan` both a `LoanEvent`), so the entry count exceeds the
 * event-variant count: the pre-existing doorway is a distinct method, not a flag on the plain one.
 */
export type EventEntry =
  | MarryEntry
  | HaveChildEntry
  | StartPartneredEntry
  | HaveExistingChildEntry
  | TakeLoanEntry
  | CarryLoanEntry
  | BuyHomeEntry
  | OwnHomeEntry
  | SeparateEntry
  | PayOffDebtEntry;

/**
 * Exhaustiveness guard over {@link EventEntry}'s discriminant, the same contract
 * {@link import("../facade/projectionFacade").Projection} gives {@link import("../ledger/eventTypes").LifeEvent}:
 * the switch names every event kind and the `never` default makes a seventh a COMPILE error
 * here, so the union cannot grow a variant without this being updated. Returns the discriminant
 * unchanged; callers needing only the closure guarantee ignore the result.
 */
/**
 * The month an entry will apply at — the one the sort orders by and the applier's method mints.
 * Most entries carry it directly; the pre-existing doorways compute it internally from the
 * quantity the author knows (a partnering's age, a child's age, or the fixed now marker for a
 * holding), so this is where that convention lives for scheduling. Kept in lockstep with each
 * method's own computation: a mismatch would sort an anchor into the wrong replay position.
 */
export function entryMonth(entry: EventEntry): number {
  switch (entry.type) {
    case "startPartnered":
      return -entry.partneredForMonths;
    case "haveExistingChild":
      return -entry.ageMonths;
    case "carryLoan":
    case "ownHome":
      return PRE_NOW_MONTH;
    default:
      return entry.month;
  }
}

export function eventEntryType(entry: EventEntry): EventEntry["type"] {
  switch (entry.type) {
    case "marry":
    case "haveChild":
    case "startPartnered":
    case "haveExistingChild":
    case "takeLoan":
    case "carryLoan":
    case "buyHome":
    case "ownHome":
    case "separate":
    case "payOffDebt":
      return entry.type;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/**
 * A declarative scenario: the plan's scalars, its frozen `startYear`, and the two authoring
 * planes as ref-bearing entries. Plan-plane collections (`jobs`, `goals`, `budgetLines`) carry
 * no month and apply first; `events` is one ordered array applied by stable sort on `month`,
 * array position breaking ties within a month.
 */
export interface ScenarioInput extends PlanScalars {
  /** The frozen "now" — calendar year of month 0. Not a `Plan` field. */
  readonly startYear: number;
  readonly jobs?: readonly JobEntry[];
  readonly goals?: readonly GoalEntry[];
  readonly budgetLines?: readonly BudgetLineEntry[];
  readonly events?: readonly EventEntry[];
  /**
   * The PRIMARY person's continuation job — see
   * {@link import("../plan/person").Person.continuationJobId}. Names a `jobs` entry by its `ref`, so
   * it is applied after every job is bound.
   *
   * Omitted is the ordinary case and means "not chosen", which the engine resolves on read;
   * `null` states None outright. A partner's own selection is not authorable here — their jobs
   * are minted inside the `marry` entry that creates them, so no ref exists to name one with —
   * and is set afterwards through `Projection.setContinuationJob`.
   */
  readonly continuationJobRef?: Ref | null;
}

/**
 * A {@link ScenarioInput} with nothing in it yet — the plan's scalars and its frozen
 * `startYear`, and none of the four entry planes.
 *
 * These are the fields that have no sensible engine-wide default: a retirement age, a life
 * expectancy, an inflation rate and a set of return assumptions are product decisions, and an
 * engine that guessed them would quietly answer a question nobody asked. So they are required,
 * and {@link import("../facade/projectionFacade").Projection.init} takes exactly them — everything else
 * about a scenario can be added afterwards.
 */
export type ScenarioScalars = Omit<
  ScenarioInput,
  "jobs" | "goals" | "budgetLines" | "events"
>;

/**
 * What `Projection.fromInput` answers, mirroring the existing `{ ok } | { ok }` result shape
 * rather than throwing. Build is all-or-nothing: a refused document yields no partial
 * projection.
 */
export type FromInputResult =
  | { readonly ok: true; readonly projection: Projection }
  | { readonly ok: false; readonly error: ScenarioInputError };

/**
 * Why a {@link ScenarioInput} was refused, naming the offending entry where it can — a
 * document may carry dozens of inputs, so a bare reason would not locate the fault.
 */
export interface ScenarioInputError {
  readonly reason: string;
  /** Index into `events`, when the failure is attributable to one entry. */
  readonly eventIndex?: number;
  readonly ref?: string;
}
