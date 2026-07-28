/**
 * Liability — amortizing loan or revolving credit account.
 *
 * Amortizing (mortgage, auto, studentLoan): the monthly payment is COMPUTED from
 * balance/rate/term, not entered as an expense line. Nominal monthly rate (APR / 12)
 * matches published amortization tables.
 *
 * Credit cards: revolving balance, APR, credit limit, minimum payment (greater of 2%
 * of balance or $25). With no card entered, the simulator uses a synthetic 22% APR
 * card as the shortfall sink.
 */

import type { Cents } from "./money";
import type { SimOneTimeTransfer } from "./simAccount";

export type LiabilityKind = "mortgage" | "auto" | "studentLoan" | "creditCard";

/** Human-facing labels per {@link LiabilityKind}, so a UI can name a debt by its kind. */
const LIABILITY_KIND_LABELS: Readonly<Record<LiabilityKind, string>> = {
  mortgage: "Mortgage",
  auto: "Auto loan",
  studentLoan: "Student loan",
  creditCard: "Credit card",
};

/** Display label for a liability kind — e.g. `"studentLoan"` → "Student loan". */
export function liabilityKindLabel(kind: LiabilityKind): string {
  return LIABILITY_KIND_LABELS[kind];
}

/**
 * How a scheduled payment was serviced this month.
 *
 * v1-seam: only `full` is reachable — the projection always applies the exact
 * scheduled (payoff-capped) payment, so nothing comes in short. `partial`/`missed`
 * pre-exist so a future underpayment channel (forbearance, missed-payment event)
 * needs no data-shape migration. See derivePaymentStatus.
 */
export type PaymentStatus = "full" | "partial" | "missed";

/**
 * A loan's servicing state for a month.
 *
 * v1-seam: only `current` is reachable (every payment is `full`); room is left for
 * future `forbearance`/`default`. Delinquency is derived fresh each month from that
 * month's payment status — no arrearage/past-due memory. See deriveLoanStatus.
 */
export type LoanStatus = "current" | "delinquent";

/**
 * Classify a payment: applied vs. what the engine intended to charge.
 * `expectedCents` is the payoff-capped scheduled payment, NOT the raw
 * amortization-table level payment — so a legitimately smaller final payoff payment
 * reads as `full`, not `partial`.
 *
 * v1-seam: the call site passes the same figure for both arguments, so the result is
 * always `full`. A future underpayment channel surfaces `partial`/`missed` with no
 * change here.
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
 * Servicing status for a month, derived purely from that month's payment status —
 * no cross-month state. `full` → `current`, anything short → `delinquent`, recovering
 * the next month a full payment lands.
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
  // Round the level payment UP so it fully amortizes within the term; rounding down
  // leaves a residual that spills into an extra month. The projection caps the final
  // payment to the remaining balance, as lenders do.
  if (apr === 0) return Math.ceil(principalCents / termMonths);
  const r = apr / 12;
  const factor = Math.pow(1 + r, termMonths);
  return Math.ceil((principalCents * r * factor) / (factor - 1));
}

/**
 * Exact payment for each of the `termMonths` months: the level payment
 * (computeAmortizingPaymentCents) every month, reduced in the final month to retire
 * the remaining balance — so the schedule ALWAYS pays off to exactly 0, no rounding
 * residual.
 *
 * The amortization analogue of splitAnnualToMonths: an exact per-month breakdown
 * rather than one rounded figure applied N times (which drifts). Because each month
 * accrues interest on the running balance, the correction lands in the final payment
 * instead of being spread. The accrual (`round(bal * (1 + r))`) mirrors the
 * projection loop, so the schedule matches what a simulation charges.
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

/** APR of the synthetic credit card used when no real card is entered. */
export const SYNTHETIC_CREDIT_CARD_APR = 0.22;

/**
 * Default credit limit of the synthetic shortfall card. Finite by design: an
 * unlimited card can never be exhausted, so `isInsolvent` would never fire and a plan
 * financing itself on unbounded revolving debt would read as solvent. $50,000 is a
 * plausible aggregate unsecured revolving limit — enough to absorb a real
 * month-to-month crunch, low enough that indefinite borrowing runs out and is flagged.
 */
export const SYNTHETIC_CARD_CREDIT_LIMIT_CENTS: Cents = 50_000_00;

/** ID used in liabilityBalancesCents for the synthetic credit card. */
export const SYNTHETIC_CARD_ID = "synthetic-credit-card";

/**
 * Behaviour shared by every liability: identity, owed balance/rate/origination,
 * one-time principal adjustments, and the polymorphic monthly-payment hook.
 *
 * A liability is genuinely one of two things — an {@link AmortizingLoan} over a fixed
 * term or a {@link RevolvingCard} with a credit limit. Separate classes off this base
 * remove the impossible states (a card with a term, a loan with a limit, a liability
 * with neither) and let the sim loop call one method instead of branching on kind.
 */
