import { describe, it, expect } from "vitest";
import { runWaterfall, type WaterfallInput, type IncomeSourceMonth } from "./waterfall";
import {
  assertTaxAttributionReconciles,
  assertPersonTaxBreakdownReconciles,
} from "./waterfallInvariants";
import type { SimGoal } from "../goal";
import { dollarsToCents } from "../cashFlowSeries";

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
    computeTaxByCategoryCents: () => ({}), // zero tax → empty breakdown (required seam)
    remainingDeferralRoomCents: () => Infinity,
    ...over,
  };
}

const wageSource = (ownerId: string, waterfallInflowCents: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents,
  taxCategory: "wages",
});

/**
 * Per-category breakdown for an additively-separable scalar tax fn. Do NOT wrap a *spying*
 * computeTaxCents — it would call the spy again and double-count it.
 */
function separableBreakdown(
  computeTaxCents: (byCat: Partial<Record<string, number>>) => number,
): (byCat: Partial<Record<string, number>>) => Partial<Record<string, number>> {
  return (byCat) => {
    const out: Partial<Record<string, number>> = {};
    for (const [cat, cents] of Object.entries(byCat)) {
      if (!cents) continue;
      const t = computeTaxCents({ [cat]: cents });
      if (t) out[cat] = t;
    }
    return out;
  };
}

describe("runWaterfall — pre-tax deferrals (step 1)", () => {
  it("a source with NO plan descriptor defers nothing; all take-home idles in liquid", () => {
    const r = runWaterfall(
      makeInput({ incomeSources: [wageSource("p1", dollarsToCents(5000))] }),
    );
    expect(r.deferredByPersonCents.get("p1") ?? 0).toBe(0);
    expect(r.accountDepositsCents.get("401k")).toBeUndefined();
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(5000));
  });

  it("a plan-bearing source defers its % into the fund account, pre-tax", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            waterfallInflowCents: dollarsToCents(5000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 0.1, fundAccountId: "401k" },
          },
        ],
      }),
    );
    expect(r.deferredByPersonCents.get("p1")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("401k")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(4500));
  });

  it("employer match is added on top, funds the same account, and does NOT reduce take-home", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            waterfallInflowCents: dollarsToCents(5000),
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
    expect(r.accountDepositsCents.get("401k")).toBe(dollarsToCents(750));
    // Match doesn't share the cap and isn't from take-home: still $4500 idle.
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
            waterfallInflowCents: dollarsToCents(5000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k" }, // wants all $5000
          },
        ],
        remainingDeferralRoomCents: () => dollarsToCents(2000), // only $2000 room left
      }),
    );
    expect(r.deferredByPersonCents.get("p1")).toBe(dollarsToCents(2000));
    expect(r.accountDepositsCents.get("401k")).toBe(dollarsToCents(2000));
    // The $3000 overflow re-enters as taxable cash.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(3000));
  });

  it("combined deferral across two jobs shares ONE annual limit (per person)", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            waterfallInflowCents: dollarsToCents(4000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k-a" },
          },
          {
            ownerId: "p1",
            waterfallInflowCents: dollarsToCents(4000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k-b" },
          },
        ],
        remainingDeferralRoomCents: () => dollarsToCents(5000),
      }),
    );
    // First job fills to $4000; the second has only $1000 of the $5000 left.
    expect(r.deferredByPersonCents.get("p1")).toBe(dollarsToCents(5000));
    expect(r.accountDepositsCents.get("401k-a")).toBe(dollarsToCents(4000));
    expect(r.accountDepositsCents.get("401k-b")).toBe(dollarsToCents(1000));
  });
});

