import { describe, it, expect } from "vitest";
import {
  runWaterfall,
  type WaterfallInput,
  type IncomeSourceMonth,
} from "./waterfall";
import type { SimGoal } from "../goal";
import { dollarsToCents } from "../cashFlowSeries";

/** A waterfall input with sensible defaults; override per test. */
function makeInput(over: Partial<WaterfallInput>): WaterfallInput {
  return {
    personIds: ["p1"],
    incomeSources: [],
    sharedObligationCents: 0,
    sharedScheme: "proportional",
    surplusDestination: { kind: "idle" },
    goals: [],
    accountBalanceCents: () => 0,
    liquidAccountId: "checking",
    computeTaxCents: () => 0,
    remainingDeferralRoomCents: () => Infinity,
    ...over,
  };
}

const wageSource = (ownerId: string, grossCents: number): IncomeSourceMonth => ({
  ownerId,
  grossCents,
  taxCategory: "wages",
});

describe("runWaterfall — pre-tax deferrals (§5.0 step 1, §5.5)", () => {
  it("a source with NO plan descriptor defers nothing; all take-home idles in liquid", () => {
    const r = runWaterfall(
      makeInput({ incomeSources: [wageSource("p1", dollarsToCents(5000))] }),
    );
    expect(r.deferredByPersonCents.get("p1") ?? 0).toBe(0);
    expect(r.accountDepositsCents.get("401k")).toBeUndefined();
    // Full $5000 lands as surplus in the liquid account.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(5000));
  });

  it("a plan-bearing source defers its % into the fund account, pre-tax", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            grossCents: dollarsToCents(5000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 0.1, fundAccountId: "401k" },
          },
        ],
      }),
    );
    expect(r.deferredByPersonCents.get("p1")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("401k")).toBe(dollarsToCents(500));
    // The remaining $4500 take-home idles in liquid (no tax stub).
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(4500));
  });

  it("employer match is added on top, funds the same account, and does NOT reduce take-home", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            grossCents: dollarsToCents(5000),
            taxCategory: "wages",
            planDescriptor: {
              deferralFraction: 0.1,
              fundAccountId: "401k",
              employerMatchFraction: 0.5, // 50% of the $500 deferred = $250
            },
          },
        ],
      }),
    );
    // Deferral $500 + match $250 = $750 into the account.
    expect(r.accountDepositsCents.get("401k")).toBe(dollarsToCents(750));
    // Match does not share the cap and is not from take-home: still $4500 idle.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(4500));
    // Only the employee deferral counts against the annual accumulator.
    expect(r.deferredByPersonCents.get("p1")).toBe(dollarsToCents(500));
  });

  it("deferral is capped at the remaining annual room; overflow becomes taxable take-home", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            grossCents: dollarsToCents(5000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k" }, // wants all $5000
          },
        ],
        remainingDeferralRoomCents: () => dollarsToCents(2000), // only $2000 room left
      }),
    );
    expect(r.deferredByPersonCents.get("p1")).toBe(dollarsToCents(2000));
    expect(r.accountDepositsCents.get("401k")).toBe(dollarsToCents(2000));
    // The $3000 overflow re-enters as taxable cash → idles in liquid.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(3000));
  });

  it("combined deferral across two jobs shares ONE annual limit (per person)", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            grossCents: dollarsToCents(4000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k-a" },
          },
          {
            ownerId: "p1",
            grossCents: dollarsToCents(4000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k-b" },
          },
        ],
        remainingDeferralRoomCents: () => dollarsToCents(5000),
      }),
    );
    // First job fills to $4000; second job only has $1000 room left of the $5000.
    expect(r.deferredByPersonCents.get("p1")).toBe(dollarsToCents(5000));
    expect(r.accountDepositsCents.get("401k-a")).toBe(dollarsToCents(4000));
    expect(r.accountDepositsCents.get("401k-b")).toBe(dollarsToCents(1000));
  });
});

