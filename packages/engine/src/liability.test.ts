import { describe, it, expect } from "vitest";
import {
  computeAmortizingPaymentCents,
  amortizationScheduleCents,
  minCreditCardPaymentCents,
  derivePaymentStatus,
  deriveLoanStatus,
  AmortizingLoan,
  RevolvingCard,
  SYNTHETIC_CREDIT_CARD_APR,
  SYNTHETIC_CARD_ID,
  SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
} from "./liability";
import { dollarsToCents } from "./cashFlowSeries";

describe("computeAmortizingPaymentCents", () => {
  it("ANCHOR: $200k @ 6% APR, 360 months ≈ $1,199.10/mo", () => {
    const payment = computeAmortizingPaymentCents(dollarsToCents(200_000), 0.06, 360);
    expect(Math.abs(payment - 119_910)).toBeLessThanOrEqual(1);
  });

  it("0% APR: payment = principal / term", () => {
    const payment = computeAmortizingPaymentCents(dollarsToCents(12_000), 0, 12);
    expect(payment).toBe(dollarsToCents(1_000));
  });

  it("term=0 returns 0", () => {
    expect(computeAmortizingPaymentCents(dollarsToCents(10_000), 0.05, 0)).toBe(0);
  });

  it("payment exceeds monthly interest (loan makes forward progress)", () => {
    const principal = dollarsToCents(10_000);
    const apr = 0.08;
    const payment = computeAmortizingPaymentCents(principal, apr, 60);
    const firstMonthInterest = Math.round(principal * (apr / 12));
    expect(payment).toBeGreaterThan(firstMonthInterest);
  });

  it("ANCHOR: amortizing 360 payments drives balance to ~$0 (within $2 rounding)", () => {
    const L = dollarsToCents(200_000);
    const apr = 0.06;
    const n = 360;
    const payment = computeAmortizingPaymentCents(L, apr, n);
    let bal = L;
    for (let i = 0; i < n; i++) {
      const interest = Math.round(bal * (apr / 12));
      bal = Math.max(0, bal + interest - payment);
    }
    expect(bal).toBeLessThanOrEqual(200);
  });
});

describe("amortizationScheduleCents", () => {
  it("pays off to EXACTLY 0 — no rounding residual (unlike a constant payment)", () => {
    const schedule = amortizationScheduleCents(dollarsToCents(200_000), 0.06, 360);
    // Replay the schedule against the same interest accrual the projection uses.
    let bal = dollarsToCents(200_000);
    for (const payment of schedule) {
      bal = Math.round(bal * (1 + 0.06 / 12)) - payment;
    }
    expect(bal).toBe(0);
  });

  it("returns exactly termMonths payments", () => {
    expect(amortizationScheduleCents(dollarsToCents(10_000), 0.05, 60)).toHaveLength(60);
  });

  it("every month is the level payment except the final one, which is smaller", () => {
    const L = dollarsToCents(200_000);
    const level = computeAmortizingPaymentCents(L, 0.06, 360);
    const schedule = amortizationScheduleCents(L, 0.06, 360);
    for (let i = 0; i < schedule.length - 1; i++) {
      expect(schedule[i]).toBe(level);
    }
    const last = schedule[schedule.length - 1];
    expect(last).toBeLessThanOrEqual(level);
    expect(last).toBeGreaterThan(0);
  });

  it("zero-APR loan: pays off to exactly 0 with level principal", () => {
    const schedule = amortizationScheduleCents(dollarsToCents(12_000), 0, 12);
    let bal = dollarsToCents(12_000);
    for (const payment of schedule) bal -= payment;
    expect(bal).toBe(0);
    expect(schedule).toHaveLength(12);
  });

  it("empty schedule for non-positive term", () => {
    expect(amortizationScheduleCents(dollarsToCents(1_000), 0.05, 0)).toEqual([]);
  });
});

describe("minCreditCardPaymentCents", () => {
  it("2% of $5,000 = $100", () => {
    expect(minCreditCardPaymentCents(dollarsToCents(5_000))).toBe(dollarsToCents(100));
  });

  it("2% of $1,000 = $20, floor to $25 minimum", () => {
    expect(minCreditCardPaymentCents(dollarsToCents(1_000))).toBe(2_500);
  });

  it("$0 balance → $0 (no payment)", () => {
    expect(minCreditCardPaymentCents(0)).toBe(0);
  });

  it("negative balance → $0 (overpaid card)", () => {
    expect(minCreditCardPaymentCents(-1_000)).toBe(0);
  });
});