describe("runWaterfall — tax seam (seam 1)", () => {
  it("computeTax is applied per-category to taxable = gross − deferral, not gross", () => {
    const seen: Array<Partial<Record<string, number>>> = [];
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            waterfallInflowCents: dollarsToCents(5000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 0.2, fundAccountId: "401k" }, // $1000 deferred
          },
        ],
        computeTaxCents: (byCat) => {
          seen.push(byCat);
          return Math.round((byCat.wages ?? 0) * 0.1);
        },
        // Matching breakdown, computed directly so it doesn't pollute `seen`.
        computeTaxByCategoryCents: (byCat) => {
          const t = Math.round((byCat.wages ?? 0) * 0.1);
          return t > 0 ? { wages: t } : {};
        },
      }),
    );
    expect(seen).toEqual([{ wages: dollarsToCents(4000) }]);
    expect(r.taxCents).toBe(dollarsToCents(400));
    // Take-home = 5000 − 1000 deferral − 400 tax.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(3600));
  });

  it("non-wage income (no plan descriptor) reaches the seam at its own category, post-deferral", () => {
    const seen: Array<Partial<Record<string, number>>> = [];
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          { ownerId: "p1", waterfallInflowCents: dollarsToCents(2000), taxCategory: "governmentRetirementBenefit" },
        ],
        computeTaxCents: (byCat) => {
          seen.push(byCat);
          return 0;
        },
      }),
    );
    expect(seen).toEqual([{ governmentRetirementBenefit: dollarsToCents(2000) }]);
    expect(r.deferredByPersonCents.get("p1") ?? 0).toBe(0);
  });

  it("passes the full benefit gross to the seam, which owns the inclusion %", () => {
    const seen: Array<Partial<Record<string, number>>> = [];
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            waterfallInflowCents: dollarsToCents(2000),
            taxCategory: "governmentRetirementBenefit",
          },
        ],
        // The jurisdiction applies the 85% inclusion before its 10% rate: 2000 × 0.85 × 0.1.
        computeTaxCents: (byCat) => {
          seen.push(byCat);
          return Math.round((byCat.governmentRetirementBenefit ?? 0) * 0.85 * 0.1);
        },
        computeTaxByCategoryCents: (byCat) => {
          const t = Math.round((byCat.governmentRetirementBenefit ?? 0) * 0.85 * 0.1);
          return t > 0 ? { governmentRetirementBenefit: t } : {};
        },
        liquidAccountId: "checking",
      }),
    );
    expect(seen).toEqual([{ governmentRetirementBenefit: dollarsToCents(2000) }]);
    expect(r.taxCents).toBe(dollarsToCents(170));
    // Take-home is gross − tax: the untaxed 15% is still spendable cash.
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(1830));
  });
});

describe("runWaterfall — shared obligations (step 3)", () => {
  it("proportional (default): the higher earner covers the bigger share, sums exactly", () => {
    const r = runWaterfall(
      makeInput({
        personIds: ["hi", "lo"],
        incomeSources: [wageSource("hi", dollarsToCents(6000)), wageSource("lo", dollarsToCents(2000))],
        sharedObligationCents: dollarsToCents(4000),
        liquidAccountId: "checking",
      }),
    );
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
    // Even split = $1500 each.
    expect(r.shortfallCents).toBe(dollarsToCents(1500));
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
    expect(r.shortfallCents).toBe(dollarsToCents(3000));
    expect(r.accountDepositsCents.size).toBe(0);
    expect(Number.isFinite(r.shortfallCents)).toBe(true);
  });
});

describe("runWaterfall — goals (steps 4–5, fund-to-pace)", () => {
  // Dated goals are deadline-paced: amounts read as target ÷ months left.
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
    disposition: "retain",
    scope: "shared",
  });

  it("funds each dated goal to its sinking-fund pace, not to full", () => {
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
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(1000));
  });

  it("two affordable goals both reach their pace REGARDLESS of priority order", () => {
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
    expect(reversed.accountDepositsCents.get("house")).toBe(
      forward.accountDepositsCents.get("house"),
    );
    expect(reversed.accountDepositsCents.get("car")).toBe(forward.accountDepositsCents.get("car"));
  });

  it("under scarcity, priority decides who falls behind", () => {
    // Both paces are $1,000/mo but only $1,500 is available.
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(1500))],
        goals: [
          datedGoal("house", 2, dollarsToCents(24000), "house", 24),
          datedGoal("car", 1, dollarsToCents(12000), "car", 12),
        ],
      }),
    );
    expect(r.accountDepositsCents.get("car")).toBe(dollarsToCents(1000));
    expect(r.accountDepositsCents.get("house")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("checking")).toBeUndefined();
  });

  it("a goal-fund's own growth rate lowers its required pace (growth-aware)", () => {
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

  it("asap goals fund from the remainder in priority order AFTER the dated paces", () => {
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
    // The asap goal fills from the $2,000 left after the dated pace.
    expect(r.accountDepositsCents.get("car")).toBe(dollarsToCents(1000));
    expect(r.accountDepositsCents.get("emergency")).toBe(dollarsToCents(2000));
    expect(r.accountDepositsCents.get("checking")).toBeUndefined();
  });

  it("surplus after every pace routes to the swept destination", () => {
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
      disposition: "retain",
      scope: "personal",
      ownerId: "p1",
    };
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        goals: [datedGoal("emergency", 1, dollarsToCents(24000), "emergency", 24), personalGoal],
      }),
    );
    expect(r.accountDepositsCents.get("emergency")).toBe(dollarsToCents(1000));
    expect(r.accountDepositsCents.get("car-fund")).toBe(dollarsToCents(1000));
  });
});

