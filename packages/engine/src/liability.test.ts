import { describe, it, expect } from "vitest";
import {
  computeAmortizingPaymentCents,
  amortizationScheduleCents,
  minCreditCardPaymentCents,
  Liability,
  SYNTHETIC_CREDIT_CARD_APR,
  SYNTHETIC_CARD_ID,
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

describe("Liability", () => {
  it("amortizing loan: computeFixedPaymentCents matches opening-balance formula", () => {
    const loan = new Liability({
      id: "mortgage",
      ownerId: "p1",
      kind: "mortgage",
      openingBalanceCents: dollarsToCents(200_000),
      apr: 0.06,
      termMonths: 360,
    });
    expect(Math.abs(loan.computeFixedPaymentCents() - 119_910)).toBeLessThanOrEqual(1);
    expect(loan.isCreditCard()).toBe(false);
  });

  it("credit card: computeFixedPaymentCents is 0; isCreditCard is true", () => {
    const card = new Liability({
      id: "visa",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: dollarsToCents(3_000),
      apr: 0.22,
      creditLimitCents: dollarsToCents(10_000),
    });
    expect(card.computeFixedPaymentCents()).toBe(0);
    expect(card.isCreditCard()).toBe(true);
  });

  it("liquid is always false", () => {
    const loan = new Liability({
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
});

describe("Liability one-time transfers (v1-seam)", () => {
  it("stores a transfer and returns it at its month, not others", () => {
    const loan = new Liability({
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
    const loan = new Liability({
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
