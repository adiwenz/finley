/**
 * @finley/engine — the public, pure financial-simulation engine. Barrel export.
 *
 * Depends on nothing app- or rules-specific: it defines the jurisdiction interface and runs
 * standalone with the null jurisdiction. Purity enforced by `scripts/check-engine-purity.mjs`.
 */
export type { Cents } from "./money";
export * from "./cashFlowSeries";
export * from "./simAccount";
export * from "./liability";
export * from "./affordability";
export * from "./jurisdiction";
export * from "./earningsRecord";
export * from "./governmentBenefit";
export * from "./goal";
// The standing Job/Person authoring model. `Person` is THE public household-member type
// (identity + retirement/benefit inputs + jobs); the app authors the roster as `Person`s.
// `SimPerson` is the *compiled* shape the sim consumes — engine-INTERNAL, not barrel-exported,
// derived from a `Person` at the sim boundary via `compilePerson`.
export type { Job, PersonId, SalaryTrajectory, JobDeferral, JobIncomeOverride, JobPayChange } from "./job";
export { deriveRealGrowthPct } from "./job";
export type { Person } from "./person";
// Authoring account-ownership model: `Account.owners: PersonId[]` distinguishes individual
// (`[p]`) from joint (`[p1, p2]`) holdings; net worth is the household aggregate. Distinct
// from the low-level simulator `SimAccount` class (`./simAccount`).
export type { Account, AccountHousehold } from "./account";
export {
  makeAccount,
  assertAccountOwnership,
  isJoint,
  isIndividual,
  personalAccounts,
  jointAccounts,
  accountsOf,
  householdNetWorthCents,
} from "./account";
export {
  compilePersonIncomeSeries,
  compilePersonPriorEarnings,
  type MembershipWindow,
} from "./compilePerson";
// Line-item budget authoring model: a prioritized list of dollar line items (expenses +
// account contributions) with {literal, fill-to-limit, goal-paced} amount sources, spans +
// dated overrides. The scalar `retirementDeferralPct` / `surplusSwept` levers are gone
// (deferral rides the Job); `expenseCents` remains as the engine-native scalar-expense
// fallback. `compileBudget` is the sim seam.
export type {
  TaxTreatment,
  BudgetTarget,
  AmountSource,
  BudgetCategory,
  BudgetLineSpan,
  BudgetLineOverride,
  BudgetLine,
  ResolveLineContext,
  ResolvedBudgetLine,
} from "./budgetLine";
export {
  taxTreatmentForLine,
  resolveBudgetLineMonthlyCents,
  budgetLinePriority,
  orderBudgetLines,
  resolveBudget,
} from "./budgetLine";
export {
  compileExpenseBudgetLines,
  fillToLimitSeamFor,
} from "./compileBudget";
// Deadline-paced sinking-fund pace: the pure primitive behind the `goalPaced` amount source
// and the waterfall's fund-to-pace goal loop.
export { requiredContributionCents } from "./requiredContribution";
// Unified `allocations()` view: job deferrals + budget lines + goals in one priority-ordered
// list with stable ids. Reads unify; writes route to the canonical home (deferral → job,
// expense → budget, goal → goal).
export type {
  AllocationHome,
  AllocationSource,
  Allocation,
  AllocationsInput,
  AllocationEdit,
  WriteRoute,
} from "./allocations";
export {
  allocations,
  goalToLineItem,
  budgetLineAllocationId,
  routeAllocationWrite,
} from "./allocations";
export * from "./plan";
// The unified `Projection` root — the headline public API: standing edits + ledger
// transactions on one root, deterministic id minting, `run(jurisdiction)` → immutable
// `ProjectionResult`. The root has no undo stack; reversal is addressable removal, landing
// with the remaining event methods later. Ships alongside the low-level functional barrel.
export type {
  ProjectionState,
  ProjectionResult,
  ProjectionInit,
  JobInput,
  BudgetLineInput,
  GoalInput,
  MarryInput,
  TakeLoanInput,
  BuyHomeInput,
} from "./projectionRoot";
export { Projection } from "./projectionRoot";
// A Scenario couples a Plan with its Ledger — the unit the engine projects, so timeline
// events can never be silently dropped from a projection.
export * from "./scenario";
export * from "./projectionBase";
// The retirement solver's public API is deliberately narrow: `solveRetirement` (the three
// ages off one plan) and `evaluateAtAge` (the panel's assessment at the pinned age). The
// per-mode search entry points stay module-internal — `solveRetirement` returns them all.
// `projectScenario` + `planSurvives` stay public: the projection substrate + survival
// predicate the net-worth graph reads and the app's acceptance tests use as an INDEPENDENT
// survival oracle (panel age == first surviving projection age).
export {
  solveRetirement,
  evaluateAtAge,
  evaluateFullRetirementAtAge,
  projectScenario,
  planSurvives,
} from "./retirementSolver";
export * from "./retirementTypes";
export * from "./earlyRetireeHealthCheck";
export * from "./ids";

// Simulator (low-level) + the ledger→projection→snapshot pipeline.
export * from "./projection/waterfall";
export * from "./projection/simulate";
export * from "./projection/rmd";
export * from "./projection/withdrawal";
export * from "./projection/buildHouseholdInput";
// The unified spending read model: what a month costs, itemized.
export * from "./projection/spendingItems";
export * from "./projection/report";
export * from "./projection/assumptions";
export * from "./projection/snapshot";

// Event ledger.
export * from "./ledger/eventTypes";
export * from "./ledger/ledger";
export * from "./ledger/transfers";
export * from "./ledger/ledgerBase";
export * from "./ledger/interpretState";
export * from "./ledger/household";
export * from "./ledger/interpret";
export * from "./ledger/eventValidation";
export * from "./ledger/dependencies";
export * from "./ledger/funding";
export * from "./ledger/removeEvent";
export * from "./ledger/addEvent";
export * from "./ledger/updateEvent";
