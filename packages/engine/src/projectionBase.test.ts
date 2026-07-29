/**
 * Engine-native wiring tests for the plan→projection mapping. {@link samplePlan} and
 * {@link mockJurisdiction} keep them standalone — no rules package, each test enabling
 * exactly the seam it exercises. The app keeps the real-jurisdiction acceptance tests
 * under `usJurisdiction`.
 */
import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  replayLedger,
  dollarsToCents,
  nullJurisdiction,
  SYNTHETIC_CARD_ID,
  CASH_INTEREST_TAX_PROFILE,
  CAPITAL_GAINS_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
} from "./index";
import {
  createProjectionBase,
  buildPlanAccounts,
  planAccountDescriptors,
  goalFundAccountId,
  type ProjectionContext,
} from "./projectionBase";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { samplePlan, salariedJob, spendLine } from "./testing/samplePlan";
import { compilePersonPriorEarnings } from "./compilePerson";
import type { Plan, GoalPlan } from "./plan";

const START_YEAR = 2026;

function ctx(jurisdiction = nullJurisdiction): ProjectionContext {
  return { jurisdiction, startYear: START_YEAR };
}

function project(plan: Plan, jurisdiction = nullJurisdiction) {
  return replayLedger(emptyLedger, createProjectionBase(plan, ctx(jurisdiction)), jurisdiction);
}

/** Last KNOWN nominal net worth: the final balance, or the terminal value if insolvent. */
function endingNetWorthCents(plan: Plan, jurisdiction = nullJurisdiction): number {
  const known = project(plan, jurisdiction)
    .months.map((m) => m.netWorthNominalCents)
    .filter((c): c is number => c !== null);
  return known[known.length - 1];
}

function netWorthAtAge(plan: Plan, age: number, jurisdiction = nullJurisdiction): number {
  const series = project(plan, jurisdiction);
  return series.months[(age - plan.currentAge) * 12].netWorthNominalCents!;
}

describe("createProjectionBase — general expenses come only from budget lines", () => {
  const generalKinds = (plan: Plan) =>
    createProjectionBase(plan, ctx())
      .initialExpenseSeries!.map((s) => s.spendingSource?.kind)
      .filter((k) => k !== "healthcare");

  it("tags every general-expense series as a budget line", () => {
    // The line-item budget is the sole expense authoring surface; no separate general-expense
    // series rides alongside it.
    expect(generalKinds(samplePlan)).toEqual(["budgetLine"]);
  });

  it("emits no general-expense series when a plan authors no budget lines — only health", () => {
    const base = createProjectionBase({ ...samplePlan, budgetLines: [] }, ctx());
    expect(base.initialExpenseSeries!.map((s) => s.spendingSource?.kind)).toEqual(["healthcare"]);
  });
});

describe("createProjectionBase — retirement + government benefit wired into the graph", () => {
  it("gives the projection person a benefit basis: birth year (from age) and claiming age", () => {
    const base = createProjectionBase({ ...samplePlan, currentAge: 40, benefitClaimingAge: 68 }, ctx());
    const p = base.initialPersons![0];
    expect(p.birthYear).toBe(base.startYear! - 40);
    expect(p.benefitClaimingAge).toBe(68);
  });

  it("stops employment income at the retirement age — working longer ends richer", () => {
    const early = endingNetWorthCents({ ...samplePlan, retirementAge: 55 });
    const late = endingNetWorthCents({ ...samplePlan, retirementAge: 70 });
    expect(late).toBeGreaterThan(early);
  });

  it("pays a government retirement benefit from the claiming age — it appears in the series", () => {
    // The null jurisdiction models no benefit; this one pays a flat amount from age 67.
    const benefitJurisdiction = mockJurisdiction({
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(2_500),
    });
    const series = project(samplePlan, benefitJurisdiction);
    const paysBenefit = series.months.some(
      (m) => (m.flows?.incomeByCategoryCents["governmentRetirementBenefit"] ?? 0) > 0,
    );
    expect(paysBenefit).toBe(true);
    const withBenefit = netWorthAtAge(samplePlan, 80, benefitJurisdiction);
    const noBenefit = netWorthAtAge(samplePlan, 80, nullJurisdiction);
    expect(withBenefit).toBeGreaterThan(noBenefit);
  });
});

