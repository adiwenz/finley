/**
 * The `Projection` root — the npm API surface: standing edits and ledger transactions on one
 * object, deterministic minted ids, immutable state swaps with no undo stack, and
 * `run(jurisdiction)` leaving the plan untouched. Barrel/purity is covered elsewhere.
 */
import { describe, it, expect } from "vitest";
import { Projection } from "./projectionRoot";
import { samplePlan, salariedJob, SAMPLE_START_YEAR } from "./testing/samplePlan";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { nullJurisdiction } from "./jurisdiction";
import { dollarsToCents } from "./cashFlowSeries";
import { goalFundAccountId } from "./projectionBase";
import { withLedger } from "./scenario";
import { emptyLedger } from "./ledger/ledger";
import type { LifeEvent } from "./ledger/eventTypes";
import type { PersonId } from "./job";

const P1 = "p1" as PersonId;

function freshProjection(): Projection {
  // Empty job and budget-line lists so minted ids and roster lengths reflect only what each
  // test adds — the sample plan seeds a spend line that would otherwise skew the counts.
  return Projection.create({
    plan: { ...samplePlan, jobs: [], budgetLines: [] },
    startYear: SAMPLE_START_YEAR,
  });
}

const openEndedJob = {
  startYear: SAMPLE_START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
} as const;

const expenseLine = {
  label: "Rent",
  target: { kind: "expense" } as const,
  amountSource: { kind: "literal" as const, monthlyCents: dollarsToCents(2000) },
  category: "needs" as const,
};

describe("Projection root — creating writes mint deterministic ids", () => {
  it("mints a monotonic sequence id and returns it", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    expect(jobId).toBe("job-1");
  });

  it("shares ONE counter across kinds, so ids never collide", () => {
    const p = freshProjection();
    expect(p.addJob(P1, openEndedJob)).toBe("job-1");
    expect(p.addBudgetLine(expenseLine)).toBe("line-2");
    expect(p.addGoal({
      name: "Car",
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
      annualReturnPct: 3,
    })).toBe("goal-3");
    expect(p.takeLoan({ month: 6, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(20000), apr: 5, termMonths: 60 })).toBe("loan-4");
  });

  it("honours a caller `{ id }` override without consuming the counter", () => {
    const p = freshProjection();
    expect(p.addJob(P1, { ...openEndedJob, id: "day-job" })).toBe("day-job");
    // The counter did not advance, so the next mint is still "-1".
    expect(p.addBudgetLine(expenseLine)).toBe("line-1");
  });

  it("routes the added job onto the standing plan, owned by the person", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    const jobs = p.state.scenario.plan.jobs ?? [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: jobId, ownerId: P1, endYear: null });
  });
});

