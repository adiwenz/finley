import type { Cents } from "../money/money";
import { derivePaymentStatus, deriveLoanStatus } from "../liability/liability";
import type { SimState } from "./runState";
import type { LiabilityPaymentRecord } from "./simulate.types";

/**
 * Step 4: this month's SCHEDULED payment for every liability, on beginning-of-month balances
 * — what obligation reporting and {@link buildLiabilityPaymentRecords} always show, regardless
 * of what the household could actually fund. {@link advanceLiabilities} reduces the balance by
 * that funded amount instead, which this figure only upper-bounds.
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
 * terminal failure condition, surfaced as `isInsolvent` and a null net worth. This function
 * itself derives nothing per-line — obligations still report at their authored amount
 * regardless (see {@link import("./financialObligation").buildObligations}) — but the caller
 * combines this return with the pre-cascade obligation/contribution split to work out which
 * liability the household's real covering capacity actually reached (see {@link
 * import("./financialObligation").fundedLiabilityPayments}).
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
 *
 * `appliedPayments` is PER LIABILITY — what THIS liability's payment actually got funded this
 * month, from {@link import("./financialObligation").fundedLiabilityPayments} (never more than
 * `computeLiabilityPayments` scheduled). Interest still accrues on the full balance regardless;
 * only the payment reduction reflects what was actually funded, so a liability whose payment
 * came up short does not amortize down as though it succeeded.
 */
export function advanceLiabilities(
  state: SimState,
  month: number,
  appliedPayments: ReadonlyMap<string, Cents>,
  suppressedLiabilityIds?: ReadonlySet<string>,
): void {
  for (const liab of state.liabilities) {
    // The mortgage of a blocked purchase never originates — suppressed alongside its property so a
    // stranded home leaves neither a phantom asset nor a phantom loan on the balance sheet.
    if (suppressedLiabilityIds?.has(liab.id)) continue;
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
    const appliedCents = appliedPayments.get(liab.id) ?? 0;
    state.liabilityBalances.set(liab.id, Math.max(0, bal - appliedCents));
  }
}