abstract class SimLiabilityBase {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: LiabilityKind;
  /** Amount owed when the loan originates (positive = owed). */
  readonly openingBalanceCents: Cents;
  /**
   * Absolute simulation month of origination: balance 0 before it, the opening
   * balance at it, amortizing after. Defaults to 0 (present from simulation start).
   */
  readonly startMonth: number;
  readonly apr: number;
  readonly liquid: false = false;

  /**
   * One-time principal adjustments — a future DebtPayoffEvent lands here as a
   * lump sum. Applied by the projection in step 10, before that month's interest
   * accrues. Mirrors Account's one-time-transfer primitive; see addTransfer for the
   * sign convention. v1-seam: the paired cash outflow is the caller's job — the
   * engine only moves the owed balance, so net-worth conservation needs an Account
   * outflow attached too.
   */
  private transfers: SimOneTimeTransfer[] = [];

  constructor(params: {
    id: string;
    ownerId: string;
    kind: LiabilityKind;
    openingBalanceCents: Cents;
    startMonth?: number;
    apr: number;
  }) {
    this.id = params.id;
    this.ownerId = params.ownerId;
    this.kind = params.kind;
    this.openingBalanceCents = params.openingBalanceCents;
    this.startMonth = params.startMonth ?? 0;
    this.apr = params.apr;
  }

  /**
   * This month's payment given the current balance. Both kinds cap it at the payoff
   * amount (balance + this month's interest) so a small balance is never
   * over-charged; a paid-off (≤ 0) balance pays nothing.
   */
  abstract monthlyPaymentCents(balanceCents: Cents, month: number): Cents;

  /** Balance grown by exactly this month's interest — the payoff-cap ceiling. */
  protected owedWithInterestCents(balanceCents: Cents): Cents {
    return Math.round(balanceCents * (1 + this.apr / 12));
  }

  /**
   * Schedule a one-time principal adjustment at `month`. Sign convention matches
   * Account.addTransfer: the amount is ADDED to the owed balance, so a lump-sum
   * PAYMENT is NEGATIVE (a new draw positive), and proportionalFraction -0.5 settles
   * half the balance.
   */
  addTransfer(transfer: SimOneTimeTransfer): void {
    this.transfers.push(transfer);
    this.transfers.sort((a, b) => a.month - b.month);
  }

  /** All one-time transfers scheduled at exactly `month`. */
  getTransfersAt(month: number): SimOneTimeTransfer[] {
    return this.transfers.filter((t) => t.month === month);
  }
}

/**
 * A term loan (mortgage, auto, student loan) amortizing to exactly 0 over a fixed
 * term. The per-month schedule is computed once at origination; the monthly payment
 * is a lookup into it, capped at the actual payoff so a lump-sum paydown that drops
 * the balance below the schedule's trajectory retires the loan early.
 */
export class AmortizingLoan extends SimLiabilityBase {
  readonly kind: Exclude<LiabilityKind, "creditCard">;
  readonly termMonths: number;
  /** Exact payment for each month of the term (final payment reduced to the payoff). */
  private readonly schedule: readonly Cents[];

  constructor(params: {
    id: string;
    ownerId: string;
    kind: Exclude<LiabilityKind, "creditCard">;
    openingBalanceCents: Cents;
    startMonth?: number;
    apr: number;
    termMonths: number;
  }) {
    super(params);
    this.kind = params.kind;
    this.termMonths = params.termMonths;
    this.schedule = amortizationScheduleCents(
      params.openingBalanceCents,
      params.apr,
      params.termMonths,
    );
  }

  monthlyPaymentCents(balanceCents: Cents, month: number): Cents {
    if (balanceCents <= 0) return 0;
    // The schedule counts from origination: index 0 is startMonth+1. Past the term it
    // reads undefined → 0 (loan already retired).
    const scheduled = this.schedule[month - this.startMonth - 1] ?? 0;
    return Math.min(scheduled, this.owedWithInterestCents(balanceCents));
  }
}

/**
 * A revolving credit account that never amortizes: balance, APR, credit limit
 * (null = unbounded). Pays the balance-driven minimum, capped at the payoff so a
 * near-zero balance is retired rather than over-charged. The synthetic shortfall card
 * is one of these, with a finite default limit.
 */
export class RevolvingCard extends SimLiabilityBase {
  readonly kind = "creditCard";
  /** Credit limit in cents; null = unbounded. */
  readonly creditLimitCents: Cents | null;

  constructor(params: {
    id: string;
    ownerId: string;
    openingBalanceCents: Cents;
    startMonth?: number;
    apr: number;
    creditLimitCents?: Cents;
  }) {
    super({ ...params, kind: "creditCard" });
    this.creditLimitCents = params.creditLimitCents ?? null;
  }

  monthlyPaymentCents(balanceCents: Cents, _month: number): Cents {
    if (balanceCents <= 0) return 0;
    return Math.min(
      minCreditCardPaymentCents(balanceCents),
      this.owedWithInterestCents(balanceCents),
    );
  }
}

/** A liability in the simulator is exactly one of the two kinds. */
export type SimLiability = AmortizingLoan | RevolvingCard;