describe("Projection root — one root for standing + ledger writes", () => {
  it("exposes both standing edits and ledger transactions on the same object", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    const loanId = p.takeLoan({
      month: 12,
      ownerId: P1,
      kind: "auto",
      openingBalanceCents: dollarsToCents(25000),
      apr: 6,
      termMonths: 60,
    });
    expect(jobId).toBe("job-1");
    expect(loanId).toBe("loan-2");
    expect(p.state.scenario.plan.jobs).toHaveLength(1);
    expect(p.state.scenario.ledger.events).toHaveLength(1);
  });

  it("swaps in a new state rather than mutating the one already read out", () => {
    // A caller holding a pre-write state — a React render closure, a serialized snapshot —
    // must never see it change underfoot.
    const p = freshProjection();
    const before = p.state;
    const baseRetirement = before.scenario.plan.retirementAge;

    p.setRetirementTarget(55);
    p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });

    expect(p.state.scenario.plan.retirementAge).toBe(55);
    expect(p.state.scenario.ledger.events).toHaveLength(1);
    expect(before.scenario.plan.retirementAge).toBe(baseRetirement);
    expect(before.scenario.ledger.events).toHaveLength(0);
    expect(p.state).not.toBe(before);
  });

  it("keeps plan and ledger coupled as one Scenario across both kinds of write", () => {
    // `Scenario` is one projectable unit: a standing edit carries the timeline through
    // (withPlan), a transaction the standing numbers (withLedger), so no spread drops half.
    const p = freshProjection();
    p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });
    p.setRetirementTarget(55); // a standing edit AFTER a transaction

    expect(p.state.scenario.ledger.events).toHaveLength(1);
    expect(p.state.scenario.plan.retirementAge).toBe(55);

    p.addJob(P1, openEndedJob); // another standing edit
    expect(p.state.scenario.ledger.events).toHaveLength(1);

    p.marry({ month: 24, name: "Partner", birthYear: 1988 }); // a transaction AFTER standing edits
    expect(p.state.scenario.plan.retirementAge).toBe(55);
    expect(p.state.scenario.plan.jobs).toHaveLength(1);
  });

  it("has no undo — writes are reversed by addressable removal, not a stack", () => {
    // Reversal names the thing to drop (`removeTransaction(id)`), so a UI can delete row 3
    // without knowing creation order.
    const p = freshProjection();
    expect("undo" in p).toBe(false);
    expect("depth" in p).toBe(false);
  });

  it("marry() adds a partner as a ledger event", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    expect(partnerId).toBe("person-1");
    expect(p.state.scenario.ledger.events[0]).toMatchObject({ type: "RelationshipEvent" });
  });

  it("takeLoan() carries the kind-determined field for each arm of the union", () => {
    // A card takes a credit limit and never a term, a term loan the reverse — each lands
    // without an `undefined` placeholder.
    const p = freshProjection();
    p.takeLoan({
      month: 6,
      ownerId: P1,
      kind: "creditCard",
      openingBalanceCents: dollarsToCents(2000),
      apr: 22,
      creditLimitCents: dollarsToCents(8000),
    });
    p.takeLoan({
      month: 6,
      ownerId: P1,
      kind: "auto",
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 60,
    });

    const [card, auto] = p.state.scenario.ledger.events;
    expect(card).toMatchObject({ kind: "creditCard", creditLimitCents: dollarsToCents(8000) });
    expect(card).not.toHaveProperty("termMonths");
    expect(auto).toMatchObject({ kind: "auto", termMonths: 60 });
    expect(auto).not.toHaveProperty("creditLimitCents");
  });

  it("a refused ledger transaction leaves the state and the id counter untouched", () => {
    const p = freshProjection();
    const before = p.state;
    // Down payment far exceeds any liquid balance → hard block refuses it.
    expect(() =>
      p.buyHome({
        month: 12,
        ownerId: P1,
        purchasePriceCents: dollarsToCents(500000),
        downPaymentCents: dollarsToCents(400000),
        downPaymentSourceIds: ["savings"],
        mortgageApr: 6,
        mortgageTermMonths: 360,
      }),
    ).toThrow();
    expect(p.state).toBe(before);
    expect(p.addJob(P1, openEndedJob)).toBe("job-1");
  });
});

describe("Projection root — removing a goal guards its fund account", () => {
  const carGoal = {
    name: "Car",
    targetCents: dollarsToCents(30000),
    targetDate: 36,
    disposition: "retain",
    annualReturnPct: 3,
  } as const;

  /**
   * A ledger whose home purchase spends from the goal's fund account. Written straight into
   * the state rather than through `buyHome`, so the removal guard is tested on its own and
   * not through the down-payment affordability gate.
   */
  function withPurchaseFundedBy(p: Projection, goalId: string): Projection {
    const s = p.state;
    const goal = s.scenario.plan.goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`test setup: no goal "${goalId}"`);
    const purchase: LifeEvent = {
      id: "e1",
      type: "HomePurchaseEvent",
      month: 24,
      sequenceNumber: 1,
      propertyId: "home-1",
      ownerId: P1,
      purchasePriceCents: dollarsToCents(300000),
      downPaymentCents: dollarsToCents(60000),
      downPaymentSourceIds: [goalFundAccountId(goal)],
      mortgageLiabilityId: "mortgage-home-1",
      mortgageApr: 0.065,
      mortgageTermMonths: 360,
    };
    return Projection.fromJSON({
      ...s,
      scenario: withLedger(s.scenario, { events: [purchase], nextSequenceNumber: 2 }),
    });
  }

  it("removes a goal no event funds", () => {
    const p = freshProjection();
    const goalId = p.addGoal(carGoal);
    p.removeGoal(goalId);
    expect(p.plan.goals.map((g) => g.id)).not.toContain(goalId);
  });

  it("leaves the other goals alone", () => {
    const p = freshProjection();
    const keep = p.addGoal({ ...carGoal, id: "keep" });
    p.removeGoal(p.addGoal({ ...carGoal, id: "drop" }));
    expect(p.plan.goals.map((g) => g.id)).toEqual([...samplePlan.goals.map((g) => g.id), keep]);
  });

  it("refuses while an event spends from the goal's fund account", () => {
    const p0 = freshProjection();
    const goalId = p0.addGoal({ ...carGoal, id: "house-fund" });
    const p = withPurchaseFundedBy(p0, goalId);
    const before = p.state;

    expect(() => p.removeGoal(goalId)).toThrow(
      /cannot remove goal — Cannot remove goal "house-fund": its fund account "goal-house-fund" funds "e1" \(HomePurchaseEvent, month 24\)/,
    );
    // Refused means untouched, not partially applied.
    expect(p.state).toBe(before);
    expect(p.plan.goals.map((g) => g.id)).toContain(goalId);
  });

  it("allows the removal once the referencing event leaves the ledger", () => {
    const p0 = freshProjection();
    const goalId = p0.addGoal({ ...carGoal, id: "house-fund" });
    const blocked = withPurchaseFundedBy(p0, goalId);
    expect(() => blocked.removeGoal(goalId)).toThrow();

    const s = blocked.state;
    const unblocked = Projection.fromJSON({
      ...s,
      scenario: withLedger(s.scenario, emptyLedger),
    });
    unblocked.removeGoal(goalId);
    expect(unblocked.plan.goals.map((g) => g.id)).not.toContain(goalId);
  });

  it("treats an id that is not a goal as a no-op rather than an error", () => {
    const p = freshProjection();
    expect(() => p.removeGoal("no-such-goal")).not.toThrow();
    expect(p.plan.goals).toEqual(samplePlan.goals);
  });
});