describe("runWaterfall — surplus destination (lever 4)", () => {
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

describe("runWaterfall — account contributions", () => {
  it("funds a contribution into its account, leaving the rest as surplus", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(5000))],
        contributions: [{ accountId: "brokerage", monthlyCents: dollarsToCents(500) }],
      }),
    );
    expect(r.accountDepositsCents.get("brokerage")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(4500));
  });

  it("borrows a committed contribution the pool can't cover — a shortfall, not a smaller save", () => {
    // The whole $500 lands even though only $200 of discretionary can pay for it; the $300
    // remainder is a shortfall the cascade meets from savings/credit.
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3000))],
        sharedObligationCents: dollarsToCents(2800), // only $200 discretionary
        contributions: [{ accountId: "brokerage", monthlyCents: dollarsToCents(500) }],
      }),
    );
    expect(r.accountDepositsCents.get("brokerage")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("checking")).toBeUndefined();
    expect(r.shortfallCents).toBe(dollarsToCents(300));
    // Still conserved: deposits − shortfall = gross − obligations.
    const deposited = [...r.accountDepositsCents.values()].reduce((s, v) => s + v, 0);
    expect(deposited - r.shortfallCents).toBe(dollarsToCents(3000) - dollarsToCents(2800));
  });

  it("adds no shortfall when a contribution fits the discretionary pool", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(5000))],
        sharedObligationCents: dollarsToCents(1000),
        contributions: [{ accountId: "brokerage", monthlyCents: dollarsToCents(500) }],
      }),
    );
    expect(r.shortfallCents).toBe(0);
    expect(r.accountDepositsCents.get("brokerage")).toBe(dollarsToCents(500));
  });

  it("conserves: contributions draw from the same pool, surplus is the residual", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(5000))],
        sharedObligationCents: dollarsToCents(1000),
        contributions: [
          { accountId: "brokerage", monthlyCents: dollarsToCents(500) },
          { accountId: "savings", monthlyCents: dollarsToCents(300) },
        ],
      }),
    );
    const deposited = [...r.accountDepositsCents.values()].reduce((s, v) => s + v, 0);
    // Every discretionary cent is accounted for: gross − obligations = total deposits.
    expect(deposited - r.shortfallCents).toBe(dollarsToCents(5000) - dollarsToCents(1000));
    expect(r.accountDepositsCents.get("brokerage")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("savings")).toBe(dollarsToCents(300));
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(3200)); // 4000 − 500 − 300
  });

  it("lands both committed contributions in full, borrowing what the pool can't cover", () => {
    // $600 discretionary against $1,000 of contributions: both land in full, and the $400
    // the pool can't cover is one shortfall.
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(3600))],
        sharedObligationCents: dollarsToCents(3000),
        contributions: [
          { accountId: "brokerage", monthlyCents: dollarsToCents(500) },
          { accountId: "savings", monthlyCents: dollarsToCents(500) },
        ],
      }),
    );
    expect(r.accountDepositsCents.get("brokerage")).toBe(dollarsToCents(500));
    expect(r.accountDepositsCents.get("savings")).toBe(dollarsToCents(500));
    expect(r.shortfallCents).toBe(dollarsToCents(400));
  });
});

