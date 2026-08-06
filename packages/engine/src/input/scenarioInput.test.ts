import { describe, expect, it } from "vitest";
import { eventEntryType, ref } from "./scenarioInput";
import type { EventEntry, ScenarioInput } from "./scenarioInput";

// Types are erased at runtime, so a compiling literal IS the assertion: this document names no
// id anywhere, uses `ref`/`ownerRef`/`accountRef` in every pointer position, and discriminates
// events on `type`. If any of those drifted from the declared shape the file would not compile.
describe("ScenarioInput shape", () => {
  it("declares a whole scenario with refs and no ids", () => {
    const input: ScenarioInput = {
      name: "Test",
      startYear: 2026,
      openingBalanceCents: 0,
      savingsReturnPct: 2,
      retirementReturnPct: 6,
      brokerageReturnPct: 5,
      sharedScheme: "proportional",
      inflationPct: 2,
      birthYear: 1996,
      lifeExpectancy: 90,
      benefitClaimingAge: 67,
      jobs: [
        {
          ref: ref("primaryJob"),
          ownerRef: ref("primary"),
          startYear: 2026,
          endYear: 2090,
          salary: { startingSalaryCents: 8_000_000, currentSalaryCents: 8_000_000, realGrowthPct: 1 },
          deferral: { deferralFraction: 0.1, fundAccountRef: ref("retirement") },
        },
      ],
      goals: [
        { ref: ref("emergency"), name: "Emergency", targetCents: 1_000_000, annualReturnPct: 2,
          disposition: "retain", targetDate: "asap" },
      ],
      budgetLines: [
        { ref: ref("rent"), label: "Rent", category: "needs",
          amountSource: { kind: "literal", monthlyCents: 200_000 },
          target: { kind: "expense" } },
        { ref: ref("iraContrib"), label: "IRA", category: "savings",
          amountSource: { kind: "fillToLimit" },
          target: { kind: "account", accountRef: ref("retirement"), taxTreatment: "preTax" } },
      ],
      events: [
        { type: "takeLoan", ref: ref("student"), month: 0, ownerRef: ref("primary"),
          openingBalanceCents: 3_000_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
        { type: "payOffDebt", month: 60, liabilityRef: ref("student"), accountRef: ref("retirement"),
          amountCents: 500_000 },
      ],
    };
    expect(input.events).toHaveLength(2);
  });

  it("maps each event variant to its own discriminant", () => {
    const entries: readonly EventEntry[] = [
      { type: "marry", month: 12, name: "Sam", birthYear: 1994 },
      { type: "haveChild", month: 24, name: "Kid", annualCostCents: 1_200_000 },
      { type: "takeLoan", month: 0, ownerRef: ref("primary"), openingBalanceCents: 100_000,
        apr: 0.2, kind: "creditCard", creditLimitCents: 500_000 },
      { type: "buyHome", month: 36, ownerRef: ref("primary"), purchasePriceCents: 40_000_000,
        downPaymentCents: 8_000_000, downPaymentSourceRefs: [ref("savings")], mortgageApr: 0.06,
        mortgageTermMonths: 360 },
      { type: "separate", month: 48, partnerRef: ref("sam") },
      { type: "payOffDebt", month: 60, liabilityRef: ref("card"), accountRef: ref("savings"),
        amountCents: 100_000 },
    ];
    // Expected discriminants come from the Shape spec, not recomputed from each entry.
    expect(entries.map(eventEntryType)).toEqual([
      "marry",
      "haveChild",
      "takeLoan",
      "buyHome",
      "separate",
      "payOffDebt",
    ]);
  });
});
