/**
 * The `Projection` root's read surface: reads over authored state, per-line monthly resolution in
 * the result, and `ProjectionResult` reads over one run.
 */
import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { samplePlan, salariedJob, spendLine, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { goalFundAccountId } from "../compile/projectionBase";
import { obligationBudgetLineId } from "../projection/financialObligation";
import { type BudgetLine } from "../budget/budgetLine";
import { RETIREMENT_ID } from "../plan/ids";
import { P1, freshProjection, plainJob, partnerEvent } from "../testing/projectionFacadeFixtures";

describe("Projection root — per-line monthly resolution in the result", () => {
  /**
   * `obligationBudgetLineId` keys each line `line:<id>`, and the engine mints that id — so a test
   * adds the line, keeps what `addBudgetLine` returned, and builds the key through the same helper.
   */
  const keyOf = (id: string) => obligationBudgetLineId(id);

  it("funds every budget line to its intent in a solvent month, keyed by its obligation id", () => {
    // 8k/mo take-home (nullJurisdiction = no tax) easily covers a $2,500 budget.
    const p = Projection.fromState(stateOf({ ...samplePlan, goals: [] }), nullJurisdiction);
    const rent = p.addBudgetLine({
      label: "Rent",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2_000) },
      category: "needs",
    });
    const fun = p.addBudgetLine({
      label: "Fun",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) },
      category: "wants",
    });

    const flows = p.run(nullJurisdiction).series.months[1]?.flows;
    // Keyed by the obligation id (`line:<id>`).
    expect(flows?.lineMonthlyCents[keyOf(rent)]).toBe(dollarsToCents(2_000));
    expect(flows?.lineMonthlyCents[keyOf(fun)]).toBe(dollarsToCents(500));
  });

  it("reports every line at its full amount even once the plan is insolvent", () => {
    // $3k/mo income against a $6k/mo budget, no assets to liquidate → a genuine
    // shortfall. Priority funds rent (a need) before fun (a want).
    const p = Projection.fromState(stateOf({
          ...samplePlan,
          jobs: [salariedJob(dollarsToCents(3_000))],
          openingBalanceCents: 0,
          goals: [],
        }), nullJurisdiction);
    const rent = p.addBudgetLine({
      label: "Rent",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(4_000) },
      category: "needs",
    });
    const fun = p.addBudgetLine({
      label: "Fun",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2_000) },
      category: "wants",
    });

    const months = p.run(nullJurisdiction).series.months;

    // A squeezed month is absorbed by savings, then credit — the household really did pay
    // for all of it.
    expect(months[1]?.flows?.lineMonthlyCents[keyOf(fun)]).toBe(dollarsToCents(2_000));
    expect(months[1]?.flows?.lineMonthlyCents[keyOf(rent)]).toBe(dollarsToCents(4_000));

    // Once even credit is exhausted the budget is still reported as authored: the engine
    // surfaces that the plan broke (`isInsolvent`), it does not decide which spending the
    // user would have given up.
    const broke = months.findIndex((m) => m.isInsolvent);
    expect(broke).toBeGreaterThan(1);
    const flows = months[broke]?.flows;
    expect(flows?.lineMonthlyCents[keyOf(fun)]).toBeGreaterThan(0);
    expect(flows?.lineMonthlyCents[keyOf(rent)]).toBeGreaterThan(0);
    // The per-line map and the coarse rollup agree: nothing was rationed away.
    const lineTotal = Object.values(flows?.lineMonthlyCents ?? {}).reduce((a, b) => a + b, 0);
    expect(lineTotal).toBe(flows?.expensesCents);
  });

  it("keeps every line funded from savings between retirement and the first benefit", () => {
    // samplePlan retires at 60 and claims its benefit at 67, so ages 60–67 have no income
    // at all. Funding the budget by drawing savings down is the plan working, not a starved
    // budget.
    const p = Projection.fromState(stateOf({
          ...samplePlan,
          openingBalanceCents: dollarsToCents(2_000_000),
          goals: [],
        }), nullJurisdiction);
    p.addBudgetLine({
      label: "Rent",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2_000) },
      category: "needs",
    });
    const fun = p.addBudgetLine({
      label: "Fun",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) },
      category: "wants",
    });

    const months = p.run(nullJurisdiction).series.months;
    // Age 63 — three years past retirement, four years before the benefit starts.
    const gapMonth = (63 - samplePlan.currentAge) * 12;
    const flows = months[gapMonth]?.flows;
    expect(flows?.totalIncomeCents).toBe(0);

    // Fully funded = funded lines add up to the month's whole intent. Asserted against the
    // rollup rather than a literal, since a budget rises with prices.
    const fundedTotal = (m: number): number =>
      Object.values(months[m]?.flows?.lineMonthlyCents ?? {}).reduce((a, b) => a + b, 0);
    expect(fundedTotal(gapMonth)).toBe(flows?.expensesCents);
    expect(flows?.lineMonthlyCents[keyOf(fun)]).toBeGreaterThan(0); // the first line to starve

    // Nothing starves anywhere across the whole gap.
    for (let m = (60 - samplePlan.currentAge) * 12; m <= (67 - samplePlan.currentAge) * 12; m++) {
      expect(fundedTotal(m)).toBe(months[m]?.flows?.expensesCents);
    }
  });
});

