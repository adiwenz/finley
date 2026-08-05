/**
 * Engine-native wiring tests for the plan→projection mapping. {@link samplePlan} and
 * {@link mockJurisdiction} keep them standalone — no rules package, each test enabling
 * exactly the seam it exercises. The app keeps the real-jurisdiction acceptance tests
 * under `usJurisdiction`.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger } from "../ledger/ledger";
import { replayLedger } from "../projection/buildHouseholdInput";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { SYNTHETIC_CARD_ID } from "../liability/liability";
import {
  CASH_INTEREST_TAX_PROFILE,
  CAPITAL_GAINS_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
} from "../plan/simAccount";
import {
  createProjectionBase,
  buildPlanAccounts,
  planAccountDescriptors,
  goalFundAccountId,
  type ProjectionContext,
} from "./projectionBase";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { samplePlan, salariedJob, spendLine, healthLine } from "../testing/samplePlan";
import { compilePersonPriorEarnings } from "./compilePerson";
import { planHorizonMonths, type Plan, type GoalPlan } from "../plan/plan";

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

describe("createProjectionBase — expenses come only from budget lines", () => {
  const kinds = (plan: Plan) =>
    createProjectionBase(plan, ctx()).initialExpenseSeries!.map((s) => s.obligationSource?.kind);

  it("tags every expense series as a budget line, health included", () => {
    // The line-item budget is the sole expense authoring surface. `samplePlan` authors a spend
    // line and a health line; both arrive as budget lines, with no separate plan-level series
    // riding alongside them.
    expect(kinds(samplePlan)).toEqual(["budgetLine", "budgetLine"]);
  });

  it("emits no expense series at all when a plan authors no budget lines", () => {
    // Health used to survive an empty budget as a plan field. Nothing does now: an empty
    // budget is a plan that spends nothing.
    const base = createProjectionBase({ ...samplePlan, budgetLines: [] }, ctx());
    expect(base.initialExpenseSeries).toEqual([]);
  });
});

describe("createProjectionBase — retirement + government benefit wired into the graph", () => {
  it("gives the projection person a benefit basis: birth year (from age) and claiming age", () => {
    const base = createProjectionBase({ ...samplePlan, currentAge: 40, benefitClaimingAge: 68 }, ctx());
    const p = base.initialPersons![0];
    expect(p.birthYear).toBe(base.startYear! - 40);
    expect(p.benefitClaimingAge).toBe(68);
  });

  it("stops employment income where the JOB ends — working longer ends richer", () => {
    // Authored ends, not the plan's retirement age: that age is a target the household aims at
    // and no longer truncates anybody's employment. Working longer is a longer JOB.
    const retiringAt = (endAge: number) =>
      endingNetWorthCents({ ...samplePlan, jobs: [salariedJob(dollarsToCents(8000), { endAge })] });
    expect(retiringAt(70)).toBeGreaterThan(retiringAt(55));
  });

  it("pays a job to its own authored end, and nothing else has a say", () => {
    // The regression this guards: a plan-level retirement age of 55 used to delete every wage
    // after 55, so an income chart contradicted the job the user had just authored. That field
    // is gone rather than merely ignored — the job's own end is the only end there is — so this
    // now asserts the positive: a job authored to 82 pays to 82.
    const series = project(retiringAt(82));
    const wagesAt = (age: number) =>
      series.months[(age - samplePlan.currentAge) * 12]?.flows?.incomeByCategoryCents.wages ?? 0;
    expect(wagesAt(50)).toBeGreaterThan(0);
    expect(wagesAt(60)).toBeGreaterThan(0);
    expect(wagesAt(80)).toBeGreaterThan(0);
  });

  it("charts a job that only STARTS after the retirement age — the reported bug", () => {
    // Stop-working age 65, a job picked up at 70. It used to be compiled away the instant it
    // was saved; it now pays from 70 exactly as authored.
    const birthYear = START_YEAR - samplePlan.currentAge;
    const series = project({
      ...samplePlan,
      jobs: [{ ...salariedJob(dollarsToCents(3000)), startYear: birthYear + 70, endYear: birthYear + 80 }],
    });
    const wagesAt = (age: number) =>
      series.months[(age - samplePlan.currentAge) * 12]?.flows?.incomeByCategoryCents.wages ?? 0;
    expect(wagesAt(68)).toBe(0);
    expect(wagesAt(70)).toBeGreaterThan(0);
    expect(wagesAt(79)).toBeGreaterThan(0);
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
    const prior = compilePersonPriorEarnings(base.initialPersons![0], START_YEAR);
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

describe("createProjectionBase — the covered-earnings record the benefit seam prices comes from the jobs", () => {
  // Inflation 0 so a real-flat salary is nominally flat: each pre-"now" year reads the exact
  // authored pay, and a raise or bonus is a clean whole-dollar shift the AIME seam can be
  // pinned against.
  const zeroInflation = (jobs: Plan["jobs"]): Plan => ({
    ...samplePlan,
    inflationPct: 0,
    currentAge: 40,
    benefitClaimingAge: 67,
    jobs,
  });

  /** The covered-earnings record as the benefit seam first sees it (at the claiming month). */
  function recordAtClaim(plan: Plan): Map<number, number> {
    let captured: Map<number, number> | undefined;
    const seam = mockJurisdiction({
      governmentBenefitBaseMonthlyCents: (claim) => {
        captured ??= new Map(claim.record.annualWagesCents);
        return 0; // pricing is captured, not paid — this test asserts the record, not the benefit
      },
    });
    project(plan, seam);
    if (captured === undefined) throw new Error("benefit seam was never priced");
    return captured;
  }

  it("prices a record built from actual job compensation — pre-'now' raises and bonuses included", () => {
    // Main job $6,000/mo from 2004, raised to $10,000/mo from 2024 (month −24) with a $5,000
    // bonus in 2025 (month −6); a second concurrent $2,000/mo job runs alongside.
    const main = {
      ...salariedJob(dollarsToCents(6000)),
      payChanges: [{ id: "adjustment-116", month: -24, kind: "setTo" as const, cents: dollarsToCents(10_000) }],
      incomeOverrides: [{ id: "adjustment-117", month: -6, kind: "addBonus" as const, cents: dollarsToCents(5000) }],
    };
    const side = { ...salariedJob(dollarsToCents(2000)), id: "job-side" };
    const record = recordAtClaim(zeroInflation([main, side]));
    expect(record.get(2023)).toBe(dollarsToCents(72_000 + 24_000)); // both jobs, pre-raise
    expect(record.get(2024)).toBe(dollarsToCents(120_000 + 24_000)); // raise in force
    expect(record.get(2025)).toBe(dollarsToCents(125_000 + 24_000)); // raise + one-off bonus
  });

  it("combines all employers into one per-year figure before any wage-base cap applies", () => {
    // Two employers each under the SSA cap ($184,500) but together over it: the record carries
    // the COMBINED, uncapped total, leaving the cap as a single downstream per-person-per-year
    // step (in the rules AIME) rather than one applied per employer.
    const a = { ...salariedJob(dollarsToCents(9000)), id: "job-a" }; // $108k/yr
    const b = { ...salariedJob(dollarsToCents(9000)), id: "job-b" }; // $108k/yr
    const record = recordAtClaim(zeroInflation([a, b]));
    expect(record.get(2025)).toBe(dollarsToCents(216_000)); // 108k + 108k, uncapped in the record
  });

  it("prices history off the reconstruction while the projection pays the current salary", () => {
    // The two halves are authored to DISAGREE: pay started at $72,000/yr and was raised to
    // $75,000/yr before "now", while current pay is authored at $96,000/yr. End to end, each
    // half must read its own anchor — history the reconstruction, the projection the anchor.
    const job = {
      ...salariedJob(dollarsToCents(6000)),
      salary: {
        startingSalaryCents: dollarsToCents(72_000),
        currentSalaryCents: dollarsToCents(96_000),
        realGrowthPct: 0,
      },
      payChanges: [{ id: "adjustment-118", month: -24, kind: "setTo" as const, cents: dollarsToCents(6_250) }],
    };
    const plan = zeroInflation([job]);

    const record = recordAtClaim(plan);
    expect(record.get(2023)).toBe(dollarsToCents(72_000)); // starting pay
    expect(record.get(2024)).toBe(dollarsToCents(75_000)); // historical raise
    expect(record.get(2025)).toBe(dollarsToCents(75_000)); // still in force at month −1

    // Month 0 pays the authored current salary — neither the $72,000 it started on nor the
    // $75,000 the history ended on.
    const monthZeroWages = project(plan).months[0].flows!.incomeByCategoryCents.wages;
    expect(monthZeroWages).toBe(dollarsToCents(96_000) / 12); // $8,000/mo
  });
});