describe("Projection root — editing a goal keeps its id and priority", () => {
  const carGoal = {
    name: "Car",
    targetCents: dollarsToCents(30000),
    targetDate: 36,
    disposition: "retain",
    annualReturnPct: 3,
  } as const;

  it("patches only the named fields, leaving the rest of the goal intact", () => {
    const p = freshProjection();
    const goalId = p.addGoal({ ...carGoal, id: "car" });
    p.updateGoal(goalId, { name: "New car", annualReturnPct: 5 });
    const goal = p.plan.goals.find((g) => g.id === goalId);
    expect(goal).toMatchObject({
      id: "car",
      name: "New car",
      annualReturnPct: 5,
      // Untouched fields survive the patch.
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
    });
  });

  it("holds the goal's list position, so its funding priority is unchanged", () => {
    const p = freshProjection();
    const first = p.addGoal({ ...carGoal, id: "first" });
    const second = p.addGoal({ ...carGoal, id: "second" });
    const before = p.plan.goals.map((g) => g.id);
    p.updateGoal(first, { name: "Renamed" });
    expect(p.plan.goals.map((g) => g.id)).toEqual(before);
    expect(p.plan.goals.map((g) => g.id)).toEqual([
      ...samplePlan.goals.map((g) => g.id),
      first,
      second,
    ]);
  });

  it("treats an id that is not a goal as a no-op rather than an error", () => {
    const p = freshProjection();
    expect(() => p.updateGoal("no-such-goal", { name: "x" })).not.toThrow();
    expect(p.plan.goals).toEqual(samplePlan.goals);
  });
});

