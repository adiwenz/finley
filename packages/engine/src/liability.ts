/**
 * Liability — amortizing loan or revolving credit account (§3).
 *
 * Amortizing liabilities (mortgage, auto, studentLoan): the monthly payment
 * is COMPUTED from current balance/rate/term, not entered as an expense line.
 * Uses nominal monthly rate (APR / 12) to match published amortization tables.
 *
 * Credit cards: revolving balance, APR, credit limit, minimum payment
 * (greater of 2% of balance or $25). If no credit card is entered, the
 * simulator uses a synthetic 22% APR card as the shortfall sink (§5.1).
 */

import type { Cents } from "./money";
import type { TaxTreatment, OneTimeTransfer } from "./account";

export type LiabilityKind = "mortgage" | "auto" | "studentLoan" | "creditCard";

/**
 * How a single scheduled payment was serviced this month — the payment-record
 * seam for future partial-payment / negative-amortization work.
 *
 * v1-seam: only `full` is reachable today. The projection always applies the
 * exact scheduled (payoff-capped) payment, so no payment ever comes in short.
 * `partial` and `missed` exist so that when a future underpayment channel lands
 * (e.g. a forbearance or missed-payment event), the model already has a place to
 * record the outcome — no data-shape migration required. See derivePaymentStatus.
 */
export type PaymentStatus = "full" | "partial" | "missed";

/**
 * The servicing state of a loan for a given month — the loan-record seam.
 *
 * v1-seam: only `current` is reachable today (every payment is `full`). Room is
 * deliberately left in the enum for future states such as `forbearance` and
 * `default`; those are NOT populated yet. Delinquency here is derived fresh each
 * month from that month's payment status — there is no arrearage/past-due memory
 * (that state is explicitly deferred). See deriveLoanStatus.
 */
export type LoanStatus = "current" | "delinquent";

/**
 * Classify a payment by comparing what was actually applied against what the
 * engine intended to charge this month. `expectedCents` is the payoff-capped
 * scheduled payment (the figure the projection decided to charge), NOT the raw
 * amortization-table level payment — so a legitimately-smaller final payoff
 * payment (applied === expected) reads as `full`, not `partial`.
 *
 * v1-seam: today the call site passes the same figure for both arguments, so the
 * result is always `full`. The two-argument shape is the seam: a future channel
 * that applies less than expected will surface `partial`/`missed` with no change
 * to this function.
 */
export function derivePaymentStatus(
  amountAppliedCents: Cents,
  expectedCents: Cents,
): PaymentStatus {
  if (expectedCents <= 0 || amountAppliedCents >= expectedCents) return "full";
  if (amountAppliedCents <= 0) return "missed";
  return "partial";
}

/**
 * The loan's servicing status for a month, derived purely from that month's
 * payment status. No cross-month state: a `full` payment is `current`; anything
 * short is `delinquent`. Recovers to `current` the next month a full payment lands.
 */
export function deriveLoanStatus(paymentStatus: PaymentStatus): LoanStatus {
  return paymentStatus === "full" ? "current" : "delinquent";
}

/**
 * Amortizing monthly payment using nominal monthly rate (APR / 12).
 * Matches the convention used in published mortgage/loan amortization tables.
 */
export function computeAmortizingPaymentCents(
  principalCents: Cents,
  apr: number,
  termMonths: number,
): Cents {
  if (termMonths <= 0) return 0;
  // Round the level payment UP to the cent so it always fully amortizes within
  // the term (a rounded-down payment leaves a residual that spills into an extra
  // month). The final payment is smaller — the projection caps it to the
  // remaining balance. This matches how lenders build amortization schedules.
  if (apr === 0) return Math.ceil(principalCents / termMonths);
  const r = apr / 12;
  const factor = Math.pow(1 + r, termMonths);
  return Math.ceil((principalCents * r * factor) / (factor - 1));
}

/**
 * Full amortization schedule: the exact payment for each of the `termMonths`
 * months. Every month charges the level payment (computeAmortizingPaymentCents)
 * except the final month, whose payment is reduced to exactly retire the
 * remaining balance — so the schedule ALWAYS pays the loan off to exactly 0,
 * with no rounding residual.
 *
 * This is the amortization analogue of splitAnnualToMonths: rather than applying
 * one rounded figure N times (which drifts), it returns the exact per-month
 * breakdown that lands on the target. The difference is that each month accrues
 * interest on the running balance, so the correction lands in the final payment
 * instead of being spread cumulatively.
 *
 * The interest accrual here (`round(bal * (1 + r))`) mirrors the projection loop
 * exactly, so the schedule matches what a simulation actually charges.
 */