describe("runWaterfall — per-source tax attribution", () => {
  const wageJob = (ownerId: string, sourceId: string, waterfallInflowCents: number): IncomeSourceMonth => ({
    ownerId,
    waterfallInflowCents,
    taxCategory: "wages",
    sourceId,
  });
  // Flat 10% on wages plus an agreeing breakdown, so the waterfall can attribute to sources.
  const flatWageTax = {
    computeTaxCents: (byCat: Partial<Record<string, number>>) => Math.round((byCat.wages ?? 0) * 0.1),
    computeTaxByCategoryCents: (byCat: Partial<Record<string, number>>) => {
      const wagesTax = Math.round((byCat.wages ?? 0) * 0.1);
      return wagesTax > 0 ? { wages: wagesTax } : {};
    },
  };

  it("splits one person's wage tax across their jobs by taxable weight, summing to the total", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          wageJob("p1", "job-a", dollarsToCents(6000)),
          wageJob("p1", "job-b", dollarsToCents(2000)),
        ],
        ...flatWageTax,
      }),
    );
    // Total wage tax = 10% of $8000 = $800, split 6000:2000 → $600 / $200.
    expect(r.taxBySourceCents).toEqual({ "job-a": dollarsToCents(600), "job-b": dollarsToCents(200) });
    expect(r.taxByCategoryCents).toEqual({ wages: dollarsToCents(800) });
    const sourceSum = Object.values(r.taxBySourceCents ?? {}).reduce((s, v) => s + v, 0);
    expect(sourceSum).toBe(r.taxCents); // exact-sum invariant
  });

  it("splits each person's tax across only their own jobs — no cross-person subsidy", () => {
    // Progressive stub: 10% to $4000 taxable, 30% above. p1 ($8000) and p2 ($2000) land in
    // different bands, so their average rates differ and a household-level split by taxable
    // would misattribute.
    const progressive = (wages: number) =>
      Math.round(Math.min(wages, dollarsToCents(4000)) * 0.1 + Math.max(0, wages - dollarsToCents(4000)) * 0.3);
    const r = runWaterfall(
      makeInput({
        personIds: ["p1", "p2"],
        incomeSources: [
          wageJob("p1", "job-a", dollarsToCents(8000)),
          wageJob("p2", "job-b", dollarsToCents(2000)),
        ],
        computeTaxCents: (byCat) => progressive(byCat.wages ?? 0),
        computeTaxByCategoryCents: (byCat) => {
          const t = progressive(byCat.wages ?? 0);
          return t > 0 ? { wages: t } : {};
        },
      }),
    );
    // p1: 4000×10% + 4000×30% = $1600. p2: 2000×10% = $200. Each is a single job, so it
    // bears exactly its owner's tax (a household split by taxable would give job-a $1440).
    expect(r.taxBySourceCents).toEqual({ "job-a": dollarsToCents(1600), "job-b": dollarsToCents(200) });
  });

  it("reports pre-tax deferral per source, keyed like the tax split", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            waterfallInflowCents: dollarsToCents(5000),
            taxCategory: "wages",
            sourceId: "job-a",
            planDescriptor: { deferralFraction: 0.2, fundAccountId: "401k" }, // $1000
          },
          wageJob("p1", "job-b", dollarsToCents(2000)),
        ],
        ...flatWageTax,
      }),
    );
    expect(r.deferralBySourceCents).toEqual({ "job-a": dollarsToCents(1000) });
    // job-b defers nothing, so it is simply absent (not a 0 entry).
    expect(r.deferralBySourceCents["job-b"]).toBeUndefined();
    // Tax is on taxable = ($5000−$1000) + $2000 = $6000 → $600, split 4000:2000.
    expect(r.taxBySourceCents).toEqual({ "job-a": dollarsToCents(400), "job-b": dollarsToCents(200) });
  });

  it("falls back to the tax-category key for a wage source with no sourceId", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [{ ownerId: "p1", waterfallInflowCents: dollarsToCents(3000), taxCategory: "wages" }],
        ...flatWageTax,
      }),
    );
    // No sourceId → keyed by category, matching how the income side bands it.
    expect(r.taxBySourceCents).toEqual({ wages: dollarsToCents(300) });
  });

  it("REJECTS a jurisdiction that charges tax but returns an empty breakdown (attribution contract)", () => {
    // Charging tax while attributing nothing (`{}`) would overstate net take-home by the
    // un-subtracted tax. Fail loudly, never fall back.
    expect(() =>
      runWaterfall(
        makeInput({
          incomeSources: [wageJob("p1", "job-a", dollarsToCents(5000))],
          computeTaxCents: (byCat) => Math.round((byCat.wages ?? 0) * 0.1), // $500
          computeTaxByCategoryCents: () => ({}),
        }),
      ),
    ).toThrow(/does not reconcile/i);
  });

  it("REJECTS a breakdown that does not reconcile to taxCents (partial attribution)", () => {
    // Charges $500, attributes $200 — the missing $300 would vanish from the take-home chart.
    expect(() =>
      runWaterfall(
        makeInput({
          incomeSources: [wageJob("p1", "job-a", dollarsToCents(5000))],
          computeTaxCents: (byCat) => Math.round((byCat.wages ?? 0) * 0.1), // $500
          computeTaxByCategoryCents: () => ({ wages: dollarsToCents(200) }),
        }),
      ),
    ).toThrow(/does not reconcile/i);
  });

  it("carries an empty breakdown under a jurisdiction that taxes nothing", () => {
    // taxCents 0 has nothing to attribute, so the breakdown is `{}` — not absent.
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageJob("p1", "job-a", dollarsToCents(5000))],
        computeTaxCents: () => 0,
      }),
    );
    expect(r.taxCents).toBe(0);
    expect(r.taxBySourceCents).toEqual({});
    expect(r.taxByCategoryCents).toEqual({});
  });

  it("REJECTS offsetting per-person mismatches that would cancel in the household total", () => {
    // A breakdown off by 1¢ per person in OPPOSITE directions: the errors cancel, so the
    // household Σ still equals taxCents and that check alone passes.
    const skewed = {
      computeTaxCents: (byCat: Partial<Record<string, number>>) =>
        Math.round(((byCat.wages ?? 0) + (byCat.ordinaryIncome ?? 0)) * 0.1),
      computeTaxByCategoryCents: (byCat: Partial<Record<string, number>>) => {
        const out: Partial<Record<string, number>> = {};
        if (byCat.wages) out.wages = Math.round(byCat.wages * 0.1) + 1; // over by 1¢
        if (byCat.ordinaryIncome) out.ordinaryIncome = Math.round(byCat.ordinaryIncome * 0.1) - 1; // under by 1¢
        return out;
      },
    };
    expect(() => assertTaxAttributionReconciles(200_00, { A: 100_01, B: 99_99 })).not.toThrow();
    expect(() =>
      runWaterfall(
        makeInput({
          personIds: ["A", "B"],
          incomeSources: [
            { ownerId: "A", waterfallInflowCents: dollarsToCents(1000), taxCategory: "wages" },
            { ownerId: "B", waterfallInflowCents: dollarsToCents(1000), taxCategory: "ordinaryIncome" },
          ],
          ...skewed,
        }),
      ),
    ).toThrow(/does not reconcile for person/i);
  });
});