/**
 * `samplePlan` with its job authored to END at the plan's retirement age — the plan that used to
 * be implied by that age alone. An open-ended job now runs to the horizon, so a test about what
 * happens AFTER work has to say when work stops.
 */
const retiringAt = (endAge: number): Plan => ({
  ...samplePlan,
  jobs: [salariedJob(dollarsToCents(8000), { deferralFraction: 0.1, endAge })],
});

describe("createProjectionBase — retirement decumulation liquidates instead of borrowing", () => {
  it("funds the retiree from investments — the synthetic card never carries a balance", () => {
    // Retirement spending exceeds income; once the liquid buffer is spent the shortfall
    // is met by SELLING assets (re-entering as capitalGains), not by borrowing.
    const series = project(retiringAt(63), mockJurisdiction());
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
    // The job ends at 60 and no benefit is modelled → months 240..323 earn nothing, yet
    // savings pay every bill.
    const series = project(retiringAt(60), mockJurisdiction());
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
    // asset the retiree liquidates — after the job they authored an end for.
    const series = project(retiringAt(60), mockJurisdiction());
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
      .find((a) => a.id === "fund-emergency")!;
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
      ...retiringAt(60),
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

  it("publishes that span as `planHorizonMonths`, so no caller re-derives it", () => {
    // The reason it is published: a surface drawing the plan (a chart axis, the timeline, the
    // event year picker) needs the same span the simulator ran, and a second derivation of it can
    // disagree with the months it is handed — most invisibly when the series is TRUNCATED at a
    // block and the only remaining statement of the full span is this one.
    const plan = { ...samplePlan, currentAge: 35, lifeExpectancy: 90 };
    expect(project(plan).months.length).toBe(planHorizonMonths(plan));
    // Clamped rather than negative: a life expectancy at or below today's age has no months to
    // simulate, and no caller should have to guard a negative span.
    expect(planHorizonMonths({ currentAge: 90, lifeExpectancy: 90 })).toBe(0);
    expect(planHorizonMonths({ currentAge: 95, lifeExpectancy: 90 })).toBe(0);
  });
});

describe("createProjectionBase — health is an ordinary budget line", () => {
  const saver: Plan = {
    ...samplePlan,
    jobs: [salariedJob(dollarsToCents(6_000))],
    budgetLines: [spendLine(dollarsToCents(3_000))],
    goals: [],
  };

  it("spends the health line: adding one lowers ending net worth", () => {
    const withHealth = endingNetWorthCents({
      ...saver,
      budgetLines: [...saver.budgetLines, healthLine(dollarsToCents(500))],
    });
    expect(withHealth).toBeLessThan(endingNetWorthCents(saver));
  });

  it("grows health at CPI, exactly as it grows every other expense line", () => {
    // Health carried its own `healthInflationPct` when it was a plan field. It has no rate of
    // its own now: two lines of equal amount stay equal for the whole horizon, which they
    // could not if health were still compiled on a separate escalation.
    const plan: Plan = {
      ...saver,
      budgetLines: [spendLine(dollarsToCents(1_000)), healthLine(dollarsToCents(1_000))],
    };
    const [spend, health] = createProjectionBase(plan, ctx()).initialExpenseSeries!;
    expect(health!.series.getMonthlyCents(0)).toBe(spend!.series.getMonthlyCents(0));
    expect(health!.series.getMonthlyCents(240)).toBe(spend!.series.getMonthlyCents(240));
  });

  it("never steps health at a coverage age, whatever the jurisdiction says", () => {
    // The 65 step-down is gone with the plan fields that drove it: `publicHealthCoverageAge`
    // no longer reaches the compiled series at all, so a jurisdiction naming one and a
    // jurisdiction naming none project identically.
    const plan: Plan = {
      ...saver,
      currentAge: 55,
      lifeExpectancy: 90,
      jobs: [salariedJob(dollarsToCents(6_000), { currentAge: 55 })],
      budgetLines: [spendLine(dollarsToCents(3_000)), healthLine(dollarsToCents(1_000))],
    };
    expect(endingNetWorthCents(plan, mockJurisdiction({ publicHealthCoverageAge: 65 }))).toBe(
      endingNetWorthCents(plan, mockJurisdiction()),
    );
  });

  it("edits health through the same override path as any other line", () => {
    // The user-facing point of the refactor: a health line takes a dated override, so
    // "from this month forward" spends less from that month on.
    const base: Plan = {
      ...saver,
      budgetLines: [spendLine(dollarsToCents(3_000)), healthLine(dollarsToCents(1_000))],
    };
    const cut: Plan = {
      ...base,
      budgetLines: [
        spendLine(dollarsToCents(3_000)),
        {
          ...healthLine(dollarsToCents(1_000)),
          overrides: [{ month: 60, monthlyCents: dollarsToCents(200), scope: "fromHereForward" }],
        },
      ],
    };
    expect(endingNetWorthCents(cut)).toBeGreaterThan(endingNetWorthCents(base));
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
