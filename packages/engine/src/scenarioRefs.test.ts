import { describe, expect, it } from "vitest";
import {
  resolveRefs,
  PRIMARY_PERSON_REF,
  SAVINGS_REF,
  BROKERAGE_REF,
  RETIREMENT_REF,
} from "./scenarioRefs";
import { SAVINGS_ID } from "./projectionBase";
import { ref } from "./scenarioInput";
import type { ScenarioInput } from "./scenarioInput";

/** A minimal, ref-free scenario; each test layers only the entries it exercises on top. */
const base: ScenarioInput = {
  name: "Test",
  startYear: 2026,
  openingBalanceCents: 0,
  savingsReturnPct: 2,
  retirementReturnPct: 6,
  brokerageReturnPct: 5,
  sharedScheme: "proportional",
  inflationPct: 2,
  currentAge: 30,
  retirementAge: 65,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
};

describe("resolveRefs", () => {
  it("accepts a document whose refs resolve to earlier entries and well-known ids", () => {
    const input: ScenarioInput = {
      ...base,
      events: [
        { type: "takeLoan", ref: ref("student"), month: 0, ownerRef: PRIMARY_PERSON_REF,
          openingBalanceCents: 3_000_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
        { type: "payOffDebt", month: 60, liabilityRef: ref("student"), accountRef: RETIREMENT_REF,
          amountCents: 500_000 },
      ],
    };
    const result = resolveRefs(input);
    expect(result.ok).toBe(true);
  });

  it("resolves the plan's standing accounts and primary person as well-known ids", () => {
    const result = resolveRefs({
      ...base,
      jobs: [
        { ownerRef: PRIMARY_PERSON_REF, startYear: 2026, endYear: 2090,
          salary: { startingSalaryCents: 8_000_000, currentSalaryCents: 8_000_000, realGrowthPct: 1 },
          deferral: { deferralFraction: 0.1, fundAccountRef: RETIREMENT_REF } },
      ],
      events: [
        { type: "buyHome", month: 12, ownerRef: PRIMARY_PERSON_REF, purchasePriceCents: 40_000_000,
          downPaymentCents: 8_000_000, downPaymentSourceRefs: [SAVINGS_REF, BROKERAGE_REF],
          mortgageApr: 0.06, mortgageTermMonths: 360 },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("resolves a ref naming a declared goal to its derived fund account", () => {
    // A goal only DECLARES a name; a budget line points at it, so the graph is sound iff the goal's
    // name is addressable — the applier turns it into `goalFundAccountId`, not the goal id.
    const result = resolveRefs({
      ...base,
      goals: [
        { ref: ref("house"), name: "House", targetCents: 5_000_000, annualReturnPct: 3,
          disposition: "retain", targetDate: "asap" },
      ],
      budgetLines: [
        { label: "House fund", category: "savings", amountSource: { kind: "fillToLimit" },
          target: { kind: "account", accountRef: ref("house"), taxTreatment: "postTax" } },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a duplicate ref, naming the offending entry", () => {
    const result = resolveRefs({
      ...base,
      events: [
        { type: "takeLoan", ref: ref("debt"), month: 0, ownerRef: PRIMARY_PERSON_REF,
          openingBalanceCents: 100_000, apr: 0.2, kind: "creditCard", creditLimitCents: 500_000 },
        { type: "takeLoan", ref: ref("debt"), month: 6, ownerRef: PRIMARY_PERSON_REF,
          openingBalanceCents: 200_000, apr: 0.1, kind: "studentLoan", termMonths: 120 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.ref).toBe("debt");
    expect(result.error.eventIndex).toBe(1);
  });

  it("refuses a ref that shadows a well-known id", () => {
    const result = resolveRefs({
      ...base,
      goals: [
        { ref: SAVINGS_REF, name: "Rainy day", targetCents: 1_000_000, annualReturnPct: 2,
          disposition: "retain", targetDate: "asap" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.ref).toBe(SAVINGS_ID);
  });

  it("refuses an unresolvable ref", () => {
    const result = resolveRefs({
      ...base,
      events: [
        { type: "payOffDebt", month: 12, liabilityRef: ref("ghost"), accountRef: SAVINGS_REF,
          amountCents: 100_000 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.ref).toBe("ghost");
    expect(result.error.eventIndex).toBe(0);
  });

  it("refuses a forward ref — a payoff before the loan it names, by month", () => {
    // Authored payoff-first, and even so the loan sorts earlier by month; reverse the months and
    // the same pair must be refused.
    const result = resolveRefs({
      ...base,
      events: [
        { type: "payOffDebt", month: 12, liabilityRef: ref("loan"), accountRef: SAVINGS_REF,
          amountCents: 100_000 },
        { type: "takeLoan", ref: ref("loan"), month: 40, ownerRef: PRIMARY_PERSON_REF,
          openingBalanceCents: 300_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.ref).toBe("loan");
    expect(result.error.eventIndex).toBe(0);
  });

  it("accepts the same pair once the loan precedes the payoff by month", () => {
    // Authored payoff-first, loan-second, but the loan's earlier month sorts it ahead — proving
    // resolution follows applied order, not array order.
    const result = resolveRefs({
      ...base,
      events: [
        { type: "payOffDebt", month: 40, liabilityRef: ref("loan"), accountRef: SAVINGS_REF,
          amountCents: 100_000 },
        { type: "takeLoan", ref: ref("loan"), month: 12, ownerRef: PRIMARY_PERSON_REF,
          openingBalanceCents: 300_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected acceptance");
    // The schedule is returned in applied (month) order, carrying original indices.
    expect(result.order.map((s) => s.index)).toEqual([1, 0]);
  });
});