describe("AmortizingLoan / RevolvingCard split", () => {
  it("AmortizingLoan.monthlyPaymentCents follows the amortization schedule from origination", () => {
    const loan = new AmortizingLoan({
      id: "mortgage",
      ownerId: "p1",
      kind: "mortgage",
      openingBalanceCents: dollarsToCents(200_000),
      apr: 0.06,
      termMonths: 360,
    });
    // Month 1 (startMonth 0 + 1) is the first scheduled payment: the level payment ≈ $1,199.10.
    expect(Math.abs(loan.monthlyPaymentCents(dollarsToCents(200_000), 1) - 119_910)).toBeLessThanOrEqual(1);
    // A tiny remaining balance is never over-charged — the payment caps at the payoff amount.
    expect(loan.monthlyPaymentCents(1_000, 5)).toBeLessThanOrEqual(Math.round(1_000 * (1 + 0.06 / 12)));
    expect(loan.kind).toBe("mortgage");
    expect(loan.termMonths).toBe(360);
  });

  it("RevolvingCard.monthlyPaymentCents is the balance-driven minimum payment, capped at payoff", () => {
    const card = new RevolvingCard({
      id: "visa",
      ownerId: "p1",
      openingBalanceCents: dollarsToCents(3_000),
      apr: 0.22,
      creditLimitCents: dollarsToCents(10_000),
    });
    // 2% of $5,000 = $100 minimum, well below the payoff amount → the minimum stands.
    expect(card.monthlyPaymentCents(dollarsToCents(5_000), 1)).toBe(dollarsToCents(100));
    // A near-zero balance is capped at what's actually owed, not the $25 floor.
    expect(card.monthlyPaymentCents(100, 1)).toBe(Math.round(100 * (1 + 0.22 / 12)));
    expect(card.kind).toBe("creditCard");
    expect(card.creditLimitCents).toBe(dollarsToCents(10_000));
  });

  it("a paid-off balance yields a 0 payment for either kind", () => {
    const loan = new AmortizingLoan({
      id: "auto",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.05,
      termMonths: 60,
    });
    const card = new RevolvingCard({
      id: "visa",
      ownerId: "p1",
      openingBalanceCents: 0,
      apr: 0.22,
      creditLimitCents: dollarsToCents(10_000),
    });
    expect(loan.monthlyPaymentCents(0, 1)).toBe(0);
    expect(card.monthlyPaymentCents(0, 1)).toBe(0);
  });

  it("a RevolvingCard with no explicit limit is unbounded (null)", () => {
    const card = new RevolvingCard({
      id: "visa",
      ownerId: "p1",
      openingBalanceCents: 0,
      apr: 0.22,
    });
    expect(card.creditLimitCents).toBeNull();
  });

  it("liquid is always false", () => {
    const loan = new AmortizingLoan({
      id: "auto",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.05,
      termMonths: 60,
    });
    expect(loan.liquid).toBe(false);
  });

  it("SYNTHETIC_CREDIT_CARD_APR is 22%", () => {
    expect(SYNTHETIC_CREDIT_CARD_APR).toBe(0.22);
  });

  it("SYNTHETIC_CARD_ID is a non-empty string", () => {
    expect(typeof SYNTHETIC_CARD_ID).toBe("string");
    expect(SYNTHETIC_CARD_ID.length).toBeGreaterThan(0);
  });

  it("SYNTHETIC_CARD_CREDIT_LIMIT_CENTS is a finite, positive limit (#36)", () => {
    // Must be finite (not null/unlimited) so the §5.1 cascade can be exhausted and
    // isInsolvent can fire; a whole number of cents.
    expect(Number.isFinite(SYNTHETIC_CARD_CREDIT_LIMIT_CENTS)).toBe(true);
    expect(SYNTHETIC_CARD_CREDIT_LIMIT_CENTS).toBeGreaterThan(0);
    expect(Number.isInteger(SYNTHETIC_CARD_CREDIT_LIMIT_CENTS)).toBe(true);
  });
});

describe("Liability one-time transfers (v1-seam)", () => {
  it("stores a transfer and returns it at its month, not others", () => {
    const loan = new AmortizingLoan({
      id: "mortgage",
      ownerId: "p1",
      kind: "mortgage",
      openingBalanceCents: dollarsToCents(200_000),
      apr: 0.06,
      termMonths: 360,
    });
    // Payoff = negative amount (added to owed balance, per the sign convention).
    loan.addTransfer({ month: 24, amountCents: -dollarsToCents(10_000) });
    expect(loan.getTransfersAt(24)).toEqual([
      { month: 24, amountCents: -dollarsToCents(10_000) },
    ]);
    expect(loan.getTransfersAt(25)).toEqual([]);
  });

  it("returns every transfer scheduled at the same month", () => {
    const loan = new AmortizingLoan({
      id: "auto",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.05,
      termMonths: 60,
    });
    loan.addTransfer({ month: 12, amountCents: -dollarsToCents(1_000) });
    loan.addTransfer({ month: 12, proportionalFraction: -0.5 });
    expect(loan.getTransfersAt(12)).toHaveLength(2);
  });
});

describe("derivePaymentStatus (v1-seam: partial/missed not reachable in-sim yet)", () => {
  it("applied === expected → full (the everyday case, and the payoff month)", () => {
    // The payoff month legitimately pays LESS than the level payment; because
    // `expected` is the payoff-capped figure it equals `applied`, so it is full.
    expect(derivePaymentStatus(120_000, 120_000)).toBe("full");
    expect(derivePaymentStatus(3_711, 3_711)).toBe("full");
  });

  it("applied > expected → full (overpayment is never short)", () => {
    expect(derivePaymentStatus(150_000, 120_000)).toBe("full");
  });

  it("0 < applied < expected → partial (future underpayment channel)", () => {
    expect(derivePaymentStatus(80_000, 120_000)).toBe("partial");
  });

  it("applied === 0 with a payment due → missed", () => {
    expect(derivePaymentStatus(0, 120_000)).toBe("missed");
  });

  it("no payment expected → full (nothing was owed to fall short on)", () => {
    expect(derivePaymentStatus(0, 0)).toBe("full");
  });
});

describe("deriveLoanStatus (v1-seam: delinquent not reachable in-sim yet)", () => {
  it("full → current", () => {
    expect(deriveLoanStatus("full")).toBe("current");
  });

  it("partial → delinquent", () => {
    expect(deriveLoanStatus("partial")).toBe("delinquent");
  });

  it("missed → delinquent", () => {
    expect(deriveLoanStatus("missed")).toBe("delinquent");
  });
});
