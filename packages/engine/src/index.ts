/**
 * `@finley/engine` — the public, pure financial-simulation engine.
 *
 * This file IS the public surface: one module stating an application's entire dependency on the
 * package, so adding to it is a deliberate edit with a reason beside it. It declares nothing of
 * its own, and every line re-exports from the module that DEFINES the symbol — `Projection` from
 * the facade, each authoring input from the module that applies it, each artifact from the
 * function that builds it. There is no intermediate barrel to keep in step, and reading a line
 * here tells you where the thing lives.
 *
 * The line, drawn once: if answering the question needs the projection — the plan, the ledger,
 * the household, the run — it is a METHOD on {@link Projection}, and it returns what the caller
 * actually wanted rather than a compiler artifact to finish assembling. What a caller may name
 * beyond that is here: the types those methods take and return, a well-known id to quote, a unit
 * conversion with no state to convert against, a label for an enum value. Everything else in the
 * package — the simulator, the ledger, the waterfall, the snapshot/report pipeline, the entity
 * transforms — is internal and reached by relative path from inside this package only.
 *
 * Nothing that WRITES appears here, and nothing that writes may be added. The entity transforms
 * (`withPayChange`, `withGoalPatch`, `addEvent`, `updateEvent`, …) and the projection-level state
 * functions (`addProjectionJob`, `applyMarriage`, …) are internal. An app that could import one
 * would have a second write path around the id counter, the goal-funding guard and the
 * affordability gate — which is the arrangement this module exists to replace.
 *
 * Named re-exports only, never `export *`: `index.guard.test.ts` and the app's
 * `planWrites.guard.test.ts` both read this file's TEXT to decide what may be named, so a
 * wildcard would widen the surface silently and re-open the hole a curated map closes.
 *
 * Depends on nothing app- or rules-specific: it defines the jurisdiction interface and runs
 * standalone with the null jurisdiction. Purity enforced by `scripts/check-engine-purity.mjs`.
 */

// The facade itself, and the artifacts its two derived-output queries answer with — each beside
// the function that builds it, since a result type and its constructor are one thing.
export { Projection } from "./projectionFacade";
export type { ProjectionResult } from "./projectionRun";
export type { RetirementOutlook } from "./retirementOutlook";
export type { DeferralLimitCrossing } from "./deferralLimit";
export type { ResolvedJobPayDisplay } from "./householdJob";

// The authoring state a caller holds, its self-describing format version, and the error that
// refuses a version this build cannot read.
export type { ProjectionState } from "./authoring/state";
export { CURRENT_FORMAT_VERSION } from "./authoring/state";
export { UnsupportedVersionError } from "./authoring/restore";

// What the authoring methods take. Each is declared beside the module that applies it, so a
// field added to one is added where its rules are.
export type { JobInput } from "./authoring/jobs";
export type { BudgetLineInput, ResolvedExpenseRow } from "./authoring/budgetLines";
export type { GoalInput } from "./authoring/goals";
export type {
  MarryInput,
  HaveChildInput,
  SeparateInput,
  StartPartneredInput,
  HaveExistingChildInput,
} from "./authoring/relationships";
export type { BuyHomeInput, HomePurchaseInput, HomePurchaseAssessment } from "./authoring/housing";
export type {
  TakeLoanInput,
  OriginableLoanKind,
  CarryLoanInput,
  PayOffDebtInput,
} from "./authoring/liabilities";
export type { TransactionRevision } from "./authoring/revise";

// The authored model, and the artifacts a run produces.
export type { Plan, PlanPatch, GoalPlan, GoalPatch, GoalAccountType, SurplusCashDestination } from "./plan";
/**
 * The age ceilings every authoring surface shares: {@link MAX_AGE} is the outer bound,
 * {@link AGE_LIMITS} the per-field one, {@link MAX_LIVED_AGE} the oldest a person can already be.
 */
export { MAX_AGE, MAX_LIVED_AGE, AGE_LIMITS, planHorizonMonths } from "./plan";
// The declarative, id-free authoring input `fromInput` consumes, and the result it answers with —
// how seed data and presets describe a whole scenario without naming an id.
export type { ScenarioInput, FromInputResult } from "./scenarioInput";
export type {
  Job,
  JobDeferral,
  JobIncomeOverride,
  JobIncomeOverrideInput,
  JobPayChange,
  JobPayChangeInput,
  JobPaySpan,
  JobPayPath,
  JobPayPathOptions,
  JobId,
  PersonId,
  SalaryTrajectory,
} from "./job";
/**
 * A job's authored pay across its whole span, read back without running a projection — what an
 * editor draws the salary it is editing from, and where the month-0 seam is a number.
 */