export function amortizationScheduleCents(
  principalCents: Cents,
  apr: number,
  termMonths: number,
): Cents[] {
  if (termMonths <= 0) return [];
  const level = computeAmortizingPaymentCents(principalCents, apr, termMonths);
  const r = apr / 12;
  const schedule: Cents[] = [];
  let bal = principalCents;
  for (let m = 0; m < termMonths; m++) {
    const owed = Math.round(bal * (1 + r)); // balance after this month's interest
    const payment = Math.min(level, owed); // final month: pay exactly what's owed
    schedule.push(payment);
    bal = owed - payment; // reaches exactly 0 on the last payment
  }
  return schedule;
}

/** Minimum credit card payment: greater of 2% of balance or $25. Returns 0 if balance is 0. */
export function minCreditCardPaymentCents(balanceCents: Cents): Cents {
  if (balanceCents <= 0) return 0;
  return Math.max(Math.round(balanceCents * 0.02), 2500);
}

/** APR of the synthetic credit card used when no real card is entered (§5.1). */
export const SYNTHETIC_CREDIT_CARD_APR = 0.22;

/** ID used in liabilityBalancesCents for the synthetic credit card. */
export const SYNTHETIC_CARD_ID = "synthetic-credit-card";

export class Liability {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: LiabilityKind;
  /** Amount owed when the loan originates (positive = owed). */
  readonly openingBalanceCents: Cents;
  /**
   * Absolute simulation month the loan originates (§4.3). Before it the balance
   * is 0; at it the balance is the opening balance; after it the loan amortizes.
   * Defaults to 0 (present from simulation start).
   */
  readonly startMonth: number;
  readonly apr: number;
  /** Months remaining; null for credit cards. */
  readonly termMonths: number | null;
  /** Credit limit in cents; null for amortizing loans. */
  readonly creditLimitCents: Cents | null;
  /** v1-seam: tax treatment for future withdrawal routing. */
  readonly taxTreatment: TaxTreatment;
  readonly liquid: false = false;

  /**
   * One-time principal adjustments against this liability — the future
   * DebtPayoffEvent (§4.3) lands here as a lump-sum payment. Applied by the
   * projection in step 10, before that month's interest accrues. Mirrors
   * Account's one-time-transfer primitive (§3.2). See addTransfer for the sign
   * convention. v1-seam: the paired cash outflow (this is money leaving a liquid
   * account) is the caller's responsibility — the engine only moves the owed
   * balance, so net-worth conservation requires attaching an Account outflow too.
   */
  private transfers: OneTimeTransfer[] = [];

  constructor(params: {
    id: string;
    ownerId: string;
    kind: LiabilityKind;
    openingBalanceCents: Cents;
    startMonth?: number;
    apr: number;
    termMonths?: number;
    creditLimitCents?: Cents;
    taxTreatment?: TaxTreatment;
  }) {
    this.id = params.id;
    this.ownerId = params.ownerId;
    this.kind = params.kind;
    this.openingBalanceCents = params.openingBalanceCents;
    this.startMonth = params.startMonth ?? 0;
    this.apr = params.apr;
    this.termMonths = params.termMonths ?? null;
    this.creditLimitCents = params.creditLimitCents ?? null;
    this.taxTreatment = params.taxTreatment ?? "taxable";
  }

  isCreditCard(): boolean {
    return this.kind === "creditCard";
  }

  /**
   * Fixed monthly payment for amortizing liabilities, computed from
   * opening balance/rate/term. Returns 0 for credit cards (payment varies
   * with balance — see minCreditCardPaymentCents).
   */
  computeFixedPaymentCents(): Cents {
    if (this.isCreditCard() || this.termMonths === null) return 0;
    return computeAmortizingPaymentCents(this.openingBalanceCents, this.apr, this.termMonths);
  }

  /**
   * Schedule a one-time principal adjustment at `month`. Sign convention matches
   * Account.addTransfer: the amount is ADDED to the owed balance, so a lump-sum
   * PAYMENT is a NEGATIVE amountCents (a new draw would be positive), and a
   * proportionalFraction of -0.5 settles half the balance.
   */
  addTransfer(transfer: OneTimeTransfer): void {
    this.transfers.push(transfer);
    this.transfers.sort((a, b) => a.month - b.month);
  }

  /** All one-time transfers scheduled at exactly `month`. */
  getTransfersAt(month: number): OneTimeTransfer[] {
    return this.transfers.filter((t) => t.month === month);
  }
}
