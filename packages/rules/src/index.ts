import type { Jurisdiction } from "@finley/engine";
import { socialSecurityMonthlyBenefitCents } from "./socialSecurity";
import { requiredMinimumDistributionCents } from "./rmd";

export { socialSecurityMonthlyBenefitCents } from "./socialSecurity";
export { requiredMinimumDistributionCents } from "./rmd";

/**
 * @finley/rules — jurisdiction implementations of the engine's interface.
 *
 * Depends only on `@finley/engine` (to implement its interface); never the
 * reverse. This one-way dependency is the open-core boundary (ARCHITECTURE.md).
 *
 * Slice 0 ships a placeholder `US-2026` that implements the interface but
 * carries no real facts yet — its `computeTax` returns 0. It exists to prove
 * the app → rules → engine dependency direction end to end before real tax
 * brackets, contribution limits, and programs land in later slices.
 *
 * ⚠ Estimates, not advice. Figures change yearly and are jurisdiction-specific.
 */
export const usJurisdiction: Jurisdiction = {
  id: "US-2026",
  computeTaxCents: () => 0,
  socialSecurityMonthlyBenefitCents,
  requiredMinimumDistributionCents,
};