describe("runWaterfall — tax seam (§5.3 seam 1)", () => {
  it("computeTax is applied per-category to taxable = gross − deferral, not gross", () => {
    const seen: Array<Partial<Record<string, number>>> = [];
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            grossCents: dollarsToCents(5000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 0.2, fundAccountId: "401k" }, // $1000 deferred
          },
        ],
        computeTaxCents: (byCat) => {
          seen.push(byCat);
          return Math.round((byCat.wages ?? 0) * 0.1); // flat 10% stub on wages
        },
      }),
    );
    // Taxable wages are gross − deferral = $4000; tax = $400.
    expect(seen).toEqual([{ wages: dollarsToCents(4000) }]);
    expect(r.taxCents).toBe(dollarsToCents(400));
    // Take-home = 5000 − 1000 deferral − 400 tax = 3600 idle.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(3600));
  });

  it("non-wage income (no plan descriptor) reaches the seam at its own category, post-deferral", () => {
    const seen: Array<Partial<Record<string, number>>> = [];
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          { ownerId: "p1", grossCents: dollarsToCents(2000), taxCategory: "governmentRetirementBenefit" },
        ],
        computeTaxCents: (byCat) => {
          seen.push(byCat);
          return 0;
        },
      }),
    );
    // No deferral taken; the full $2000 reaches the seam under its own category.
    expect(seen).toEqual([{ governmentRetirementBenefit: dollarsToCents(2000) }]);
    expect(r.deferredByPersonCents.get("p1") ?? 0).toBe(0);
  });

  it("passes the full benefit gross to the seam, which owns the inclusion % (§5.4)", () => {
    const seen: Array<Partial<Record<string, number>>> = [];
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            grossCents: dollarsToCents(2000),
            taxCategory: "governmentRetirementBenefit",
          },
        ],
        // The jurisdiction (not the engine) applies its own 85% inclusion to the
        // benefit category before its 10% rate: tax = 2000 × 0.85 × 0.10 = $170.
        computeTaxCents: (byCat) => {
          seen.push(byCat);
          return Math.round((byCat.governmentRetirementBenefit ?? 0) * 0.85 * 0.1);
        },
        liquidAccountId: "checking",
      }),
    );
    // The seam sees the FULL $2000 gross — the inclusion % is its business now.
    expect(seen).toEqual([{ governmentRetirementBenefit: dollarsToCents(2000) }]);
    expect(r.taxCents).toBe(dollarsToCents(170));
    // Take-home idles the FULL gross minus tax: 2000 − 170 = 1830 (the untaxed
    // 15% is still spendable cash, not lost).
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(1830));
  });
});

describe("runWaterfall — shared obligations (§5.0 step 3)", () => {
  it("proportional (default): the higher earner covers the bigger share, sums exactly", () => {
    const r = runWaterfall(
      makeInput({
        personIds: ["hi", "lo"],
        incomeSources: [wageSource("hi", dollarsToCents(6000)), wageSource("lo", dollarsToCents(2000))],
        sharedObligationCents: dollarsToCents(4000),
        liquidAccountId: "checking",
      }),
    );
    // No shortfall (both cover their share); leftover 8000 − 4000 = 4000 idles.
    expect(r.shortfallCents).toBe(0);
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(4000));
  });

  it("even split: a zero-income partner's half is a shortfall, not smoothed over by the earner", () => {
    const r = runWaterfall(
      makeInput({
        personIds: ["earner", "zero"],
        incomeSources: [wageSource("earner", dollarsToCents(4000))],
        sharedObligationCents: dollarsToCents(3000),
        sharedScheme: "even",
      }),
    );
    // Even split = $1500 each. The zero-income partner cannot cover their $1500 →
    // that $1500 is a shortfall even though the earner has surplus (§5.0 RESOLVED).
    expect(r.shortfallCents).toBe(dollarsToCents(1500));
    // Earner: 4000 − 1500 share = 2500 surplus idles.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(2500));
  });

  it("zero total household income short-circuits the proportional math (no 0/0)", () => {
    const r = runWaterfall(
      makeInput({
        personIds: ["p1", "p2"],
        incomeSources: [],
        sharedObligationCents: dollarsToCents(3000),
        sharedScheme: "proportional",
      }),
    );
    // Whole obligation is a shortfall; nothing deposited; no NaN.
    expect(r.shortfallCents).toBe(dollarsToCents(3000));
    expect(r.accountDepositsCents.size).toBe(0);
    expect(Number.isFinite(r.shortfallCents)).toBe(true);
  });
});