describe("Projection root — reordering a goal changes its funding priority", () => {
  const goal = {
    name: "Goal",
    targetCents: dollarsToCents(10000),
    targetDate: 24,
    disposition: "retain",
    annualReturnPct: 3,
  } as const;

  function seededProjection(): { p: Projection; a: string; b: string; c: string } {
    // Start from an empty goal list so priority (array index) reflects only what we add.
    const p = Projection.create({
      plan: { ...samplePlan, jobs: [], budgetLines: [], goals: [] },
      startYear: SAMPLE_START_YEAR,
    });
    return { p, a: p.addGoal({ ...goal, id: "a" }), b: p.addGoal({ ...goal, id: "b" }), c: p.addGoal({ ...goal, id: "c" }) };
  }

  it("moves a goal one slot earlier when funded sooner", () => {
    const { p, b } = seededProjection();
    p.reorderGoal(b, "up");
    expect(p.plan.goals.map((g) => g.id)).toEqual(["b", "a", "c"]);
  });

  it("moves a goal one slot later when funded later", () => {
    const { p, b } = seededProjection();
    p.reorderGoal(b, "down");
    expect(p.plan.goals.map((g) => g.id)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at the ends and for an unknown id", () => {
    const { p, a, c } = seededProjection();
    p.reorderGoal(a, "up"); // already first
    p.reorderGoal(c, "down"); // already last
    p.reorderGoal("no-such-goal", "up");
    expect(p.plan.goals.map((g) => g.id)).toEqual(["a", "b", "c"]);
  });
});

describe("Projection root — editing and removing a job", () => {
  const matchedJob = {
    ...openEndedJob,
    name: "Day job",
    deferral: { deferralFraction: 0.1, fundAccountId: "retirement", employerMatchFraction: 0.5 },
  } as const;

  it("patches only the named fields, carrying the rest of the job through", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, matchedJob);
    p.addJobPayChange(jobId, { month: 12, kind: "changeBy", cents: dollarsToCents(500) });

    p.updateJob(jobId, { name: "Night job", endYear: SAMPLE_START_YEAR + 10 });

    expect(p.plan.jobs[0]).toMatchObject({
      id: jobId,
      name: "Night job",
      endYear: SAMPLE_START_YEAR + 10,
      // Everything the patch did not name survives — including what only the adjustment
      // methods author.
      ownerId: P1,
      salary: matchedJob.salary,
      deferral: matchedJob.deferral,
      payChanges: [{ month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
  });

  it("reassigns a job to another owner", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const jobId = p.addJob(P1, openEndedJob);
    p.updateJob(jobId, { ownerId: partnerId });
    expect(p.plan.jobs[0]?.ownerId).toBe(partnerId);
  });

  it("removes a job, leaving the others alone", () => {
    const p = freshProjection();
    const keep = p.addJob(P1, openEndedJob);
    p.removeJob(p.addJob(P1, openEndedJob));
    expect(p.plan.jobs.map((j) => j.id)).toEqual([keep]);
  });

  it("treats an id that is not a job as a no-op rather than an error", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    const before = p.plan.jobs;
    p.updateJob("no-such-job", { name: "x" });
    p.removeJob("no-such-job");
    p.setJobMonthlyIncome("no-such-job", 1);
    p.setJobDeferralFraction("no-such-job", 0.5);
    expect(p.plan.jobs).toEqual(before);
    expect(p.plan.jobs.map((j) => j.id)).toEqual([jobId]);
  });

  it("setJobMonthlyIncome takes monthly cents and stores the annualized salary", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    p.setJobMonthlyIncome(jobId, dollarsToCents(9000));
    expect(p.plan.jobs[0]?.salary).toEqual({
      startingSalaryCents: dollarsToCents(9000) * 12,
      // The growth rate is not part of "what it pays now".
      realGrowthPct: 0,
    });
  });

  it("setJobDeferralFraction keeps the funded account and employer match", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, matchedJob);
    p.setJobDeferralFraction(jobId, 0.15);
    expect(p.plan.jobs[0]?.deferral).toEqual({
      deferralFraction: 0.15,
      // Both belong to the employment, not to the elected rate.
      fundAccountId: "retirement",
      employerMatchFraction: 0.5,
    });
  });

  it("setJobDeferralFraction(0) removes the deferral rather than recording a 0% one", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, matchedJob);
    p.setJobDeferralFraction(jobId, 0);
    expect(p.plan.jobs[0]).not.toHaveProperty("deferral");
  });
});

describe("Projection root — pay changes and one-month income overrides", () => {
  it("attaches a pay change and replaces one already at that month", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    p.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: dollarsToCents(9000) });
    p.addJobPayChange(jobId, { month: 24, kind: "changeBy", cents: dollarsToCents(500) });
    // Re-authoring the same month replaces rather than stacking a second change there.
    p.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: dollarsToCents(9500) });

    expect(p.plan.jobs[0]?.payChanges).toEqual([
      { month: 24, kind: "changeBy", cents: dollarsToCents(500) },
      { month: 12, kind: "setTo", cents: dollarsToCents(9500) },
    ]);
  });

  it("removes a pay change, dropping the field once none are left", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    p.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: dollarsToCents(9000) });
    p.addJobPayChange(jobId, { month: 24, kind: "setTo", cents: dollarsToCents(9500) });

    p.removeJobPayChange(jobId, 12);
    expect(p.plan.jobs[0]?.payChanges).toEqual([
      { month: 24, kind: "setTo", cents: dollarsToCents(9500) },
    ]);

    p.removeJobPayChange(jobId, 24);
    expect(p.plan.jobs[0]).not.toHaveProperty("payChanges");
  });

  it("attaches a one-month override and removes it, dropping the field once empty", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    p.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: dollarsToCents(5000) });
    p.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: dollarsToCents(6000) });
    expect(p.plan.jobs[0]?.incomeOverrides).toEqual([
      { month: 6, kind: "addBonus", cents: dollarsToCents(6000) },
    ]);

    p.removeJobIncomeOverride(jobId, 6);
    expect(p.plan.jobs[0]).not.toHaveProperty("incomeOverrides");
  });

  it("removing an adjustment that is not there leaves the job untouched", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    const before = p.plan.jobs[0];
    p.removeJobPayChange(jobId, 99);
    p.removeJobIncomeOverride(jobId, 99);
    expect(p.plan.jobs[0]).toEqual(before);
  });
});

