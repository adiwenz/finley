/**
 * @finley/engine — the public, pure financial-simulation engine.
 *
 * Barrel export. The engine depends on nothing app- or rules-specific; it
 * defines the jurisdiction interface and runs standalone with the null
 * jurisdiction (ARCHITECTURE.md). Engine purity is enforced by
 * `scripts/check-engine-purity.mjs`.
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
// The standing Job/Person authoring model (§1–§8, issue #64). `Person` here is
// the source-of-truth household member (identity + retirement/benefit inputs + jobs);
// it is distinct from the lower-level simulator `SimPerson`
// (`./projection/simulate`), which is the compiled shape the sim consumes. The
// seam between them is `compilePerson`.
export type { Job, PersonId, SalaryTrajectory, JobDeferral } from "./job";
export { deriveRealGrowthPct } from "./job";
export type { Person } from "./person";
// The authoring per-person account ownership model (§9, §10, issue #68). An
// `Account.owners: PersonId[]` distinguishes individual (`[p]`) from joint
// (`[p1, p2]`) holdings; net worth is the household aggregate. Distinct from the
// low-level simulator `SimAccount` class (`./simAccount`).
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
export { compilePersonIncomeSeries, compilePersonPriorEarnings } from "./compilePerson";
// The line-item budget authoring model (§12, §15, §18, §19, issue #67, slice 4):
// a prioritized list of dollar line items (expenses + account contributions) with
// {literal, fill-to-limit, goal-paced} amount sources, spans + dated overrides.
// Added additively alongside the scalar `Plan.expenseCents` / `retirementDeferralPct`
// / `surplusSwept` path (removed only in #72). `compileBudget` is the sim seam.
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
// The deadline-paced sinking-fund pace (§14/§19, #26): the pure primitive behind the
// `goalPaced` amount source and the waterfall's fund-to-pace goal loop.
export { requiredContributionCents } from "./requiredContribution";
// The unified `allocations()` view (§13/§14/§15, issue #69, slice 6): job deferrals +
// budget lines + goals folded into one priority-ordered list with stable ids; reads
// unify, writes route to the canonical home (deferral → job, expense → budget, goal → goal).
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
// The unified `Projection` root (§2/§18/§20 + "npm API surface", issue #70, slice 7):
// the headline public API — standing edits + ledger transactions on one root,
// deterministic id minting, and `run(jurisdiction)` → immutable `ProjectionResult`.
// Writes are not reversible by the root (no undo stack); reversal is addressable
// removal, landing with the remaining event methods in a later slice.
// Ships alongside (not in place of) the low-level functional barrel.
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
// A Scenario couples a Plan with its Ledger — the unit the engine projects, so a
// plan's timeline events can never be silently dropped from a projection (§6).
export * from "./scenario";
export * from "./projectionBase";
// The retirement solver's public API is deliberately narrow (§5, issue #66):
// `solveRetirement` (the three §5 ages off one plan) and `evaluateAtAge` (the panel's
// assessment at the user's pinned age). The redundant per-mode search entry points
// (partial-retirement/full-retirement/latest-authored-work-stop) stay module-internal — reachable by the
// solver's own white-box tests, not by consumers — since `solveRetirement` returns them
// all. `projectScenario` + `realNetWorthSurvives` remain public: they are the projection
// substrate + survival predicate the net-worth graph reads and the app's #37 acceptance
// tests use as an INDEPENDENT survival oracle (panel age == first surviving projection age).
export {
  solveRetirement,
  evaluateAtAge,
  evaluateFullRetirementAtAge,
  projectScenario,
  realNetWorthSurvives,
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
export * from "./ledger/removeEvent";
export * from "./ledger/addEvent";