describe("createProjectionBase — earned income before current age comes from the job", () => {
  // A job's start age is its `startYear`, not a scalar field.
  const planFromStartAge = (startAge: number): Plan => ({
    ...samplePlan,
    currentAge: 40,
    jobs: [salariedJob(dollarsToCents(8000), { currentAge: 40, startAge })],
  });
  const priorYears = (startAge: number) => {
    const base = createProjectionBase(planFromStartAge(startAge), ctx());
    // Derived from the authoring Persons' jobs exactly as the sim boundary does.
    const prior = compilePersonPriorEarnings(base.initialPersons![0], START_YEAR, samplePlan.inflationPct / 100);
    return Object.keys(prior)
      .map(Number)
      .sort((a, b) => a - b);
  };

  it("seeds prior earnings from the configured job start age, not a fixed 18", () => {
    // currentAge 40, startYear 2026: ages [startAge, 40) map to years
    // [2026 − (40 − startAge) … 2025], one entry per pre-"now" working year.
    const from18 = priorYears(18);
    const from30 = priorYears(30);
    expect(from18).toHaveLength(40 - 18);
    expect(from30).toHaveLength(40 - 30);
    expect(from30[0]).toBeGreaterThan(from18[0]);
    expect(from18.at(-1)).toBe(START_YEAR - 1);
    expect(from30.at(-1)).toBe(START_YEAR - 1);
  });

  it("lowers the priced government benefit when the job started later (fewer covered years)", () => {
    // The US AIME divides a fixed 35-year window, so fewer pre-"now" years leaves more
    // $0 slots and drags the benefit down.
    const priced = mockJurisdiction({
      governmentBenefitBaseMonthlyCents: (claim) => {
        const total = [...claim.record.annualWagesCents.values()].reduce((a, b) => a + b, 0);
        return Math.round(total / 420);
      },
    });
    const early = netWorthAtAge(planFromStartAge(18), 80, priced);
    const late = netWorthAtAge(planFromStartAge(35), 80, priced);
    expect(early).toBeGreaterThan(late);
  });
});