describe("Projection root — editing and removing a budget line", () => {
  it("patches the named fields and carries span, overrides and priority through", () => {
    const p = freshProjection();
    const lineId = p.addBudgetLine({
      ...expenseLine,
      priority: 2,
      span: { startMonth: 6 },
      overrides: [{ month: 12, monthlyCents: dollarsToCents(2500), scope: "thisMonthOnly" }],
    });

    p.updateBudgetLine(lineId, {
      label: "Rent (new place)",
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2400) },
    });

    expect(p.plan.budgetLines[0]).toEqual({
      id: lineId,
      label: "Rent (new place)",
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2400) },
      target: { kind: "expense" },
      category: "needs",
      // Timeline facts about the line, not part of what an edit names.
      priority: 2,
      span: { startMonth: 6 },
      overrides: [{ month: 12, monthlyCents: dollarsToCents(2500), scope: "thisMonthOnly" }],
    });
  });

  it("switches an expense line to a contribution by replacing the whole target", () => {
    const p = freshProjection();
    const lineId = p.addBudgetLine(expenseLine);
    p.updateBudgetLine(lineId, {
      category: "savings",
      target: { kind: "account", accountId: "brokerage", taxTreatment: "postTax" },
    });
    expect(p.plan.budgetLines[0]?.target).toEqual({
      kind: "account",
      accountId: "brokerage",
      taxTreatment: "postTax",
    });
  });

  it("removes a line, leaving the others alone", () => {
    const p = freshProjection();
    const keep = p.addBudgetLine(expenseLine);
    p.removeBudgetLine(p.addBudgetLine(expenseLine));
    expect(p.plan.budgetLines.map((l) => l.id)).toEqual([keep]);
  });

  it("treats an id that is not a line as a no-op rather than an error", () => {
    const p = freshProjection();
    p.addBudgetLine(expenseLine);
    const before = p.plan.budgetLines;
    p.updateBudgetLine("no-such-line", { label: "x" });
    p.removeBudgetLine("no-such-line");
    expect(p.plan.budgetLines).toEqual(before);
  });
});

describe("Projection root — patching the plan's standing scalars", () => {
  it("writes any scalar the budget editor writes, in one call", () => {
    const p = freshProjection();
    p.updatePlan({
      name: "Renamed",
      openingBalanceCents: dollarsToCents(50000),
      savingsReturnPct: 2,
      inflationPct: 4,
      currentAge: 41,
      lifeExpectancy: 90,
      benefitClaimingAge: 70,
      enrollsInPublicHealthCoverage: false,
      surplusCashTo: "brokerage",
      sharedScheme: "even",
    });

    expect(p.plan).toMatchObject({
      name: "Renamed",
      openingBalanceCents: dollarsToCents(50000),
      savingsReturnPct: 2,
      inflationPct: 4,
      currentAge: 41,
      lifeExpectancy: 90,
      benefitClaimingAge: 70,
      enrollsInPublicHealthCoverage: false,
      surplusCashTo: "brokerage",
      sharedScheme: "even",
      // Unnamed scalars keep their authored values.
      retirementAge: samplePlan.retirementAge,
      brokerageReturnPct: samplePlan.brokerageReturnPct,
    });
  });

  it("cannot reach the collections, so no edit bypasses their guards", () => {
    const p = freshProjection();
    const goalId = p.addGoal({
      name: "Car",
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
      annualReturnPct: 3,
      id: "car",
    });
    const jobId = p.addJob(P1, openEndedJob);
    const lineId = p.addBudgetLine(expenseLine);

    // A `Partial<Plan>` would make `updatePlan({ goals: [] })` a way past `removeGoal`'s
    // fund-account guard. `PlanPatch` excludes the collections, so it does not typecheck —
    // and they are dropped at runtime too, for the JavaScript caller the type never reaches.
    // @ts-expect-error the collections are not part of PlanPatch
    p.updatePlan({ goals: [], jobs: [], budgetLines: [], inflationPct: 4 });

    expect(p.plan.goals.map((g) => g.id)).toContain(goalId);
    expect(p.plan.jobs.map((j) => j.id)).toEqual([jobId]);
    expect(p.plan.budgetLines.map((l) => l.id)).toEqual([lineId]);
    // The scalar in the same patch still lands — only the collections are refused.
    expect(p.plan.inflationPct).toBe(4);
  });

  it("setRetirementTarget writes the same scalar and carries the ledger through", () => {
    const p = freshProjection();
    p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });
    p.setRetirementTarget(58);
    expect(p.plan.retirementAge).toBe(58);
    expect(p.ledger.events).toHaveLength(1);
  });
});

