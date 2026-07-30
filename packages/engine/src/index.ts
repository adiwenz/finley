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
// `Person` is the public household-member type. Its compiled counterpart `SimPerson` is
// engine-internal and intentionally absent here; `compilePerson` derives it at the sim boundary.
export type { Job, PersonId, SalaryTrajectory, JobDeferral, JobIncomeOverride, JobPayChange, JobPatch } from "./job";
// The authoring transforms are shared BY BOTH write paths — the `Projection` API and the
// app's panels — so a rule like "a 0% deferral is removed, not recorded" has one home.
export {
  deriveRealGrowthPct,
  mapJob,
  withJobPatch,
  withMonthlyIncome,
  withDeferralFraction,
  withPayChange,
  withoutPayChange,
  withIncomeOverride,
  withoutIncomeOverride,
} from "./job";
export type { Person } from "./person";
// Authoring model: `Account.owners` distinguishes individual (`[p]`) from joint (`[p1, p2]`)
// holdings. Distinct from the simulator's `SimAccount` class (`./simAccount`). Ownership
// lives on the single `Household` aggregate (`./ledger/household`), not a second one.
export type { Account } from "./account";
// One account under both aspects: the authoring `Account` the household rosters and the
// compiled `SimAccount` the simulator runs, built from a single spec so they cannot drift.
export { planAccount, type PlanAccount } from "./planAccount";
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
// Line-item budget authoring model: prioritized expenses + account contributions, with
// {literal, fill-to-limit, goal-paced} amount sources, spans and dated overrides. Deferral is
// not a lever here — it rides the Job. The sole expense authoring surface; `compileBudget` is
// the sim seam.
export type {
  TaxTreatment,
  BudgetTarget,
  AmountSource,
  BudgetCategory,
  BudgetLineSpan,
  BudgetLineOverride,
  BudgetLine,
  BudgetLinePatch,
  ResolveLineContext,
  ResolvedBudgetLine,
} from "./budgetLine";
export {
  taxTreatmentForLine,
  resolveBudgetLineMonthlyCents,
  budgetLinePriority,
  orderBudgetLines,
  resolveBudget,
  withLinePatch,
  withoutLine,
} from "./budgetLine";
export {
  compileExpenseBudgetLines,
  fillToLimitSeamFor,
} from "./compileBudget";
// The primitive behind the `goalPaced` amount source and the waterfall's fund-to-pace loop.
export { requiredContributionCents } from "./requiredContribution";
// `allocations()` reads job deferrals + budget lines + goals as one priority-ordered list;
// writes route back to the canonical home (deferral → job, expense → budget, goal → goal).
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
// The `Projection` root: standing edits + ledger transactions on one object, deterministic id
// minting, `run(jurisdiction)` → immutable `ProjectionResult`. No undo stack — reversal is
// addressable removal.
export type {
  ProjectionState,
  ProjectionResult,
  ProjectionInit,
  JobInput,
  BudgetLineInput,
  GoalInput,
  MarryInput,
  HaveChildInput,
  SeparateInput,
  TakeLoanInput,
  BuyHomeInput,
  PayOffDebtInput,
} from "./projectionRoot";
export { Projection } from "./projectionRoot";
// A Scenario couples a Plan with its Ledger, so timeline events can never be silently dropped
// from a projection.
export * from "./scenario";
export * from "./projectionBase";
// Which events spend from a goal's fund account — the integrity question behind removing a
// goal, since the account is derived from the goal and falls away with it.
export * from "./goalFunding";
// The per-mode retirement searches stay module-internal; `solveRetirement` returns all three
// ages at once. `projectScenario` + `planSurvives` are public because the app's acceptance
// tests use them as an independent survival oracle (panel age == first surviving age).
// `projectScenarioParts` is deliberately NOT public: its only caller is `Projection.run`, a
// sibling inside the engine, and its result carries `HouseholdSimInput` — a low-level simulator
// artifact the facade migration exists to stop publishing. Exporting it would pin that type to
// the public surface through a type the app has no reason to name.
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
// What a month costs, itemized.
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