describe("assertTaxAttributionReconciles (attribution contract)", () => {
  it("throws when the attributed tax does not sum to taxCents", () => {
    expect(() => assertTaxAttributionReconciles(100_00, { "job:a": 60_00 })).toThrow(
      /does not reconcile/i,
    );
  });

  it("passes when the attribution sums to taxCents exactly", () => {
    expect(() =>
      assertTaxAttributionReconciles(100_00, { "job:a": 70_00, "job:b": 30_00 }),
    ).not.toThrow();
  });

  it("throws on any mismatch, down to a single cent (exact reconciliation, no tolerance)", () => {
    // Integer cents + exact apportionment ⇒ the sum must hit `taxCents` on the nose; a 1¢
    // gap either way is a jurisdiction bug, not rounding.
    expect(() => assertTaxAttributionReconciles(100_00, { "job:a": 100_01 })).toThrow(
      /does not reconcile/i,
    );
    expect(() => assertTaxAttributionReconciles(100_00, { "job:a": 99_99 })).toThrow(
      /does not reconcile/i,
    );
    expect(() => assertTaxAttributionReconciles(100_00, { "job:a": 100_00 })).not.toThrow();
  });

  it("is a no-op when no tax is charged (nothing to attribute)", () => {
    expect(() => assertTaxAttributionReconciles(0, {})).not.toThrow();
  });
});