describe("Projection root — the remaining ledger transactions", () => {
  it("haveChild() records a child, using one id for the event and the child", () => {
    const p = freshProjection();
    const childId = p.haveChild({ month: 12, name: "Robin", annualCostCents: dollarsToCents(12000) });
    expect(childId).toBe("child-1");
    expect(p.ledger.events[0]).toMatchObject({
      id: childId,
      type: "ChildEvent",
      childId,
      childName: "Robin",
      // Recorded as it happens: birthMonth defaults to the event's month.
      birthMonth: 12,
      annualCostCents: dollarsToCents(12000),
    });
  });

  it("haveChild() takes a birthMonth of its own for a child entered after the fact", () => {
    const p = freshProjection();
    p.haveChild({ month: 0, name: "Sam", annualCostCents: 0, birthMonth: -60 });
    expect(p.ledger.events[0]).toMatchObject({ month: 0, birthMonth: -60 });
  });

  it("separate() ends a partnership authored by marry()", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const separationId = p.separate({
      month: 60,
      partnerPersonId: partnerId,
      alimonyMonthlyCents: dollarsToCents(1000),
      alimonyDurationMonths: 36,
    });

    expect(separationId).toBe("separation-2");
    expect(p.ledger.events[1]).toMatchObject({
      id: separationId,
      type: "SeparationEvent",
      partnerPersonId: partnerId,
      alimonyMonthlyCents: dollarsToCents(1000),
      alimonyDurationMonths: 36,
      // The no-support default, stated rather than omitted.
      childSupportMonthlyCents: 0,
    });
  });

  it("separate() is refused before the partnering it would end", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const before = p.state;
    expect(() => p.separate({ month: 12, partnerPersonId: partnerId })).toThrow(
      /cannot apply transaction — .*before partnering at month 24/,
    );
    expect(p.state).toBe(before);
  });

  it("payOffDebt() pays a liability down from a named account", () => {
    const p = freshProjection();
    const loanId = p.takeLoan({
      month: 6,
      ownerId: P1,
      kind: "auto",
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 60,
    });
    const payoffId = p.payOffDebt({
      month: 12,
      liabilityId: loanId,
      accountId: "savings",
      amountCents: dollarsToCents(5000),
    });

    expect(payoffId).toBe("payoff-2");
    expect(p.ledger.events[1]).toMatchObject({
      id: payoffId,
      type: "DebtPayoffEvent",
      liabilityId: loanId,
      accountId: "savings",
      amountCents: dollarsToCents(5000),
    });
  });

  it("payOffDebt() is refused against a liability that does not exist", () => {
    const p = freshProjection();
    const before = p.state;
    expect(() =>
      p.payOffDebt({ month: 12, liabilityId: "no-such-loan", accountId: "savings", amountCents: 100 }),
    ).toThrow(/cannot apply transaction — .*liability "no-such-loan" not found/);
    expect(p.state).toBe(before);
  });
});