describe("createProjectionBase — retirement decumulation liquidates instead of borrowing", () => {
  it("funds the retiree from investments — the synthetic card never carries a balance", () => {
    // Retirement spending exceeds income; once the liquid buffer is spent the shortfall
    // is met by SELLING assets (re-entering as capitalGains), not by borrowing.
    const series = project({ ...samplePlan, retirementAge: 63 }, mockJurisdiction());
    for (const m of series.months) {
      expect(m.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBe(0);
    }
    // The plan has no other capitalGains source, so any such income means a taxable
    // investment was liquidated.
    const liquidated = series.months.some(
      (m) => (m.flows?.incomeByCategoryCents["capitalGains"] ?? 0) > 0,
    );
    expect(liquidated).toBe(true);
  });
});

describe("createProjectionBase — income reported by source + savings drawdown", () => {
  it("bands working income by its job source, keeping the wages rollup as a convenience view", () => {
    const series = project(samplePlan, mockJurisdiction());
    const working = series.months[12]!.flows!;
    const job = working.incomeSources.find((s) => s.category === "wages");
    expect(job).toBeDefined();
    expect(job!.sourceId.startsWith("job:")).toBe(true);
    expect(working.incomeByCategoryCents["wages"]).toBe(job!.cashInflowCents);
  });

  it("shows a retirement-gap month funded by savings as a drawdown source, not zero income", () => {
    // Retires at 60, no benefit modelled → months 240..323 earn nothing, yet savings pay
    // every bill.
    const series = project(samplePlan, mockJurisdiction());
    const gap = series.months.slice((60 - 40) * 12, (67 - 40) * 12);
    const drawdownMonth = gap.find((m) =>
      (m.flows?.incomeSources ?? []).some((s) => s.category === "savingsDrawdown"),
    );
    expect(drawdownMonth).toBeDefined();
    const drawdown = drawdownMonth!.flows!.incomeSources.find((s) => s.category === "savingsDrawdown")!;
    expect(drawdown.cashInflowCents).toBeGreaterThan(0);
    // Spending an asset, not taxable income — it never enters the rollup.
    expect(drawdownMonth!.flows!.incomeByCategoryCents["savingsDrawdown"]).toBeUndefined();
  });

  it("names a goal-fund decumulation draw by the goal, not an anonymous capitalGains bucket", () => {
    // Once savings are spent, the retained 'Emergency fund' goal is the capital-gains
    // asset the retiree liquidates.
    const series = project(samplePlan, mockJurisdiction());
    const named = series.months.some((m) =>
      (m.flows?.incomeSources ?? []).some((s) => s.label === "Emergency fund"),
    );
    expect(named).toBe(true);
  });
});

describe("createProjectionBase — savings account tax profile is never-sold-consistent", () => {
  it("does NOT give the never-liquidated cash account a capital-gains profile", () => {
    // A capital-gains draw counts toward provisional income and pulls the benefit into
    // tax — wrong for an account only ever spent as cash. Withdrawal is tax-free
    // because its interest is taxed at accrual.
    const savings = createProjectionBase(samplePlan, ctx())
      .initialAccounts!.map((a) => a.sim)
      .find((a) => a.id === "savings")!;
    expect(savings.liquid).toBe(true);
    expect(savings.taxProfile.withdrawalCategory).not.toBe("capitalGains");
    expect(savings.taxProfile.withdrawalCategory).toBe("taxExempt");
    expect(savings.taxProfile.returnKind).toBe("interest");
  });
});

describe("createProjectionBase — a goal declares its account type", () => {
  function goalFund(plan: Plan) {
    return createProjectionBase(plan, ctx())
      .initialAccounts!.map((a) => a.sim)
      .find((a) => a.id === "goal-emergency")!;
  }

  function withEmergencyType(accountType: GoalPlan["accountType"]): Plan {
    return {
      ...samplePlan,
      goals: samplePlan.goals.map((g) => (g.id === "emergency" ? { ...g, accountType } : g)),
    };
  }

  it("derives a cash goal's fund into the cash-interest profile and marks it liquid", () => {
    // An emergency fund exists to be reachable, so its fund stays liquid.
    const fund = goalFund(withEmergencyType("cash"));
    expect(fund.taxProfile).toEqual(CASH_INTEREST_TAX_PROFILE);
    expect(fund.taxProfile.withdrawalCategory).toBe("taxExempt");
    expect(fund.taxProfile.returnKind).toBe("interest");
    expect(fund.liquid).toBe(true);
  });

  it("derives a brokerage goal's fund into the capital-gains profile, liquid", () => {
    // A brokerage is sellable on demand, unlike the age/penalty-locked retirement
    // vehicles.
    const fund = goalFund(withEmergencyType("brokerage"));
    expect(fund.taxProfile).toEqual(CAPITAL_GAINS_TAX_PROFILE);
    expect(fund.liquid).toBe(true);
  });

  it("derives a tax-exempt goal's fund into the tax-exempt profile, illiquid", () => {
    const fund = goalFund(withEmergencyType("taxExempt"));
    expect(fund.taxProfile).toEqual(TAX_EXEMPT_TAX_PROFILE);
    expect(fund.liquid).toBe(false);
  });

  it("derives a pre-tax goal's fund into the pre-tax profile, illiquid", () => {
    const fund = goalFund(withEmergencyType("preTax"));
    expect(fund.taxProfile).toEqual(PRE_TAX_TAX_PROFILE);
    expect(fund.liquid).toBe(false);
  });

  it("defaults an unauthored account type to a liquid capital-gains brokerage", () => {
    const fund = goalFund(samplePlan);
    expect(fund.taxProfile).toEqual(CAPITAL_GAINS_TAX_PROFILE);
    expect(fund.liquid).toBe(true);
  });

  it("does not report a cash goal's drawdown as capital-gains investment income", () => {
    const plan: Plan = {
      ...samplePlan,
      goals: [
        {
          id: "emergency",
          name: "Emergency fund",
          targetCents: dollarsToCents(20000),
          targetDate: 24,
          disposition: "drawDown",
          annualReturnPct: 4,
          accountType: "cash",
        },
      ],
    };
    const series = project(plan, mockJurisdiction());
    const anyCapitalGainsFromGoal = series.months.some((m) =>
      (m.flows?.incomeSources ?? []).some(
        (s) => s.label === "Emergency fund" && s.category === "capitalGains",
      ),
    );
    expect(anyCapitalGainsFromGoal).toBe(false);
    // Not vacuous: it IS drawn down, tax-free, under the goal's name.
    const drawnByName = series.months.some((m) =>
      (m.flows?.incomeSources ?? []).some(
        (s) => s.label === "Emergency fund" && s.category === "taxExempt",
      ),
    );
    expect(drawnByName).toBe(true);
  });
});

describe("createProjectionBase — horizon spans to life expectancy", () => {
  it("projects from now to life expectancy, not a fixed 30 years", () => {
    const horizon = (currentAge: number, lifeExpectancy: number) =>
      project({ ...samplePlan, currentAge, lifeExpectancy }).months.length;
    // months are [0 … (life − now)*12), one processed month each → length (life − now)*12.
    expect(horizon(35, 90)).toBe((90 - 35) * 12);
    expect(horizon(25, 95)).toBe((95 - 25) * 12);
    expect(horizon(35, 95)).toBeGreaterThan(horizon(35, 65));
  });
});

describe("createProjectionBase — health as its own additive, growing expense", () => {
  const saver: Plan = {
    ...samplePlan,
    jobs: [salariedJob(dollarsToCents(6_000))],
    budgetLines: [spendLine(dollarsToCents(3_000))],
    goals: [],
  };

  it("spends the health line: adding health lowers ending net worth", () => {
    const withoutHealth = endingNetWorthCents({ ...saver, healthMonthlyCents: 0 });
    const withHealth = endingNetWorthCents({ ...saver, healthMonthlyCents: dollarsToCents(500) });
    expect(withHealth).toBeLessThan(withoutHealth);
  });

  it("grows the health line at its own rate: a higher rate spends more over the horizon", () => {
    const base = { ...saver, healthMonthlyCents: dollarsToCents(500) };
    const flat = endingNetWorthCents({ ...base, healthInflationPct: 0 });
    const rising = endingNetWorthCents({ ...base, healthInflationPct: 8 });
    expect(rising).toBeLessThan(flat);
  });

  it("steps health down at the jurisdiction's public-coverage age when enrolling", () => {
    // A near-coverage saver puts the step (65) inside the horizon with income running
    // through it (retirementAge past life expectancy), so the difference is not masked by
    // the synthetic-card insolvency floor.
    const nearCoverage: Plan = {
      ...samplePlan,
      currentAge: 55,
      retirementAge: 90,
      lifeExpectancy: 90,
      jobs: [salariedJob(dollarsToCents(6_000), { currentAge: 55 })],
      budgetLines: [spendLine(dollarsToCents(3_000))],
      healthMonthlyCents: dollarsToCents(1_000),
      postCoverageHealthMonthlyCents: dollarsToCents(400),
      healthInflationPct: 5,
      goals: [],
    };
    const covered = mockJurisdiction({ publicHealthCoverageAge: 65 });
    const enrolled = endingNetWorthCents({ ...nearCoverage, enrollsInPublicHealthCoverage: true }, covered);
    const selfFunded = endingNetWorthCents({ ...nearCoverage, enrollsInPublicHealthCoverage: false }, covered);
    expect(enrolled).toBeGreaterThan(selfFunded);
  });

  it("does not step when the jurisdiction has no public-coverage age, even if enrolling", () => {
    // publicHealthCoverageAge is the only source of the step: with none, an enrolling
    // plan collapses to one segment, identical to not enrolling.
    const nearCoverage: Plan = {
      ...samplePlan,
      currentAge: 55,
      retirementAge: 90,
      lifeExpectancy: 90,
      jobs: [salariedJob(dollarsToCents(6_000), { currentAge: 55 })],
      healthMonthlyCents: dollarsToCents(1_000),
      postCoverageHealthMonthlyCents: dollarsToCents(400),
      goals: [],
    };
    const noCoverage = mockJurisdiction(); // no publicHealthCoverageAge
    const enrolled = endingNetWorthCents({ ...nearCoverage, enrollsInPublicHealthCoverage: true }, noCoverage);
    const selfFunded = endingNetWorthCents({ ...nearCoverage, enrollsInPublicHealthCoverage: false }, noCoverage);
    expect(enrolled).toBe(selfFunded);
  });
});

describe("createProjectionBase — surplus-cash destination lever", () => {
  it("defaults an unset lever to idle (surplus stays in the liquid cash account)", () => {
    expect(createProjectionBase(samplePlan, ctx()).surplusDestination).toEqual({
      kind: "idle",
    });
  });

  it("maps surplusCashTo:'savings' to idle", () => {
    const base = createProjectionBase({ ...samplePlan, surplusCashTo: "savings" }, ctx());
    expect(base.surplusDestination).toEqual({ kind: "idle" });
  });

  it("maps surplusCashTo:'brokerage' to a sweep into the brokerage account", () => {
    const base = createProjectionBase({ ...samplePlan, surplusCashTo: "brokerage" }, ctx());
    expect(base.surplusDestination).toEqual({ kind: "swept", accountId: "brokerage" });
  });

  it("sweeping surplus to the higher-returning brokerage grows net worth faster than idling in cash", () => {
    // samplePlan earns 6% in the brokerage vs 5% in cash, so surplus compounding there
    // ends richer than idling.
    const idle = endingNetWorthCents({ ...samplePlan, surplusCashTo: "savings" });
    const swept = endingNetWorthCents({ ...samplePlan, surplusCashTo: "brokerage" });
    expect(swept).toBeGreaterThan(idle);
  });
});

describe("planAccountDescriptors — presentation metadata that agrees with buildPlanAccounts", () => {
  it("matches buildPlanAccounts on id, label, and order (the shared source of truth)", () => {
    const plan: Plan = { ...samplePlan };
    const descriptors = planAccountDescriptors(plan);
    const accounts = buildPlanAccounts(plan).map((a) => a.sim);
    expect(descriptors.map((d) => d.id)).toEqual(accounts.map((a) => a.id));
    for (const d of descriptors) {
      expect(d.label).toBe(accounts.find((a) => a.id === d.id)?.label);
    }
  });

  it("names the standing accounts and one goal fund per goal, by the goal's name", () => {
    const plan: Plan = { ...samplePlan };
    const descriptors = planAccountDescriptors(plan);
    const standing = descriptors.filter((d) => d.kind !== "goal");
    expect(standing.map((d) => d.kind)).toEqual(["cash", "retirement", "brokerage"]);
    for (const goal of plan.goals) {
      const band = descriptors.find((d) => d.id === goalFundAccountId(goal));
      expect(band).toEqual({ id: goalFundAccountId(goal), label: goal.name, kind: "goal" });
    }
  });
});
