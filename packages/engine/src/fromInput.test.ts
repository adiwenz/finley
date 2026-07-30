import { describe, expect, it } from "vitest";
import { Projection } from "./projectionRoot";
import { nullJurisdiction } from "./jurisdiction";
import { PRIMARY_PERSON_ID, SAVINGS_ID, BROKERAGE_ID, goalFundAccountId } from "./projectionBase";
import { RETIREMENT_ID } from "./ids";
import type { ScenarioInput } from "./scenarioInput";

/** A minimal, ref-free scenario; each test layers only the entries it exercises on top. */
const base: ScenarioInput = {
  name: "Test",
  startYear: 2026,
  openingBalanceCents: 5_000_000,
  savingsReturnPct: 2,
  retirementReturnPct: 6,
  brokerageReturnPct: 5,
  sharedScheme: "proportional",
  healthMonthlyCents: 0,
  postCoverageHealthMonthlyCents: 0,
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 4,
  inflationPct: 2,
  currentAge: 30,
  retirementAge: 65,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
};

/** Fails the test if the build was refused — narrows the union and surfaces the reason. */
function built(input: ScenarioInput): Projection {
  const result = Projection.fromInput(input, nullJurisdiction);
  if (!result.ok) throw new Error(`expected a built projection, got: ${result.error.reason}`);
  return result.projection;
}

describe("Projection.fromInput", () => {
  it("mints ids for the plan plane and resolves every account ref", () => {
    const p = built({
      ...base,
      jobs: [
        {
          ref: "primaryJob",
          ownerRef: PRIMARY_PERSON_ID,
          startYear: 2026,
          endYear: null,
          salary: { startingSalaryCents: 8_000_000, realGrowthPct: 1 },
          deferral: { deferralFraction: 0.1, fundAccountRef: RETIREMENT_ID },
        },
      ],
      goals: [
        { ref: "emergency", name: "Emergency", targetCents: 1_000_000, annualReturnPct: 2,
          disposition: "retain", targetDate: "asap" },
      ],
    });

    const [job] = p.plan.jobs;
    expect(job.id).toMatch(/^job-\d+$/);
    expect(job.ownerId).toBe(PRIMARY_PERSON_ID);
    // The account ref resolved to a real, well-known account id — no ref survived the build.
    expect(job.deferral?.fundAccountId).toBe(RETIREMENT_ID);

    const [goal] = p.plan.goals;
    expect(goal.id).toMatch(/^goal-\d+$/);
  });

  it("binds a declared goal ref to its derived fund account, not the goal id", () => {
    const p = built({
      ...base,
      goals: [
        { ref: "house", name: "House", targetCents: 5_000_000, annualReturnPct: 3,
          disposition: "retain", targetDate: "asap" },
      ],
      budgetLines: [
        { label: "House fund", category: "savings", amountSource: { kind: "fillToLimit" },
          target: { kind: "account", accountRef: "house", taxTreatment: "postTax" } },
      ],
    });
    const [goal] = p.plan.goals;
    const [line] = p.plan.budgetLines;
    // The contribution routes into the goal's fund account, not the goal id — the derivation
    // task 2's resolution model promises.
    expect(line.target).toEqual({
      kind: "account",
      accountId: goalFundAccountId(goal),
      taxTreatment: "postTax",
    });
  });

  it("applies events in month order regardless of array position", () => {
    // The payoff is authored FIRST but dated LAST; only a build that sorts by month before
    // applying can resolve its liability, which the loan two array-slots later creates.
    const p = built({
      ...base,
      events: [
        { type: "payOffDebt", month: 60, liabilityRef: "student", accountRef: SAVINGS_ID,
          amountCents: 500_000 },
        { type: "takeLoan", ref: "student", month: 0, ownerRef: PRIMARY_PERSON_ID,
          openingBalanceCents: 3_000_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
      ],
    });
    // Both events landed, the loan minted before the payoff spent from it.
    const months = p.ledger.events.map((e) => e.month).sort((a, b) => a - b);
    expect(months).toEqual([0, 60]);
  });

  it("mints every id off one counter and lets a partner's nested jobs draw from it", () => {
    const p = built({
      ...base,
      events: [
        { type: "marry", ref: "sam", month: 12, name: "Sam", birthYear: 1994,
          jobs: [
            { startYear: 2027, endYear: null,
              salary: { startingSalaryCents: 6_000_000, realGrowthPct: 1 },
              deferral: { deferralFraction: 0.05, fundAccountRef: RETIREMENT_ID } },
          ] },
        { type: "buyHome", month: 36, ownerRef: PRIMARY_PERSON_ID, purchasePriceCents: 40_000_000,
          downPaymentCents: 4_000_000, downPaymentSourceRefs: [SAVINGS_ID, BROKERAGE_ID],
          mortgageApr: 0.06, mortgageTermMonths: 360 },
      ],
    });
    // A run over the built scenario proves the minted ids wire up end to end.
    expect(() => p.run(nullJurisdiction)).not.toThrow();
    const partner = p.ledger.events.find((e) => e.type === "RelationshipEvent");
    expect(partner?.type === "RelationshipEvent" && partner.person.jobs[0].id).toMatch(/^job-\d+$/);
  });

  it("refuses a refusal addEvent raises, naming the offending event and keeping nothing", () => {
    const result = Projection.fromInput(
      {
        ...base,
        events: [
          { type: "marry", ref: "sam", month: 12, name: "Sam", birthYear: 1994 },
          { type: "separate", month: 24, partnerRef: "sam" },
          { type: "separate", month: 36, partnerRef: "sam" },
        ],
      },
      nullJurisdiction,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    // The second separation is index 2 in `events`; a partial projection never escapes.
    expect(result.error.eventIndex).toBe(2);
    expect(result.error.reason).toContain("already separated");
  });

  it("passes a bad ref graph straight through as a refusal", () => {
    const result = Projection.fromInput(
      {
        ...base,
        events: [
          { type: "payOffDebt", month: 12, liabilityRef: "student", accountRef: SAVINGS_ID,
            amountCents: 500_000 },
          { type: "takeLoan", ref: "student", month: 60, ownerRef: PRIMARY_PERSON_ID,
            openingBalanceCents: 3_000_000, apr: 0.05, kind: "studentLoan", termMonths: 120 },
        ],
      },
      nullJurisdiction,
    );
    // The payoff at month 12 forward-references a loan at month 60 — refused by ref resolution
    // before anything is minted.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.ref).toBe("student");
    expect(result.error.eventIndex).toBe(0);
  });
});
