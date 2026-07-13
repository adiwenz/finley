/**
 * Affordability — the §4.5 soft-warning arithmetic (debt-to-income).
 *
 * Two constraints govern a home purchase (§4.5): a HARD BLOCK on down-payment
 * coverage (enforced in the event handler against liquid funds) and this SOFT
 * WARNING on ongoing affordability. DTI never blocks — it flags, and the app
 * pairs the flag with the projected downstream consequence. These are pure
 * ratio functions so the thresholds live in exactly one place.
 */

import type { Cents } from "./money";
import { computeAmortizingPaymentCents } from "./liability";

/** Front-end (housing ÷ gross) DTI guideline — lenders typically cap here (§4.5). */
export const DTI_FRONT_END_THRESHOLD = 0.28;
/** Back-end (total debt ÷ gross) DTI guideline (§4.5). */
export const DTI_BACK_END_THRESHOLD = 0.36;

export interface DtiAssessment {
  /** Housing cost ÷ gross income. 0 when gross is 0 (undefined ratio → not flagged). */
  readonly frontEndRatio: number;
  /** Total debt payments ÷ gross income. */
  readonly backEndRatio: number;
  /** frontEndRatio strictly exceeds the 28% guideline. */
  readonly frontEndExceeded: boolean;
  /** backEndRatio strictly exceeds the 36% guideline. */
  readonly backEndExceeded: boolean;
}

/**
 * Classify monthly housing and total-debt cost against the DTI guidelines. All
 * figures are monthly cents. `monthlyTotalDebtCents` is housing plus every other
 * recurring debt payment (auto, student, card minimums). With zero gross income
 * the ratios are 0 and nothing is flagged — a soft warning must not fire on a
 * divide-by-zero.
 */
export function assessDti(
  monthlyGrossCents: Cents,
  monthlyHousingCents: Cents,
  monthlyTotalDebtCents: Cents,
): DtiAssessment {
  const frontEndRatio = monthlyGrossCents > 0 ? monthlyHousingCents / monthlyGrossCents : 0;
  const backEndRatio = monthlyGrossCents > 0 ? monthlyTotalDebtCents / monthlyGrossCents : 0;
  return {
    frontEndRatio,
    backEndRatio,
    frontEndExceeded: frontEndRatio > DTI_FRONT_END_THRESHOLD,
    backEndExceeded: backEndRatio > DTI_BACK_END_THRESHOLD,
  };
}

/**
 * The level monthly mortgage payment a home purchase implies — the financed
 * amount (`purchasePriceCents − downPaymentCents`) amortized over the term. The
 * housing component of a front-end DTI check; property-tax/insurance/HOA streams
 * (deferred) would be added on top by the caller.
 */
export function mortgagePaymentForPurchaseCents(
  purchasePriceCents: Cents,
  downPaymentCents: Cents,
  apr: number,
  termMonths: number,
): Cents {
  return computeAmortizingPaymentCents(
    Math.max(0, purchasePriceCents - downPaymentCents),
    apr,
    termMonths,
  );
}
