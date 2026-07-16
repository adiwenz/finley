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