describe("Projection root — a transaction can be removed, revised, or swapped wholesale", () => {
  function marriedProjection(): { p: Projection; partnerId: string } {
    const p = freshProjection();
    return { p, partnerId: p.marry({ month: 24, name: "Partner", birthYear: 1988 }) };
  }

  it("removes a transaction by id, not by position", () => {
    const p = freshProjection();
    const first = p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });
    const second = p.takeLoan({ month: 6, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(5000), apr: 4, termMonths: 24 });

    p.removeTransaction(first);
    expect(p.ledger.events.map((e) => e.id)).toEqual([second]);
  });

  it("refuses a removal that would strand a later transaction, naming it", () => {
    const { p, partnerId } = marriedProjection();
    const separationId = p.separate({ month: 60, partnerPersonId: partnerId });
    const before = p.state;

    expect(() => p.removeTransaction(partnerId)).toThrow(
      new RegExp(`cannot remove transaction — .*causes event "${separationId}" \\(SeparationEvent\\) to fail`),
    );
    // Refused means untouched, not partially applied.
    expect(p.state).toBe(before);
    expect(p.ledger.events).toHaveLength(2);

    // Removing the dependent first unblocks it.
    p.removeTransaction(separationId);
    p.removeTransaction(partnerId);
    expect(p.ledger.events).toHaveLength(0);
  });

  it("refuses to remove an id that is not in the ledger", () => {
    const p = freshProjection();
    expect(() => p.removeTransaction("no-such-event")).toThrow(
      /No event with id "no-such-event" to remove/,
    );
  });

  it("revises a transaction in place, keeping its id and its place in the log", () => {
    const { p, partnerId } = marriedProjection();
    const [before] = p.ledger.events;

    p.reviseTransaction(partnerId, {
      id: partnerId,
      type: "RelationshipEvent",
      month: 36,
      person: {
        id: partnerId,
        name: "Partner",
        birthYear: 1988,
        retirementTargetAge: 65,
        benefitClaimingAge: 67,
        // The motivating case: a partner's jobs live ON their event, so without a revision
        // they would be write-once.
        jobs: [
          {
            id: "partner-job-1",
            ownerId: partnerId,
            startYear: SAMPLE_START_YEAR,
            endYear: null,
            salary: { startingSalaryCents: dollarsToCents(60000), realGrowthPct: 0 },
          },
        ],
      },
    });

    const [after] = p.ledger.events;
    expect(after).toMatchObject({ id: partnerId, month: 36 });
    expect(after?.sequenceNumber).toBe(before?.sequenceNumber);
    expect(p.ledger.events).toHaveLength(1);
  });

  it("refuses a revision that would strand a later transaction", () => {
    const { p, partnerId } = marriedProjection();
    p.separate({ month: 36, partnerPersonId: partnerId });
    const before = p.state;

    // Moving the marriage past the separation leaves the separation with nothing to end.
    expect(() =>
      p.reviseTransaction(partnerId, {
        id: partnerId,
        type: "RelationshipEvent",
        month: 48,
        person: {
          id: partnerId,
          name: "Partner",
          birthYear: 1988,
          retirementTargetAge: 65,
          benefitClaimingAge: 67,
          jobs: [],
        },
      }),
    ).toThrow(/cannot revise transaction — /);
    expect(p.state).toBe(before);
  });

  it("resetLedger swaps the timeline while the plan stays put", () => {
    const p = freshProjection();
    p.setRetirementTarget(58);
    p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });

    p.resetLedger(emptyLedger);

    expect(p.ledger.events).toHaveLength(0);
    // Unlike fromJSON, the standing plan authored alongside the timeline survives.
    expect(p.plan.retirementAge).toBe(58);
  });
});

describe("Projection root — id counter round-trips through serialization", () => {
  it("a reloaded plan continues the sequence without collision", () => {
    const p = freshProjection();
    p.addJob(P1, openEndedJob); // job-1
    p.addBudgetLine(expenseLine); // line-2 → nextSeq now 3

    const snapshot = JSON.parse(JSON.stringify(p.toJSON()));
    const reloaded = Projection.fromJSON(snapshot);

    // The counter survived: the next mint is 3, not a colliding 1.
    expect(reloaded.state.nextSeq).toBe(3);
    expect(reloaded.addGoal({
      name: "Trip",
      targetCents: dollarsToCents(5000),
      targetDate: 12,
      disposition: "retain",
      annualReturnPct: 2,
    })).toBe("goal-3");
    expect(reloaded.state.scenario.plan.jobs).toHaveLength(1);
    expect(reloaded.state.scenario.plan.budgetLines).toHaveLength(1);
  });
});

