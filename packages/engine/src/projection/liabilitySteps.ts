import type { Cents } from "../money";
import { derivePaymentStatus, deriveLoanStatus } from "../liability";
import type { SimState } from "./runState";
import type { LiabilityPaymentRecord } from "./simulate.types";

/**
 * Step 4: this month's payment for every liability, on beginning-of-month balances. Returned
 * so advanceLiabilities applies the exact same figure, keeping the cash outflow (step 5) and
 * the balance update consistent.
 *
 * Each liability computes its own payment ({@link SimLiability.monthlyPaymentCents}), capped
 * at the payoff so a small balance is never over-charged.
 */
export function computeLiabilityPayments(state: SimState, month: number): Map<string, Cents> {
  const payments = new Map<string, Cents>();
  for (const liab of state.liabilities) {
    const bal = state.liabilityBalances.get(liab.id) ?? 0;
    if (bal <= 0) continue;
    payments.set(liab.id, liab.monthlyPaymentCents(bal, month));
  }
  return payments;
}

/**
 * One record per entry in `payments`, which already skips paid-off, not-yet-originated and
 * origination-month liabilities.
 *
 * v1-seam: `amountApplied` and `expected` are the same payoff-capped figure today, so every
 * record is `full` / `current`. A future underpayment channel passes a smaller
 * `amountApplied` and `partial`/`missed`/`delinquent` surface automatically.
 */
export function buildLiabilityPaymentRecords(
  payments: ReadonlyMap<string, Cents>,
): Record<string, LiabilityPaymentRecord> {
  const records: Record<string, LiabilityPaymentRecord> = {};
  for (const [id, appliedCents] of payments) {
    const expectedCents = appliedCents;
    const paymentStatus = derivePaymentStatus(appliedCents, expectedCents);
    records[id] = {
      paymentStatus,
      amountAppliedCents: appliedCents,
      loanStatus: deriveLoanStatus(paymentStatus),
    };
  }
  return records;
}

/**
 * Step 7: shortfall cascade. If the liquid account went negative, zero it and route the
 * deficit onto credit cards lowest-APR-first, each up to its limit (a null limit is
 * unbounded; the synthetic shortfall card has a finite default limit, so it too can be
 * exhausted).
 *
 * Returns the deficit still UNCOVERED once savings and every card are exhausted — the
 * terminal failure condition, surfaced as `isInsolvent` and a null net worth. Nothing
 * per-line is derived from it (see {@link import("./financialObligation").buildObligations}
 * for why an obligation is reported at its authored amount rather than rationed).
 */
export function applyShortfallCascade(state: SimState, month: number): Cents {
  if (state.liquidAccount === null) return 0;
  const liquidBal = state.assetBalances.get(state.liquidAccount.id) ?? 0;
  if (liquidBal >= 0) return 0;

  let deficit = -liquidBal;
  state.assetBalances.set(state.liquidAccount.id, 0);
  for (const card of state.cascadeCards) {
    if (deficit <= 0) break;
    // A card not yet originated can't absorb a shortfall — borrowing onto it would be lost.
    if (month <= card.startMonth) continue;
    const currentBal = state.liabilityBalances.get(card.id) ?? 0;
    const limit = card.creditLimitCents;
    const available = limit === null ? deficit : Math.max(0, limit - currentBal);
    const borrow = Math.min(deficit, available);
    state.liabilityBalances.set(card.id, currentBal + borrow);
    deficit -= borrow;
  }
  return Math.max(0, deficit);
}

/**
 * Step 10: advance every liability. One-time principal adjustments (lump-sum payments) land
 * FIRST, before interest — the liability analogue of step 8 preceding step 9 for assets — so
 * a lump sum reduces that month's interest.
 *
 * A transfer only moves the owed balance; the engine does not auto-fund it, so pairing a
 * liability payoff with an account outflow is the caller's job and is what conserves net
 * worth. A lump sum can drive the balance below the precomputed schedule; the payoff cap in
 * computeLiabilityPayments makes that safe, yielding shorten-term behavior (loan retires
 * early, payment unchanged).
 */
export function advanceLiabilities(
  state: SimState,
  month: number,
  payments: ReadonlyMap<string, Cents>,
): void {
  for (const liab of state.liabilities) {
    if (month < liab.startMonth) continue; // not originated yet — stays at 0
    if (month === liab.startMonth) {
      // Origination: balance appears with no interest or payment, mirroring an account's
      // opening balance at month 0.
      state.liabilityBalances.set(liab.id, liab.openingBalanceCents);
      continue;
    }
    let bal = state.liabilityBalances.get(liab.id) ?? 0;
    for (const t of liab.getTransfersAt(month)) {
      const fixed = t.amountCents ?? 0;
      const proportional = Math.round(bal * (t.proportionalFraction ?? 0));
      bal = Math.max(0, bal + fixed + proportional);
    }
    if (bal <= 0) {
      state.liabilityBalances.set(liab.id, 0);
      continue;
    }
    bal = Math.round(bal * (1 + liab.apr / 12));
    state.liabilityBalances.set(liab.id, Math.max(0, bal - (payments.get(liab.id) ?? 0)));
  }
}
