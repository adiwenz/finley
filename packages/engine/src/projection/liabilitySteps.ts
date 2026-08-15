import type { Cents } from "../money/money";
import {
  derivePaymentStatus,
  deriveLoanStatus,
  type SimLiability,
} from "../liability/liability";
import type { SimState } from "./runState";
import type { LiabilityPaymentRecord } from "./simulate.types";

/**
 * One month's scheduled payments against a GIVEN set of beginning-of-month balances, rather than
 * the run's own. The shared rule behind both the real month ({@link computeLiabilityPayments})
 * and the year-ahead forecast ({@link forecastLiabilityPayments}), so the two cannot drift into
 * disagreeing about what a debt costs — a forecast that priced payments by its own rules would
 * predict a debt service the simulator never charges.
 *
 * A balance of 0 — paid off, or not yet originated — is absent from the result, not present at
 * zero: {@link import("./financialObligation").buildObligations} reads absence as "no obligation
 * this month", which is how a retired loan stops appearing in the spending report at all.
 */
function scheduledPaymentsAgainst(
  liabilities: readonly SimLiability[],
  balances: ReadonlyMap<string, Cents>,
  month: number,
): Map<string, Cents> {
  const payments = new Map<string, Cents>();
  for (const liab of liabilities) {
    const bal = balances.get(liab.id) ?? 0;
    if (bal <= 0) continue;
    payments.set(liab.id, liab.monthlyPaymentCents(bal, month));
  }
  return payments;
}

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
  return scheduledPaymentsAgainst(state.liabilities, state.liabilityBalances, month);
}

/**
 * The scheduled payments for `months` consecutive months starting at `month`, one map per month,
 * index 0 being `month` itself — the debt half of a year's funding need, with each debt's payments
 * landing in the months it is actually scheduled to make them.
 *
 * This exists because the year-start tax estimate ({@link
 * import("./taxYearProjection").projectKnownTaxYear}) has to know what the coming twelve months
 * cost, and holding JANUARY's payment flat across all twelve is wrong in both directions: a loan
 * that matures in June keeps being charged for six months it does not exist, inflating the year's
 * forecast decumulation and so its estimated tax, and a loan originating in July is charged for
 * none of the six months it does exist, deflating them. Neither is a rounding error — a mortgage
 * is often the largest line in the budget.
 *
 * It is a deterministic walk of terms already on the balance sheet, NOT a second simulation: each
 * liability's own {@link SimLiability.monthlyPaymentCents} against a working balance advanced by
 * the very function the real month advances with ({@link advancedLiabilityBalanceCents}), so
 * origination, amortization, a scheduled lump-sum transfer and the final payoff-capped payment all
 * fall exactly where the run will put them. No accounts, no waterfall, no `simulateHousehold`.
 *
 * It assumes every payment is FUNDED IN FULL, which is the assumption the whole estimate rests on:
 * the alternative is knowing the year's shortfalls before forecasting the funding that causes
 * them. A household too short to pay its debts has a December true-up, not an estimate problem.
 */
export function forecastLiabilityPayments(
  state: SimState,
  month: number,
  months: number,
): Map<string, Cents>[] {
  const balances = new Map(state.liabilityBalances);
  const byMonth: Map<string, Cents>[] = [];
  for (let m = month; m < month + months; m++) {
    const payments = scheduledPaymentsAgainst(state.liabilities, balances, m);
    byMonth.push(payments);
    for (const liab of state.liabilities) {
      balances.set(
        liab.id,
        advancedLiabilityBalanceCents(liab, m, balances.get(liab.id) ?? 0, payments.get(liab.id) ?? 0),
      );
    }
  }
  return byMonth;
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
    state.liabilityBalances.set(
      liab.id,
      advancedLiabilityBalanceCents(
        liab,
        month,
        state.liabilityBalances.get(liab.id) ?? 0,
        appliedPayments.get(liab.id) ?? 0,
      ),
    );
  }
}

/**
 * What one liability's balance becomes after `month` — origination, lump-sum transfers, interest
 * and the payment actually funded, in that order. PURE, so the year-ahead forecast ({@link
 * forecastLiabilityPayments}) can walk a debt forward on its own working balances through the
 * exact rule the run advances by, rather than a lookalike that drifts from it.
 */
export function advancedLiabilityBalanceCents(
  liability: SimLiability,
  month: number,
  balanceCents: Cents,
  appliedPaymentCents: Cents,
): Cents {
  if (month < liability.startMonth) return balanceCents; // not originated yet — stays at 0
  // Origination: balance appears with no interest or payment, mirroring an account's opening
  // balance at month 0.
  if (month === liability.startMonth) return liability.openingBalanceCents;

  let bal = balanceCents;
  for (const t of liability.getTransfersAt(month)) {
    const fixed = t.amountCents ?? 0;
    const proportional = Math.round(bal * (t.proportionalFraction ?? 0));
    bal = Math.max(0, bal + fixed + proportional);
  }
  if (bal <= 0) return 0;
  bal = Math.round(bal * (1 + liability.apr / 12));
  return Math.max(0, bal - appliedPaymentCents);
}