describe("Projection root — run(jurisdiction) → immutable result, no mutation", () => {
  it("computes a per-month series and is frozen", () => {
    const p = freshProjection();
    const result = p.run(nullJurisdiction);
    expect(result.jurisdictionId).toBe("null");
    expect(result.series.months.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("runs the SAME plan under two jurisdictions without mutating the projection", () => {
    const p = freshProjection();
    p.addJob(P1, openEndedJob);
    const before = p.toJSON();

    const untaxed = p.run(nullJurisdiction);
    // A flat monthly tax bleeds net worth, so the taxed run must diverge from the null one.
    const taxed = p.run(
      mockJurisdiction({
        id: "flat-tax",
        computeTaxCents: () => dollarsToCents(1500),
        // The flat tax must reconcile per source, so key it to the job's wage income.
        computeTaxByCategoryCents: () => ({ wages: dollarsToCents(1500) }),
      }),
    );

    expect(taxed.jurisdictionId).toBe("flat-tax");
    const lastUntaxed = untaxed.series.months.at(-1)?.netWorthNominalCents;
    const lastTaxed = taxed.series.months.at(-1)?.netWorthNominalCents;
    expect(lastTaxed).not.toBe(lastUntaxed);

    // run() is read-only: the authoring state is identical before and after.
    expect(p.toJSON()).toBe(before);
  });
});

describe("Projection root — per-line monthly resolution in the result", () => {
  const RENT = "line:rent";
  const FUN = "line:fun";

  it("funds every budget line to its intent in a solvent month, keyed by allocations() id", () => {
    // 8k/mo take-home (nullJurisdiction = no tax) easily covers a $2,500 budget.
    const p = Projection.create({
      plan: { ...samplePlan, goals: [] },
      startYear: SAMPLE_START_YEAR,
    });
    p.addBudgetLine({
      id: "rent",
      label: "Rent",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2_000) },
      category: "needs",
    });
    p.addBudgetLine({
      id: "fun",
      label: "Fun",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) },
      category: "wants",
    });

    const flows = p.run(nullJurisdiction).series.months[1]?.flows;
    // Keyed by the allocations() id (`line:<id>`).
    expect(flows?.lineMonthlyCents[RENT]).toBe(dollarsToCents(2_000));
    expect(flows?.lineMonthlyCents[FUN]).toBe(dollarsToCents(500));
  });

  it("reports every line at its full amount even once the plan is insolvent", () => {
    // $3k/mo income against a $6k/mo budget, no assets to liquidate → a genuine
    // shortfall. Priority funds rent (a need) before fun (a want).
    const p = Projection.create({
      plan: {
        ...samplePlan,
        jobs: [salariedJob(dollarsToCents(3_000))],
        openingBalanceCents: 0,
        goals: [],
        healthMonthlyCents: 0,
        postCoverageHealthMonthlyCents: 0,
        enrollsInPublicHealthCoverage: false,
      },
      startYear: SAMPLE_START_YEAR,
    });
    p.addBudgetLine({
      id: "rent",
      label: "Rent",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(4_000) },
      category: "needs",
    });
    p.addBudgetLine({
      id: "fun",
      label: "Fun",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2_000) },
      category: "wants",
    });

    const months = p.run(nullJurisdiction).series.months;

    // A squeezed month is absorbed by savings, then credit — the household really did pay
    // for all of it.
    expect(months[1]?.flows?.lineMonthlyCents[FUN]).toBe(dollarsToCents(2_000));
    expect(months[1]?.flows?.lineMonthlyCents[RENT]).toBe(dollarsToCents(4_000));

    // Once even credit is exhausted the budget is still reported as authored: the engine
    // surfaces that the plan broke (`isInsolvent`), it does not decide which spending the
    // user would have given up.
    const broke = months.findIndex((m) => m.isInsolvent);
    expect(broke).toBeGreaterThan(1);
    const flows = months[broke]?.flows;
    expect(flows?.lineMonthlyCents[FUN]).toBeGreaterThan(0);
    expect(flows?.lineMonthlyCents[RENT]).toBeGreaterThan(0);
    // The per-line map and the coarse rollup agree: nothing was rationed away.
    const lineTotal = Object.values(flows?.lineMonthlyCents ?? {}).reduce((a, b) => a + b, 0);
    expect(lineTotal).toBe(flows?.expensesCents);
  });

  it("keeps every line funded from savings between retirement and the first benefit", () => {
    // samplePlan retires at 60 and claims its benefit at 67, so ages 60–67 have no income
    // at all. Funding the budget by drawing savings down is the plan working, not a starved
    // budget.
    const p = Projection.create({
      plan: {
        ...samplePlan,
        openingBalanceCents: dollarsToCents(2_000_000),
        goals: [],
        healthMonthlyCents: 0,
        postCoverageHealthMonthlyCents: 0,
        enrollsInPublicHealthCoverage: false,
      },
      startYear: SAMPLE_START_YEAR,
    });
    p.addBudgetLine({
      id: "rent",
      label: "Rent",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2_000) },
      category: "needs",
    });
    p.addBudgetLine({
      id: "fun",
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
    expect(flows?.lineMonthlyCents[FUN]).toBeGreaterThan(0); // the first line to starve

    // Nothing starves anywhere across the whole gap.
    for (let m = (60 - samplePlan.currentAge) * 12; m <= (67 - samplePlan.currentAge) * 12; m++) {
      expect(fundedTotal(m)).toBe(months[m]?.flows?.expensesCents);
    }
  });
});