describe("Projection reads — over authored state", () => {
  it("names an account per goal beside the standing three, as goals are added", () => {
    const p = freshProjection();
    const before = p.accountDescriptors();
    const goalId = p.addGoal({
      name: "Car",
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
      annualReturnPct: 3,
    });
    const added = p
      .accountDescriptors()
      .filter((d) => !before.some((b) => b.id === d.id));
    const goal = p.plan.goals.find((g) => g.id === goalId)!;
    expect(added).toEqual([{ id: goalFundAccountId(goal), label: "Car", kind: "goal" }]);
  });

  it("names the events a goal's fund account pays for, and nothing else", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    // The down payment must fit the emergency fund AS THE DRAW SEES IT. The fund builds toward
    // $20k by month 24, but a money-out draw resolves before that month's contribution and
    // interest post, so at month 12 only 11 months' worth (~$9.8k) is on hand — $9k clears it
    // with room. (A $10k down payment used to pass on the fund's end-of-month balance, which the
    // draw never reaches; the gate now prices it against the pre-draw balance, matching the sim.)
    const homeId = p.buyHome({
      month: 12,
      ownerId: P1,
      purchasePriceCents: dollarsToCents(100000),
      downPaymentCents: dollarsToCents(9000),
      downPaymentSourceIds: [goalFundAccountId(samplePlan.goals[0])],
      mortgageApr: 0.05,
      mortgageTermMonths: 360,
    });
    expect(p.eventsFundedByGoal("emergency").map((e) => e.id)).toEqual([homeId]);
    expect(p.eventsFundedByGoal("no-such-goal")).toEqual([]);
  });

  it("resolves a spend line to its base amount, its overrides, and the growth to that month", () => {
    const line = (id: string, monthlyCents: number, overrides?: BudgetLine["overrides"]) => ({
      id,
      label: id,
      target: { kind: "expense" } as const,
      amountSource: { kind: "literal" as const, monthlyCents },
      category: "needs" as const,
      ...(overrides ? { overrides } : {}),
    });
    const p = Projection.fromState(stateOf({
          ...samplePlan,
          inflationPct: 0,
          budgetLines: [
            line("housing", dollarsToCents(1600), [
              { month: 24, monthlyCents: dollarsToCents(2000), scope: "fromHereForward" },
              { month: 6, monthlyCents: dollarsToCents(900), scope: "thisMonthOnly" },
            ]),
            {
              id: "brokerage-contrib",
              label: "Investing",
              target: { kind: "account", accountId: "brokerage", taxTreatment: "postTax" },
              amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) },
              category: "savings",
            },
          ],
        }), nullJurisdiction);

    const at = (month: number) => p.expenseRowsAt(month)[0];
    expect(at(0)).toMatchObject({ monthlyCents: dollarsToCents(1600), overridden: false });
    // A one-month override shows at its own month and nowhere else.
    expect(at(6)).toMatchObject({ monthlyCents: dollarsToCents(900), overridden: true });
    expect(at(7)?.monthlyCents).toBe(dollarsToCents(1600));
    // A from-here-forward one carries to every later month.
    expect(at(24)?.monthlyCents).toBe(dollarsToCents(2000));
    expect(at(400)?.monthlyCents).toBe(dollarsToCents(2000));
    // Contribution lines have no month-resolved amount, so they are absent entirely.
    expect(p.expenseRowsAt(0).map((r) => r.lineId)).toEqual(["housing"]);
  });

  it("grows a row into the selected month's dollars, so editor and graph agree", () => {
    const p = Projection.fromState(stateOf({
          ...samplePlan,
          inflationPct: 3,
          budgetLines: [spendLine(dollarsToCents(600))],
        }), nullJurisdiction);
    expect(p.expenseRowsAt(0)[0]?.monthlyCents).toBe(dollarsToCents(600));
    const tenYearsOn = p.expenseRowsAt(120)[0]?.monthlyCents ?? 0;
    expect(Math.abs(tenYearsOn - dollarsToCents(600) * Math.pow(1.03, 10))).toBeLessThanOrEqual(2);
  });

  it("reads standing pay per job, per person and across the household — both planes", () => {
    const p = freshProjection();
    const mine = p.addJob(P1, {
      ...plainJob,
      salary: { startingSalaryCents: dollarsToCents(120000), currentSalaryCents: dollarsToCents(120000), realGrowthPct: 0 },
    });
    const partnerId = p.marry({
      month: 0,
      name: "Sam",
      birthYear: SAMPLE_START_YEAR - 38,
      jobs: [
        { ...plainJob, salary: { startingSalaryCents: dollarsToCents(60000), currentSalaryCents: dollarsToCents(60000), realGrowthPct: 0 } },
      ],
    });
    const theirs = partnerEvent(p).person.jobs[0].id;

    expect(p.jobMonthlyIncomeCents(mine)).toBe(dollarsToCents(10000));
    // Found on the ledger plane by id alone — the caller never says which.
    expect(p.jobMonthlyIncomeCents(theirs)).toBe(dollarsToCents(5000));
    expect(p.personMonthlyIncomeCents(P1)).toBe(dollarsToCents(10000));
    expect(p.personMonthlyIncomeCents(partnerId)).toBe(dollarsToCents(5000));
    // Sizing a household budget off one earner is the mistake this exists to prevent.
    expect(p.householdMonthlyIncomeCents()).toBe(dollarsToCents(15000));
  });

  it("refuses a job id no one in the household holds, rather than reading 0", () => {
    expect(() => freshProjection().jobMonthlyIncomeCents("job-9")).toThrow(/no job "job-9"/);
  });

  it("blends a person's deferral across their jobs, weighted by gross", () => {
    const p = freshProjection();
    // $120k at 10% and $40k at 0% → 7.5% of the $160k gross, not the 5% a flat mean gives.
    p.addJob(P1, {
      ...plainJob,
      salary: { startingSalaryCents: dollarsToCents(120000), currentSalaryCents: dollarsToCents(120000), realGrowthPct: 0 },
      deferral: { deferralFraction: 0.1, fundAccountId: RETIREMENT_ID },
    });
    const plain = p.addJob(P1, {
      ...plainJob,
      salary: { startingSalaryCents: dollarsToCents(40000), currentSalaryCents: dollarsToCents(40000), realGrowthPct: 0 },
    });
    expect(p.personDeferralFraction(P1)).toBeCloseTo(0.075, 6);
    // A job electing nothing reads as 0, never as "absent".
    expect(p.jobDeferralFraction(plain)).toBe(0);
  });

  it("reads a person who earns nothing as 0, not NaN", () => {
    expect(freshProjection().personDeferralFraction(P1)).toBe(0);
    expect(freshProjection().personMonthlyIncomeCents(P1)).toBe(0);
  });
});

