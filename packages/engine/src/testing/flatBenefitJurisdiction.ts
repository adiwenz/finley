/**
 * A test {@link Jurisdiction} whose only program is a **flat government benefit**: the same
 * monthly figure for anyone who has claimed, no tax, no COLA, no earnings pricing.
 *
 * It exists so a test can watch the benefit STOP without also having to model why it is the size
 * it is. `nullJurisdiction` pays none at all, so a run under it can say nothing about when a
 * benefit ends; `@finley/rules`' real one is out of reach here by construction — the engine may
 * not import the rules package (`check-engine-purity`), and a benefit that moves with a
 * covered-earnings record and a COLA would make "did it stop?" a question about arithmetic
 * rather than about the window.
 *
 * Flat is what makes the assertion legible: the benefit is a constant while it is paid and
 * exactly absent once it is not, so a month either has the source or does not.
 *
 * Claiming is still the person's own `benefitClaimingAge` (or `defaultBenefitClaimingAge` below),
 * because WHEN a benefit starts is the thing being contrasted with when it ends.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { mockJurisdiction } from "./mockJurisdiction";

/** The monthly benefit every claimant is paid, in cents. */
export const FLAT_BENEFIT_MONTHLY_CENTS = 100_000;

export function flatBenefitJurisdiction(monthlyCents = FLAT_BENEFIT_MONTHLY_CENTS): Jurisdiction {
  return mockJurisdiction({
    id: "flat-benefit",
    // Priced the same however long the person worked: the record is deliberately ignored.
    governmentBenefitBaseMonthlyCents: () => monthlyCents,
    // No `colaAdjustedBenefitCents`, so what is paid IS the base, every year — see above.
    defaultBenefitClaimingAge: 67,
  });
}
