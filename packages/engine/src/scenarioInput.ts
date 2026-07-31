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
 * counter already advanced — is {@link import("./projectionRoot").Projection.fromState}'s job
 * (fed by `toJSON`); it takes a whole `ProjectionState` and floors the counter past everything it
 * holds. Reach for that when the ids matter, and for this when the scenario is being described
 * for the first time.
 */

import type { Plan, GoalPlan } from "./plan";
import type { Job, JobDeferral } from "./job";
import type { BudgetLine, TaxTreatment } from "./budgetLine";
import type { LiabilityKind } from "./liability";
import type { GrowthMode } from "./cashFlowSeries";
// Type-only, and cyclic: `Projection` imports these authoring types, so a value import back
// would close the loop. `FromInputResult` names the class only in a field, which a type import
// resolves without a runtime edge.
import type { Projection } from "./projectionRoot";

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

/** Every {@link Plan} field except the three id-bearing collections, which become entries. */
type PlanScalars = Omit<Plan, "jobs" | "goals" | "budgetLines">;

/**
 * The `"account"` arm of a {@link import("./budgetLine").BudgetTarget}, but pointing at an
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
export interface JobEntry
  extends Omit<Job, "id" | "ownerId" | "deferral"> {
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

/** The incoming partner and their ref-authored jobs — see {@link import("./projectionRoot").MarryInput}. */
export interface MarryEntry extends EventEntryCommon {
  readonly type: "marry";
  readonly name: string;
  readonly birthYear: number;
  readonly retirementTargetAge?: number;
  readonly benefitClaimingAge?: number;
  readonly jobs?: readonly JobEntry[];
}

/** A child joining the household — see {@link import("./projectionRoot").HaveChildInput}. */
export interface HaveChildEntry extends EventEntryCommon {
  readonly type: "haveChild";
  readonly name: string;
  readonly annualCostCents: number;
  readonly birthMonth?: number;
}

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
    | { readonly kind: Exclude<LiabilityKind, "creditCard">; readonly termMonths: number }
  );

/** A home purchase — see {@link import("./projectionRoot").BuyHomeInput}. */
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
 * A partner leaving — see {@link import("./projectionRoot").SeparateInput}. Mints only an
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
 * A lump-sum paydown — see {@link import("./projectionRoot").PayOffDebtInput}. Like
 * {@link SeparateEntry} it creates no entity, only an event.
 */
export interface PayOffDebtEntry extends EventEntryCommon {
  readonly type: "payOffDebt";
  readonly liabilityRef: Ref;
  readonly accountRef: Ref;
  readonly amountCents: number;
}

/**
 * The timeline plane: exactly the six {@link import("./ledger/eventTypes").LifeEvent} variants
 * and the six `Projection` authoring methods, discriminated on `type` with an exhaustiveness
 * check ({@link eventEntryType}) — the set is complete and closed.
 */
export type EventEntry =
  | MarryEntry
  | HaveChildEntry
  | TakeLoanEntry
  | BuyHomeEntry
  | SeparateEntry
  | PayOffDebtEntry;

/**
 * Exhaustiveness guard over {@link EventEntry}'s discriminant, the same contract
 * {@link import("./projectionRoot").Projection} gives {@link import("./ledger/eventTypes").LifeEvent}:
 * the switch names every event kind and the `never` default makes a seventh a COMPILE error
 * here, so the union cannot grow a variant without this being updated. Returns the discriminant
 * unchanged; callers needing only the closure guarantee ignore the result.
 */
export function eventEntryType(entry: EventEntry): EventEntry["type"] {
  switch (entry.type) {
    case "marry":
    case "haveChild":
    case "takeLoan":
    case "buyHome":
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
}

/**
 * A {@link ScenarioInput} with nothing in it yet — the plan's scalars and its frozen
 * `startYear`, and none of the four entry planes.
 *
 * These are the fields that have no sensible engine-wide default: a retirement age, a life
 * expectancy, an inflation rate and a set of return assumptions are product decisions, and an
 * engine that guessed them would quietly answer a question nobody asked. So they are required,
 * and {@link import("./projectionRoot").Projection.init} takes exactly them — everything else
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