describe("ProjectionResult reads — over one run", () => {
  const RUN_JURISDICTION = nullJurisdiction;

  function ranPlan(plan: typeof samplePlan) {
    return Projection.fromState(stateOf(plan), nullJurisdiction).run(RUN_JURISDICTION);
  }

  it("reports who is in the household at a month, and only from the month they joined", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    p.marry({ month: 24, name: "Sam", birthYear: SAMPLE_START_YEAR - 38 });
    const result = p.run(RUN_JURISDICTION);
    expect(result.membersAt(0).map((m) => m.id)).toEqual(["p1"]);
    expect(result.membersAt(24).map((m) => m.name)).toContain("Sam");
    // The snapshot roster reads the same membership, so the two cannot disagree.
    expect(result.snapshot(24).persons.map((m) => m.id)).toEqual(
      result.membersAt(24).map((m) => m.id),
    );
  });

  it("scores every plan goal against the run, in funding order", () => {
    const result = ranPlan(samplePlan);
    const scored = result.goalProgress();
    expect(scored.map((s) => s.goal.id)).toEqual(["emergency"]);
    expect(scored[0].goal.priority).toBe(0);
    expect(scored[0].progress.onTrackFraction).toBeGreaterThan(0);
  });

});

/**
 * The soft debt-to-income read on a purchase nobody has authored yet. The threshold
 * arithmetic is `affordability`'s; these pin the DERIVATION — that the household's real gross
 * income and its already-serviced debt are what the guidelines are measured against.
 */

/**
 * `plannedWorkStopAge` on its own — the same figure `retirement()` reports, reachable without
 * the search. It exists as a separate door because a caller bounding a savings line at the last
 * paid month should not have to run (or hold onto) a solve to get it: the app's retirement solve
 * is deferred, so the copy carried on an outlook can be a plan behind, while an authoring
 * surface needs the age of the plan in front of the user.
 */
describe("Projection root — the authored work-stop age, without the solve", () => {
  it("answers the same age the retirement outlook reports", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    // Not a search: one resolution of the authored jobs. Agreeing with the outlook is the
    // point — two ways to read one fact must not be two facts.
    expect(p.plannedWorkStopAge(nullJurisdiction)).toBe(60);
    expect(p.plannedWorkStopAge(nullJurisdiction)).toBe(
      p.retirement(nullJurisdiction).solution.plannedWorkStopAge,
    );
  });

  it("moves the moment a job's end moves, with no run in between", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const before = p.plannedWorkStopAge(nullJurisdiction)!;
    const later = salariedJob(dollarsToCents(4_000), { endAge: before + 5 });
    p.replaceJob(p.plan.jobs[0].id, later);
    // Read off the jobs, so an edit is reflected immediately — which is what makes it safe for
    // the authoring surfaces the deferred solve is not.
    expect(p.plannedWorkStopAge(nullJurisdiction)).toBe(before + 5);
  });

  it("is null for a household holding no jobs — no work to stop", () => {
    const p = Projection.fromState(stateOf({ ...samplePlan, jobs: [] }), nullJurisdiction);
    expect(p.plannedWorkStopAge(nullJurisdiction)).toBeNull();
  });
});