describe("assertPersonTaxBreakdownReconciles (per-person invariant)", () => {
  it("passes when the person's breakdown sums to their scalar tax", () => {
    expect(() =>
      assertPersonTaxBreakdownReconciles("p1", 100_00, { wages: 70_00, capitalGains: 30_00 }),
    ).not.toThrow();
  });

  it("throws when the person's breakdown over- or under-attributes, down to a cent", () => {
    expect(() => assertPersonTaxBreakdownReconciles("p1", 100_00, { wages: 100_01 })).toThrow(
      /person p1/i,
    );
    expect(() => assertPersonTaxBreakdownReconciles("p1", 100_00, { wages: 99_99 })).toThrow(
      /does not reconcile/i,
    );
  });

  it("is satisfied by an empty breakdown for a zero-tax person", () => {
    expect(() => assertPersonTaxBreakdownReconciles("p1", 0, {})).not.toThrow();
  });
});

describe("runWaterfall — unfunded deductions (deductions beyond the waterfall's cash → shortfall)", () => {
  // A savings-interest booking: cash and taxable positive, but waterfallInflowCents 0 because
  // the account was ALREADY CREDITED. Its tax is a deduction the waterfall has no cash to fund.
  const interestBooking = (taxableDollars: number, ownerId = "p1"): IncomeSourceMonth => ({
    ownerId,
    waterfallInflowCents: 0,
    cashInflowCents: dollarsToCents(taxableDollars),
    taxCategory: "ordinaryIncome",
    taxableCents: dollarsToCents(taxableDollars),
  });
  const tax20 = (byCat: Partial<Record<string, number>>): number =>
    Math.round(((byCat.wages ?? 0) + (byCat.ordinaryIncome ?? 0)) * 0.2);
  const tax20Seam = { computeTaxCents: tax20, computeTaxByCategoryCents: separableBreakdown(tax20) };

  it("turns a deduction larger than the cash reaching the waterfall into a shortfall", () => {
    // $500 interest taxed 20% → $100 with no cash reaching the waterfall: the $100 is the
    // whole shortfall (funded downstream by the cascade), not clamped to 0.
    const r = runWaterfall(makeInput({ incomeSources: [interestBooking(500)], ...tax20Seam }));
    expect(r.taxCents).toBe(dollarsToCents(100));
    expect(r.shortfallCents).toBe(dollarsToCents(100));
    expect(r.accountDepositsCents.size).toBe(0); // no positive cash to place
  });

  it("counts the unfunded deduction exactly once, on top of an unmet obligation", () => {
    // $400 obligation with no cash + the $100 unfunded interest tax → $500, each counted once.
    const r = runWaterfall(
      makeInput({
        incomeSources: [interestBooking(500)],
        sharedObligationCents: dollarsToCents(400),
        ...tax20Seam,
      }),
    );
    expect(r.shortfallCents).toBe(dollarsToCents(500));
  });

  it("raises no shortfall when other cash covers the deduction (take-home stays positive)", () => {
    // Wages $5,000 alongside the $500 interest: tax = 20% × $5,500 = $1,100, take-home
    // $3,900. The interest tax is absorbed — no unfunded deduction, no shortfall.
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(5000)), interestBooking(500)],
        ...tax20Seam,
      }),
    );
    expect(r.shortfallCents).toBe(0);
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(3900));
  });

  it("two-person: one partner's surplus covers the other's interest-tax deficit before any asset", () => {
    // Shared cash covers the household's TOTAL obligations — including tax owed on cash
    // credited outside the waterfall — before savings, credit, or insolvency.
    //   A: $500 savings interest (waterfallInflow 0) taxed 20% → $100 deficit, with no cash
    //      of A's own in the waterfall to pay it.
    //   B: $3,000 wages taxed 20% → $600, take-home $2,400. Shared obligation: $2,000.
    // $2,400 of cash covers $2,100 — financeable from cash alone.
    const r = runWaterfall(
      makeInput({
        personIds: ["A", "B"],
        incomeSources: [interestBooking(500, "A"), wageSource("B", dollarsToCents(3000))],
        sharedObligationCents: dollarsToCents(2000),
        ...tax20Seam,
      }),
    );
    expect(r.shortfallCents).toBe(0);
    // No tax dropped or double-counted: A's $100 + B's $600, each once.
    expect(r.taxCents).toBe(dollarsToCents(700));
    // Surplus = cash − obligations − A's interest tax = 2,400 − 2,000 − 100 = 300. ($400 if
    // A's tax were dropped, $200 if double-counted — $300 pins "exactly once".)
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(300));
  });
});