export { jobPayPath } from "./job";
/**
 * The month a permanent pay change takes force — its own, except at month 0, which the authored
 * current salary owns. An authoring surface needs it to say when the change it just took begins.
 */
export { payChangeEffectiveMonth } from "./job";
/**
 * What an adjustment DOES to a month's pay, and the order a month's adjustments apply in — the
 * engine's own definitions, exported so an authoring surface draws and lists exactly what the
 * projection pays instead of restating the arithmetic and drifting from it.
 */
export {
  applyJobIncomeOverride,
  applyJobIncomeOverridesAt,
  orderedIncomeOverrides,
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
/** What the budget states it spends on health — the derivation that replaced a plan field. */
export { healthcareMonthlyCents } from "./budgetLine";
export type { Scenario } from "./scenario";
export type { Ledger } from "./ledger/ledger";
export type { LifeEvent, NewLifeEvent, RelationshipEvent } from "./ledger/eventTypes";
export type { Household } from "./ledger/household";
export { resolvedJobPaySpan } from "./ledger/household";
export type { FundingLookup } from "./ledger/addEvent";
export type { FundingAvailability, FundingSourceBalance } from "./ledger/interpretState";
export type { HouseholdSnapshot, SnapshotSeries } from "./projection/snapshot";
export type {
  ProjectionSeries,
  ProjectionMonth,
  BlockedObligation,
  InsolvencyReport,
  IncomeSourceCategory,
} from "./projection/simulate.types";
export type { SharedContributionScheme } from "./projection/waterfall.types";
export type { FinancialObligation } from "./projection/financialObligation";
export type {
  ResolvedFunding,
  ResolvedFundingSource,
  FundingSourceKind,
} from "./projection/resolvedFunding";
export type { SimulationReport } from "./projection/report";
export type { PlanAccountDescriptor, ProjectionContext } from "./projectionBase";
export type {
  ContinuedJob,
  JobOverlap,
  RetirementEvaluation,
  RetirementSolution,
} from "./retirementTypes";
export type { EarlyRetireeHealthFlag } from "./earlyRetireeHealthCheck";
export type { DtiAssessment } from "./affordability";
export type { LiabilityKind } from "./liability";
export type { Cents } from "./money";

// The open-core seam. The `rules` package implements {@link Jurisdiction} against this engine,
// so every context and param type its methods name is part of the published surface — a rule
// implementation cannot type its arguments otherwise. Listed whole rather than piecemeal: the
// interface and the shapes it references are one contract, and a context type reachable only by
// the engine would leave a `rules` method unable to name what it is handed.
export type {
  Jurisdiction,
  JurisdictionContext,
  GovernmentBenefitClaim,
  GovernmentBenefitContext,
  DeferralLimitContext,
  RmdContext,
  HealthCostContext,
  WithdrawalTaxBasis,
  ReturnTaxTreatment,
} from "./jurisdiction";
export type { TaxCategory } from "./cashFlowSeries";
export type { ModelAssumption } from "./projection/assumptions";
export type { AccountReturnKind } from "./simAccount";
export type { EarningsRecord } from "./earningsRecord";
export type { ProjectionIncomeSource } from "./projection/simulate.types";

// The standalone jurisdiction: no taxes, no government programs. Part of this package precisely
// so `fromInput(input, nullJurisdiction)` runs the engine end to end without the `rules` package
// — a value on the surface, not a type, because a caller supplies it.
export { nullJurisdiction } from "./jurisdiction";

// Money as the user types it. Neither reads nor writes anything — a form has cents to hand
// the facade before there is any state for the facade to hold, so a `Projection` method
// would be an instance in search of a use.
export { dollarsToCents, centsToDollars } from "./cashFlowSeries";

// A total function of one enum value, with no projection to ask.
export { liabilityKindLabel } from "./liability";

// The "now" marker's own predicate — a total function of one month. An authoring surface has to
// ask it: an event dated before now is a holding or an anchor, authored (and so EDITED) in the
// vocabulary of what is already true — a balance today, how long you have been together — rather
// than by picking a year off the plan's timeline. Re-deriving `month < 0` in the app is exactly
// the scattered bare `-1` that naming this rule removed.
export { isPreExisting } from "./projection/nowMarker";

// Ids and thresholds the engine owns and an app has to quote back: the primary person, the
// standing accounts, the synthetic revolving card, and the DTI guidelines a warning cites.
export { RETIREMENT_ID } from "./ids";
export { PRIMARY_PERSON_ID, CONTRIBUTION_TARGETS } from "./projectionBase";
export { SYNTHETIC_CARD_ID, SYNTHETIC_CARD_CREDIT_LIMIT_CENTS } from "./liability";
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
