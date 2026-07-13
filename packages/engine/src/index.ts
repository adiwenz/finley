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
export * from "./jurisdiction";
export * from "./ids";

// Simulator (low-level) + the ledger→projection→snapshot pipeline.
export * from "./projection/simulate";
export * from "./projection/buildHouseholdInput";
export * from "./projection/snapshot";

// Event ledger.
export * from "./ledger/eventTypes";
export * from "./ledger/ledger";
export * from "./ledger/replayState";
export * from "./ledger/replay";
export * from "./ledger/eventValidation";
export * from "./ledger/dependencies";
export * from "./ledger/removeEvent";