describe("runWaterfall — employee payroll tax (FICA) seam", () => {
  // A flat 7.65%-of-wages stand-in for the real FICA tables, with no cap: the waterfall
  // owns the accumulate-and-difference mechanics, the seam owns the policy. The breakdown
  // seam is REQUIRED alongside the scalar one (runtime-enforced) — `separableBreakdown`
  // derives it since this stand-in only ever looks at `wages`.
  const flatFicaSeam = {
    computePayrollTaxCents: (byCat: Partial<Record<string, number>>) =>
      Math.round((byCat.wages ?? 0) * 0.0765),
    computePayrollTaxByCategoryCents: separableBreakdown((byCat) =>
      Math.round((byCat.wages ?? 0) * 0.0765),
    ),
  };

  it("charges payroll tax on wages and removes it from take-home", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(5000))],
        ...flatFicaSeam,
      }),
    );
    // 7.65% × $5,000 = $382.50, so $4,617.50 idles in liquid.
    expect(r.payrollTaxCents).toBe(38250);
    expect(r.accountDepositsCents.get("checking")).toBe(461750);
  });

  it("charges FICA on the FULL gross — pre-tax 401(k) deferral does not reduce it", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          {
            ownerId: "p1",
            waterfallInflowCents: dollarsToCents(5000),
            taxCategory: "wages",
            planDescriptor: { deferralFraction: 0.1, fundAccountId: "401k" },
          },
        ],
        ...flatFicaSeam,
      }),
    );
    // FICA is 7.65% of the whole $5,000, not the post-deferral $4,500: $382.50 either way?
    // No — $4,500 × 7.65% = $344.25. Pinning $382.50 proves the base is the full gross.
    expect(r.payrollTaxCents).toBe(38250);
    // Take-home = gross − deferral − FICA = 5,000 − 500 − 382.50 = $4,117.50.
    expect(r.accountDepositsCents.get("checking")).toBe(411750);
  });

  it("charges only the year-to-date DIFFERENCE, so a wage cap binds on cumulative earnings", () => {
    // Cap FICA at the first $6,000 of annual wages: below it, 10%; above, nothing more.
    const cappedPayroll = (byCat: Partial<Record<string, number>>) =>
      Math.round(Math.min(byCat.wages ?? 0, dollarsToCents(6000)) * 0.1);
    const cappedSeam = {
      computePayrollTaxCents: cappedPayroll,
      computePayrollTaxByCategoryCents: separableBreakdown(cappedPayroll),
    };
    // $5,000 already earned this year; another $5,000 this month → cumulative $10,000, but
    // only $1,000 of it is still under the $6,000 cap. Charge = 10% × $1,000 = $100.
    const r = runWaterfall(
      makeInput({
        incomeSources: [wageSource("p1", dollarsToCents(5000))],
        priorEarnedByPersonCents: () => ({ wages: dollarsToCents(5000) }),
        ...cappedSeam,
      }),
    );
    expect(r.payrollTaxCents).toBe(dollarsToCents(100));
    // And the month's earnings are reported back for the caller's accumulator.
    expect(r.earnedThisMonthByPersonCents.get("p1")).toEqual({ wages: dollarsToCents(5000) });
  });

  it("does not charge FICA on non-wage income (retirement-account withdrawals booked ordinaryIncome)", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          { ownerId: "p1", waterfallInflowCents: dollarsToCents(4000), taxCategory: "ordinaryIncome" },
        ],
        ...flatFicaSeam,
      }),
    );
    expect(r.payrollTaxCents).toBe(0);
    expect(r.accountDepositsCents.get("checking")).toBe(dollarsToCents(4000));
  });

  it("models the annual-liability semantics: two jobs' combined wages settle ONE cumulative cap, no per-employer reconciliation", () => {
    // A worker with two jobs (two sources, same person) earning $4,000 and $3,000 this
    // month, cap at $6,000/yr, 10% under the cap. The engine never asks "which employer",
    // only the person's COMBINED cumulative wages — the reconciled-annual-liability model,
    // not a per-employer withholding simulation the two jobs would otherwise each cap
    // independently against (which would over-count the cap and under-charge combined FICA).
    const cappedPayroll = (byCat: Partial<Record<string, number>>) =>
      Math.round(Math.min(byCat.wages ?? 0, dollarsToCents(6000)) * 0.1);
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          { ownerId: "p1", waterfallInflowCents: dollarsToCents(4000), taxCategory: "wages", sourceId: "jobA" },
          { ownerId: "p1", waterfallInflowCents: dollarsToCents(3000), taxCategory: "wages", sourceId: "jobB" },
        ],
        computePayrollTaxCents: cappedPayroll,
        computePayrollTaxByCategoryCents: separableBreakdown(cappedPayroll),
      }),
    );
    // Combined $7,000 against a $6,000 cap → only $6,000 is charged: 10% × $6,000 = $600,
    // NOT 10% × $4,000 + 10% × $3,000 = $700 (what two independent per-employer caps would
    // wrongly allow through).
    expect(r.payrollTaxCents).toBe(dollarsToCents(600));
  });

  it("attributes payroll tax back to the source that generated it — a bonus source and a base-salary source split proportionally to earned amount", () => {
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          { ownerId: "p1", waterfallInflowCents: dollarsToCents(4000), taxCategory: "wages", sourceId: "salary" },
          { ownerId: "p1", waterfallInflowCents: dollarsToCents(1000), taxCategory: "wages", sourceId: "bonus" },
        ],
        ...flatFicaSeam,
      }),
    );
    // 7.65% × $5,000 = $382.50 total, split 4:1 between salary and bonus.
    expect(r.payrollTaxCents).toBe(38250);
    expect(r.payrollTaxBySourceCents.salary).toBe(30600); // 4/5 × 38250
    expect(r.payrollTaxBySourceCents.bonus).toBe(7650); // 1/5 × 38250
    expect(
      (r.payrollTaxBySourceCents.salary ?? 0) + (r.payrollTaxBySourceCents.bonus ?? 0),
    ).toBe(r.payrollTaxCents);
  });

  it("attributes NOTHING to a non-wage source sharing the household with a wage earner — the cumulative cap is preserved per person, per category", () => {
    // p1 earns wages (FICA-eligible) alongside ordinaryIncome from a draw (not eligible).
    // The whole payroll charge must land on the wages source, never bleed onto the draw.
    const r = runWaterfall(
      makeInput({
        incomeSources: [
          { ownerId: "p1", waterfallInflowCents: dollarsToCents(5000), taxCategory: "wages", sourceId: "job" },
          { ownerId: "p1", waterfallInflowCents: dollarsToCents(2000), taxCategory: "ordinaryIncome", sourceId: "draw" },
        ],
        ...flatFicaSeam,
      }),
    );
    expect(r.payrollTaxBySourceCents.job).toBe(38250);
    expect(r.payrollTaxBySourceCents.draw ?? 0).toBe(0);
  });

  it("reconciles Σ payrollTaxBySourceCents to payrollTaxCents across two earners in the same household", () => {
    const r = runWaterfall(
      makeInput({
        personIds: ["A", "B"],
        incomeSources: [
          { ownerId: "A", waterfallInflowCents: dollarsToCents(3000), taxCategory: "wages", sourceId: "jobA" },
          { ownerId: "B", waterfallInflowCents: dollarsToCents(7000), taxCategory: "wages", sourceId: "jobB" },
        ],
        ...flatFicaSeam,
      }),
    );
    const attributed = Object.values(r.payrollTaxBySourceCents).reduce((s, v) => s + v, 0);
    expect(attributed).toBe(r.payrollTaxCents);
    expect(r.payrollTaxCents).toBeGreaterThan(0);
  });
});