describe("runWaterfall — goals (§5.0 steps 4–5, §5.2, #26 fund-to-pace)", () => {
  // Dated: a `spend` goal needs a month to fire at (§5.2, GoalDisposal). Under #26
  // funding is deadline-PACED (sinking-fund), so amounts read as target ÷ months left.
  const datedGoal = (
    id: string,
    priority: number,
    targetCents: number,
    fundAccountId: string,
    targetDate: number,
  ): SimGoal => ({
    id,
    name: id,
    targetCents,
    targetDate,
    fundAccountId,
    priority,
    disposition: "spend",
    scope: "shared",
  });

  it("funds each dated goal to its sinking-fund pace, not to full (#26)", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        // $24k over 24 months → $1,000/mo pace; $12k over 12 months → $1,000/mo pace.
        goals: [
          datedGoal("house", 1, dollarsToCents(24000), "house", 24),
          datedGoal("car", 2, dollarsToCents(12000), "car", 12),
        ],
      }),
    );
    expect(r.accountDepositsCents.get("house")).toBe(dollarsToCents(1000));
    expect(r.accountDepositsCents.get("car")).toBe(dollarsToCents(1000));
    // $3000 − two $1000 paces → $1000 idles.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(1000));
  });

  it("two affordable goals both reach their pace REGARDLESS of priority order (#26 AC1)", () => {
    const forward = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        goals: [
          datedGoal("house", 1, dollarsToCents(24000), "house", 24),
          datedGoal("car", 2, dollarsToCents(12000), "car", 12),
        ],
      }),
    );
    const reversed = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        goals: [
          datedGoal("house", 2, dollarsToCents(24000), "house", 24),
          datedGoal("car", 1, dollarsToCents(12000), "car", 12),
        ],
      }),
    );
    // Order is a no-op when both paces fit — the amortization decides, not priority.
    expect(reversed.accountDepositsCents.get("house")).toBe(
      forward.accountDepositsCents.get("house"),
    );
    expect(reversed.accountDepositsCents.get("car")).toBe(forward.accountDepositsCents.get("car"));
  });

  it("under scarcity, priority decides who falls behind (#26 AC2)", () => {
    // Both paces are $1,000/mo but only $1,500 is available → priority-1 gets its full
    // pace, priority-2 gets the remainder.
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(1500))],
        goals: [
          datedGoal("house", 2, dollarsToCents(24000), "house", 24),
          datedGoal("car", 1, dollarsToCents(12000), "car", 12),
        ],
      }),
    );
    expect(r.accountDepositsCents.get("car")).toBe(dollarsToCents(1000)); // priority 1: full pace
    expect(r.accountDepositsCents.get("house")).toBe(dollarsToCents(500)); // priority 2: falls behind
    expect(r.accountDepositsCents.get("checking")).toBeUndefined();
  });

  it("a goal-fund's own growth rate lowers its required pace (#26 growth-aware)", () => {
    const flat = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        goals: [datedGoal("house", 1, dollarsToCents(24000), "house", 24)],
      }),
    );
    const grown = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        goals: [datedGoal("house", 1, dollarsToCents(24000), "house", 24)],
        goalFundMonthlyRate: (id) => (id === "house" ? 0.01 : 0),
      }),
    );
    expect(grown.accountDepositsCents.get("house")).toBeLessThan(
      flat.accountDepositsCents.get("house") ?? 0,
    );
  });

  it("re-paces off the current fund balance (no overfunding)", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        // $12k target over 12 months, $6k already saved → $6k over 12 = $500/mo.
        goals: [datedGoal("car", 1, dollarsToCents(12000), "car", 12)],
        accountBalanceCents: (id) => (id === "car" ? dollarsToCents(6000) : 0),
      }),
    );
    expect(r.accountDepositsCents.get("car")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(2500));
  });

  it("asap goals fund from the remainder in priority order AFTER the dated paces (#26 AC4)", () => {
    const asapGoal: SimGoal = {
      id: "emergency",
      name: "emergency",
      targetCents: dollarsToCents(20000),
      targetDate: "asap",
      fundAccountId: "emergency",
      priority: 0, // higher priority than the dated goal, yet paced goals still fund first
      disposition: "retain",
      scope: "shared",
    };
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        goals: [asapGoal, datedGoal("car", 5, dollarsToCents(12000), "car", 12)],
      }),
    );
    // Dated pace ($1,000) is taken first even though the asap goal outranks it; the
    // asap goal then fills from the $2,000 remainder.
    expect(r.accountDepositsCents.get("car")).toBe(dollarsToCents(1000));
    expect(r.accountDepositsCents.get("emergency")).toBe(dollarsToCents(2000));
    expect(r.accountDepositsCents.get("checking")).toBeUndefined();
  });

  it("surplus after every pace routes to the swept destination (#26 AC5)", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        goals: [datedGoal("car", 1, dollarsToCents(12000), "car", 12)],
        surplusDestination: { kind: "swept", accountId: "brokerage" },
      }),
    );
    expect(r.accountDepositsCents.get("car")).toBe(dollarsToCents(1000));
    // The $2,000 beyond the pace is swept, not idled.
    expect(r.accountDepositsCents.get("brokerage")).toBe(dollarsToCents(2000));
    expect(r.accountDepositsCents.get("checking")).toBeUndefined();
  });

  it("personal goals pace from the owner's leftover after shared paces", () => {
    const personalGoal: SimGoal = {
      id: "p1-car",
      name: "car",
      targetCents: dollarsToCents(12000),
      targetDate: 12,
      fundAccountId: "car-fund",
      priority: 5,
      disposition: "spend",
      scope: "personal",
      ownerId: "p1",
    };
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        goals: [datedGoal("emergency", 1, dollarsToCents(24000), "emergency", 24), personalGoal],
      }),
    );
    expect(r.accountDepositsCents.get("emergency")).toBe(dollarsToCents(1000)); // shared pace
    expect(r.accountDepositsCents.get("car-fund")).toBe(dollarsToCents(1000)); // personal pace
  });
});

describe("runWaterfall — surplus destination (lever 4, §5.0)", () => {
  it("swept surplus lands in the named investment account, not liquid", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        surplusDestination: { kind: "swept", accountId: "brokerage" },
      }),
    );
    expect(r.accountDepositsCents.get("brokerage")).toBe(dollarsToCents(3000));
    expect(r.accountDepositsCents.get("checking")).toBeUndefined();
  });
});

describe("runWaterfall — conservation", () => {
  it("deposits + shortfall exactly balance income against obligations", () => {
    const r = runWaterfall(
      makeInput({
        personIds: ["a", "b"],
        incomeSources: [wageSource("a", dollarsToCents(4000)), wageSource("b", dollarsToCents(1000))],
        sharedObligationCents: dollarsToCents(6000),
        goals: [],
      }),
    );
    const deposited = [...r.accountDepositsCents.values()].reduce((s, v) => s + v, 0);
    const totalGross = dollarsToCents(5000);
    // gross − obligations = deposits − shortfall (tax stub = 0, no deferral).
    expect(deposited - r.shortfallCents).toBe(totalGross - dollarsToCents(6000));
  });
});
