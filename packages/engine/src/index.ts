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
export * from "./account";
export * from "./liability";
export * from "./affordability";
export * from "./jurisdiction";
export * from "./earningsRecord";
export * from "./socialSecurityBenefit";
export * from "./goal";
// The standing Job/Person authoring model (§1–§8, issue #64). `Person` here is
// the source-of-truth household member (identity + retirement/SS inputs + jobs);
// it is distinct from the lower-level simulator `SimPerson`
// (`./projection/simulate`), which is the compiled shape the sim consumes. The
// seam between them is `compilePerson`.
export type { Job, PersonId, SalaryTrajectory, JobDeferral } from "./job";
export { deriveRealGrowthPct } from "./job";
export type { Person } from "./person";
export { careerJobOf } from "./person";
export { compilePersonIncomeSeries, compilePersonPriorEarnings } from "./compilePerson";
export * from "./plan";
export * from "./projectionBase";
export * from "./retirementSolver";
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
