import { describe, it, expect } from "vitest";
import { Account } from "./account";
import { dollarsToCents, preciseMonthlyRate } from "./cashFlowSeries";

describe("Account", () => {
  it("opening balance is reported at month 0", () => {
    const acc = new Account({
      id: "brokerage",
      ownerId: "p1",
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: dollarsToCents(10000),
      initialAnnualRate: 0.07,
    });
    expect(acc.openingBalanceCents).toBe(dollarsToCents(10000));
  });

  it("getRateAt returns the initial rate when no changes added", () => {
    const acc = new Account({
      id: "brokerage",
      ownerId: "p1",
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: 0,
      initialAnnualRate: 0.07,
    });
    expect(acc.getRateAt(0)).toBe(0.07);
    expect(acc.getRateAt(100)).toBe(0.07);
  });

  it("addRateChange: rate changes from that month forward only", () => {
    const acc = new Account({
      id: "brokerage",
      ownerId: "p1",
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: 0,
      initialAnnualRate: 0.07,
    });
    acc.addRateChange(24, 0.04); // switched to conservative allocation at month 24

    expect(acc.getRateAt(23)).toBe(0.07);
    expect(acc.getRateAt(24)).toBe(0.04);
    expect(acc.getRateAt(100)).toBe(0.04);
  });

  it("addRateChange: multiple rate changes accumulate correctly", () => {
    const acc = new Account({
      id: "brokerage",
      ownerId: "p1",
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: 0,
      initialAnnualRate: 0.07,
    });
    acc.addRateChange(12, 0.05);
    acc.addRateChange(24, 0.03);

    expect(acc.getRateAt(11)).toBe(0.07);
    expect(acc.getRateAt(12)).toBe(0.05);
    expect(acc.getRateAt(23)).toBe(0.05);
    expect(acc.getRateAt(24)).toBe(0.03);
  });

  it("getMonthlyRateAt is preciseMonthlyRate of the annual rate", () => {
    const acc = new Account({
      id: "brokerage",
      ownerId: "p1",
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: 0,
      initialAnnualRate: 0.07,
    });
    expect(acc.getMonthlyRateAt(0)).toBeCloseTo(preciseMonthlyRate(0.07), 10);
  });

  it("ANCHOR: compounding $10k @ 7% for 10 years yields ≈ $19,671 (closed form)", () => {
    const acc = new Account({
      id: "brokerage",
      ownerId: "p1",
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: dollarsToCents(10000),
      initialAnnualRate: 0.07,
    });

    let balance = acc.openingBalanceCents;
    const monthlyRate = acc.getMonthlyRateAt(0);
    for (let m = 1; m <= 120; m++) {
      balance = Math.round(balance * (1 + monthlyRate));
    }
    // Closed form ≈ $19,671.51; integer-cents rounding lands at $19,671.46 — within a dime
    expect(Math.abs(balance - dollarsToCents(19671.51))).toBeLessThanOrEqual(10);
  });

  it("one-time transfers: getTransfersAt returns only transfers for that month", () => {
    const acc = new Account({
      id: "checking",
      ownerId: "p1",
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    acc.addTransfer({ month: 6, amountCents: dollarsToCents(5000) });
    acc.addTransfer({ month: 6, amountCents: dollarsToCents(-1000) });
    acc.addTransfer({ month: 12, amountCents: dollarsToCents(2000) });

    expect(acc.getTransfersAt(6)).toHaveLength(2);
    expect(acc.getTransfersAt(12)).toHaveLength(1);
    expect(acc.getTransfersAt(0)).toHaveLength(0);
  });

  it("liquid flag is preserved", () => {
    const liquid = new Account({
      id: "checking",
      ownerId: "p1",
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const illiquid = new Account({
      id: "retirement",
      ownerId: "p1",
      liquid: false,
      taxTreatment: "preTax",
      openingBalanceCents: 0,
      initialAnnualRate: 0.07,
    });
    expect(liquid.liquid).toBe(true);
    expect(illiquid.liquid).toBe(false);
  });
});
