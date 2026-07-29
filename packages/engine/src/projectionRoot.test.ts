/**
 * The `Projection` root — the npm API surface: standing edits and ledger transactions on one
 * object, deterministic minted ids, immutable state swaps with no undo stack, and
 * `run(jurisdiction)` leaving the plan untouched. Barrel/purity is covered elsewhere.
 */
import { describe, it, expect } from "vitest";
import { Projection, type ProjectionState } from "./projectionRoot";
import { samplePlan, salariedJob, SAMPLE_START_YEAR } from "./testing/samplePlan";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";
import { dollarsToCents } from "./cashFlowSeries";
import { goalFundAccountId } from "./projectionBase";
import { withLedger } from "./scenario";
import { emptyLedger, type Ledger } from "./ledger/ledger";
import type { LifeEvent } from "./ledger/eventTypes";
import type { PersonId } from "./job";

const P1 = "p1" as PersonId;

function freshProjection(): Projection {
  // Empty job and budget-line lists so minted ids and roster lengths reflect only what each
  // test adds — the sample plan seeds a spend line that would otherwise skew the counts.
  return Projection.create(
    {
      plan: { ...samplePlan, jobs: [], budgetLines: [] },
      startYear: SAMPLE_START_YEAR,
    },
    nullJurisdiction,
  );
}

const openEndedJob = {
  startYear: SAMPLE_START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
} as const;

/** The partner a single `marry()` authored, whose jobs live on the event, not the plan. */
function partnerEvent(p: Projection) {
  const event = p.state.scenario.ledger.events[0];
  if (event?.type !== "RelationshipEvent") throw new Error("expected a RelationshipEvent");
  return event;
}

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

  it("marry() mints an id and owner for each of the partner's jobs", () => {
    const p = freshProjection();
    // JobInput carries no id or ownerId — the engine mints both, so the caller never has to.
    const partnerId = p.marry({
      month: 24,
      name: "Partner",
      birthYear: 1988,
      jobs: [openEndedJob, openEndedJob],
    });
    const partnerJobs = partnerEvent(p).person.jobs;

    // Person plus two jobs = three minted ids, all distinct.
    const minted = [partnerId, ...partnerJobs.map((j) => j.id)];
    expect(new Set(minted).size).toBe(3);
    // Each job is owned by the partner the engine just created, not the caller's guess.
    expect(partnerJobs.every((j) => j.ownerId === partnerId)).toBe(true);
    // A subsequent addJob clears all three, so the counter walked past the nested jobs.
    expect(minted).not.toContain(p.addJob(P1, openEndedJob));
  });

  it("marry() preserves a partner job's explicit id override and steps the counter past it", () => {
    const p = freshProjection();
    p.marry({
      month: 24,
      name: "Partner",
      birthYear: 1988,
      // `job-5` is one of our own ids, so it must be returned verbatim AND advance the counter.
      jobs: [{ ...openEndedJob, id: "job-5" }],
    });
    expect(partnerEvent(p).person.jobs[0]?.id).toBe("job-5");
    // The next mint clears the override rather than colliding with it.
    expect(p.addJob(P1, openEndedJob)).toBe("job-6");
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
    return Projection.fromState(
      {
        ...s,
        scenario: withLedger(s.scenario, { events: [purchase], nextSequenceNumber: 2 }),
      },
      nullJurisdiction,
    );
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
    const unblocked = Projection.fromState(
      {
        ...s,
        scenario: withLedger(s.scenario, emptyLedger),
      },
      nullJurisdiction,
    );
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
    const p = Projection.create(
      {
        plan: { ...samplePlan, jobs: [], budgetLines: [], goals: [] },
        startYear: SAMPLE_START_YEAR,
      },
      nullJurisdiction,
    );
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

  it("resetLedger advances both counters past what the import already occupies", () => {
    const p = freshProjection();
    // An id counter sitting exactly where the import already is: a fresh Projection's
    // `nextSeq` is 1, and the imported event is `child-1` at sequenceNumber 1. Before the
    // fix, the next haveChild() minted `child-1` a second time — refused by the duplicate
    // -child guard — and the next append reused sequence number 1.
    const imported: Ledger = {
      events: [
        {
          id: "child-1",
          type: "ChildEvent",
          month: 12,
          sequenceNumber: 1,
          childId: "child-1",
          childName: "Robin",
          birthMonth: 12,
          annualCostCents: dollarsToCents(12_000),
        },
      ],
      nextSequenceNumber: 2,
    };
    p.resetLedger(imported);

    const newChildId = p.haveChild({ month: 36, name: "Sam", annualCostCents: dollarsToCents(9_000) });

    // A distinct id, and a place in the log after the event it was imported alongside.
    expect(newChildId).not.toBe("child-1");
    const ids = p.ledger.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const imported0 = p.ledger.events.find((e) => e.id === "child-1");
    const added = p.ledger.events.find((e) => e.id === newChildId);
    expect(added?.sequenceNumber).toBeGreaterThan(imported0?.sequenceNumber ?? 0);

    // Both events remain individually addressable: a revision lands on the imported one and
    // leaves the new one alone, and a removal takes only the event it names.
    p.reviseTransaction("child-1", {
      id: "child-1",
      type: "ChildEvent",
      month: 12,
      childId: "child-1",
      childName: "Robin (renamed)",
      birthMonth: 12,
      annualCostCents: dollarsToCents(15_000),
    });
    expect(p.ledger.events.find((e) => e.id === "child-1")).toMatchObject({
      childName: "Robin (renamed)",
      // A revision keeps its place in the log.
      sequenceNumber: imported0?.sequenceNumber,
    });
    expect(p.ledger.events.find((e) => e.id === newChildId)).toMatchObject({ childName: "Sam" });

    p.removeTransaction("child-1");
    expect(p.ledger.events.map((e) => e.id)).toEqual([newChildId]);
  });

  it("resetLedger clears a sequence number an import would otherwise hand out twice", () => {
    // A ledger whose own `nextSequenceNumber` violates the Ledger invariant — it is not above
    // every event's `sequenceNumber`. Nothing validates data arriving from outside, so before
    // the fix `addEvent` stamped 3, then 4, and the 4 collided with the imported event.
    const p = freshProjection();
    p.resetLedger({
      events: [
        {
          id: "imported-loan",
          type: "LoanEvent",
          month: 6,
          sequenceNumber: 4,
          kind: "auto",
          liabilityId: "imported-loan",
          ownerId: P1,
          openingBalanceCents: dollarsToCents(20_000),
          apr: 5,
          termMonths: 60,
        },
      ],
      nextSequenceNumber: 3,
    });

    const loanId = p.takeLoan({
      month: 12,
      ownerId: P1,
      kind: "auto",
      openingBalanceCents: dollarsToCents(5_000),
      apr: 4,
      termMonths: 24,
    });

    const seqs = p.ledger.events.map((e) => e.sequenceNumber);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(p.ledger.events.find((e) => e.id === loanId)?.sequenceNumber).toBeGreaterThan(4);
  });

  it("resetLedger never walks the id counter backwards", () => {
    // Ids this Projection already issued stay spent, even when the import is emptier than
    // what came before — otherwise a reset would re-mint over the plan's own jobs.
    const p = freshProjection();
    p.addJob(P1, openEndedJob); // job-1
    p.addJob(P1, openEndedJob); // job-2
    p.resetLedger(emptyLedger);
    expect(p.addJob(P1, openEndedJob)).toBe("job-3");
  });

  it("resetLedger reads named id fields, not every string it can reach", () => {
    // `childName` is a person's words. A scan over every string in the ledger would read
    // "goal-50000" as a counter reading and advance the mint by fifty thousand on the
    // strength of a name.
    const p = freshProjection();
    p.resetLedger({
      events: [
        {
          id: "imported-child",
          type: "ChildEvent",
          month: 12,
          sequenceNumber: 0,
          childId: "imported-child",
          childName: "room-50000",
          birthMonth: 12,
          annualCostCents: 0,
        },
        {
          id: "imported-child-2",
          type: "ChildEvent",
          month: 18,
          sequenceNumber: 1,
          childId: "imported-child-2",
          // Mint-SHAPED and a real minted kind — still a name, still ignored.
          childName: "goal-50000",
          birthMonth: 18,
          annualCostCents: 0,
        },
      ],
      nextSequenceNumber: 2,
    });

    // Only the two sequence numbers moved the floor, so the next goal is goal-2, not goal-50001.
    expect(p.addGoal({
      name: "Car",
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
      annualReturnPct: 3,
    })).toBe("goal-2");
  });

  it("resetLedger swaps the timeline while the plan stays put", () => {
    const p = freshProjection();
    p.setRetirementTarget(58);
    p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });

    p.resetLedger(emptyLedger);

    expect(p.ledger.events).toHaveLength(0);
    // Unlike fromState, the standing plan authored alongside the timeline survives.
    expect(p.plan.retirementAge).toBe(58);
  });
});

describe("Projection root — fromScenario imports a plan and its timeline together", () => {
  it("carries the timeline and floors the shared counter past the ids it already holds", () => {
    // A scenario that arrives already built: a plan holding `job-4`, a ledger whose event holds
    // `loan-2` at sequence number 2. fromScenario keeps the timeline — unlike create, which
    // always starts from an empty ledger — and floors the shared counter past both.
    const scenario = {
      plan: {
        ...samplePlan,
        goals: [],
        budgetLines: [],
        jobs: [{ ...openEndedJob, id: "job-4", ownerId: P1 }],
      },
      ledger: {
        events: [
          {
            id: "loan-2",
            type: "LoanEvent" as const,
            month: 6,
            sequenceNumber: 2,
            kind: "auto" as const,
            liabilityId: "loan-2",
            ownerId: P1,
            openingBalanceCents: dollarsToCents(20000),
            apr: 5,
            termMonths: 60,
          },
        ],
        nextSequenceNumber: 0,
      },
    };

    const p = Projection.fromScenario(scenario, SAMPLE_START_YEAR, nullJurisdiction);

    // The imported event survived the construction.
    expect(p.ledger.events.map((e) => e.id)).toEqual(["loan-2"]);
    // The id floor cleared `job-4`, so the next mint is `job-5`.
    expect(p.addJob(P1, openEndedJob)).toBe("job-5");
    // One shared counter: the sequence side was lifted to that same floor, so the next append
    // lands at or above 5 — well clear of the imported event still sitting at 2.
    const eventId = p.takeLoan({ month: 12, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(1000), apr: 4, termMonths: 24 });
    const appended = p.ledger.events.find((e) => e.id === eventId);
    expect(appended?.sequenceNumber).toBeGreaterThanOrEqual(5);
  });
});

describe("Projection root — the id counter starts clear of the plan it is given", () => {
  function planWith(overrides: Partial<typeof samplePlan>) {
    return { ...samplePlan, jobs: [], budgetLines: [], goals: [], ...overrides };
  }

  const jobAt = (id: string) => ({
    id,
    ownerId: P1,
    startYear: SAMPLE_START_YEAR,
    endYear: null,
    salary: { startingSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
  });

  it("mints past a job the supplied plan already holds", () => {
    // The app's own PLAN_DEFAULTS ships a `job-1`; before the fix a counter starting at 1
    // minted a second one and the plan carried two jobs under one id.
    const p = Projection.create(
      {
        plan: planWith({ jobs: [jobAt("job-1")] }),
        startYear: SAMPLE_START_YEAR,
      },
      nullJurisdiction,
    );

    const added = p.addJob(P1, openEndedJob);
    expect(added).not.toBe("job-1");
    expect(added).toBe("job-2");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes the floor from every plan collection, not just the one it is minting into", () => {
    const p = Projection.create(
      {
        plan: planWith({
          jobs: [jobAt("job-3")],
          goals: [{
            id: "goal-7",
            name: "Car",
            targetCents: dollarsToCents(30000),
            targetDate: 36,
            disposition: "retain",
            annualReturnPct: 3,
          }],
          budgetLines: [{ ...expenseLine, id: "line-5" }],
        }),
        startYear: SAMPLE_START_YEAR,
      },
      nullJurisdiction,
    );

    // One counter across all kinds, so the highest id in ANY collection sets the floor.
    expect(p.addJob(P1, openEndedJob)).toBe("job-8");
    expect(p.addBudgetLine(expenseLine)).toBe("line-9");
  });

  it("counts ids nested inside an imported partner's own jobs", () => {
    const p = freshProjection();
    p.resetLedger({
      events: [
        {
          id: "person-4",
          type: "RelationshipEvent",
          month: 24,
          sequenceNumber: 0,
          person: {
            id: "person-4",
            name: "Partner",
            birthYear: 1988,
            retirementTargetAge: 65,
            benefitClaimingAge: 67,
            // A partner's jobs live ON their event — a floor reading only the event's own
            // fields would hand `job-9` straight back out.
            jobs: [jobAt("job-9")],
          },
        },
      ],
      nextSequenceNumber: 1,
    });

    expect(p.addJob(P1, openEndedJob)).toBe("job-10");
  });

  it("ignores an id-shaped suffix past MAX_SAFE_INTEGER, and still mints uniquely", () => {
    // Past 2^53 `Number` rounds, so honouring the suffix would set a floor the counter can
    // never pass — and incrementing a non-safe integer is a no-op, so the mint would hand out
    // the SAME id forever. Ignoring it is both safe and correct: `mint` cannot have issued a
    // number it cannot count to.
    const p = Projection.create(
      {
        plan: planWith({ jobs: [jobAt("job-9007199254740993")] }),
        startYear: SAMPLE_START_YEAR,
      },
      nullJurisdiction,
    );

    const first = p.addJob(P1, openEndedJob);
    const second = p.addJob(P1, openEndedJob);
    expect(first).toBe("job-1");
    expect(second).toBe("job-2");
    expect(first).not.toBe(second);
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Same guard on the import path, where the id sits in a real id field.
    p.resetLedger({
      events: [
        {
          id: "loan-9007199254740993",
          type: "LoanEvent",
          month: 6,
          sequenceNumber: 0,
          kind: "auto",
          liabilityId: "loan-9007199254740993",
          ownerId: P1,
          openingBalanceCents: dollarsToCents(20_000),
          apr: 5,
          termMonths: 60,
        },
      ],
      nextSequenceNumber: 1,
    });

    const a = p.takeLoan({ month: 12, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(1_000), apr: 4, termMonths: 24 });
    const b = p.takeLoan({ month: 18, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(1_000), apr: 4, termMonths: 24 });
    expect(a).not.toBe(b);
    const eventIds = p.ledger.events.map((e) => e.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("never walks the counter backwards, through create or a later reset", () => {
    const p = Projection.create(
      {
        plan: planWith({ jobs: [jobAt("job-6")] }),
        startYear: SAMPLE_START_YEAR,
      },
      nullJurisdiction,
    );
    expect(p.addJob(P1, openEndedJob)).toBe("job-7");

    // An emptier import must not release ids already spent — neither the plan's `job-6` nor
    // the `job-7` just minted.
    p.resetLedger(emptyLedger);
    expect(p.addJob(P1, openEndedJob)).toBe("job-8");
  });

  it("still addresses the right entity after the counter has been advanced", () => {
    const p = Projection.create(
      {
        plan: planWith({ jobs: [jobAt("job-1")] }),
        startYear: SAMPLE_START_YEAR,
      },
      nullJurisdiction,
    );
    const added = p.addJob(P1, openEndedJob);

    p.updateJob(added, { name: "Second job" });
    expect(p.plan.jobs.find((j) => j.id === "job-1")).not.toHaveProperty("name");
    expect(p.plan.jobs.find((j) => j.id === added)).toMatchObject({ name: "Second job" });

    p.removeJob(added);
    expect(p.plan.jobs.map((j) => j.id)).toEqual(["job-1"]);
  });
});

describe("Projection root — an authored id claims the counter", () => {
  const partnerJob = (id: string) => ({
    id,
    ownerId: "partner" as PersonId,
    startYear: SAMPLE_START_YEAR,
    endYear: null,
    salary: { startingSalaryCents: dollarsToCents(60000), realGrowthPct: 0 },
  });

  it("steps over an explicitly authored id rather than minting onto it", () => {
    const p = freshProjection();
    p.addJob(P1, { ...openEndedJob, id: "job-2" });

    const second = p.addJob(P1, openEndedJob);
    const third = p.addJob(P1, openEndedJob);

    // Before the fix the override consumed nothing, so the mint walked 1, 2 — straight back
    // onto the authored id.
    expect(second).toBe("job-3");
    expect(third).toBe("job-4");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(ids).toEqual(["job-2", "job-3", "job-4"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("claims the shared counter, so an override of one kind moves every kind", () => {
    const p = freshProjection();
    p.addGoal({
      name: "Car",
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
      annualReturnPct: 3,
      id: "goal-6",
    });
    // One counter across all kinds — `goal-6` spends 6 for jobs and loans too.
    expect(p.addJob(P1, openEndedJob)).toBe("job-7");
  });

  it("leaves the counter alone for an id it did not mint", () => {
    const p = freshProjection();
    p.addJob(P1, { ...openEndedJob, id: "external-payroll-job" });
    // Not a shape `mint` produces, so no future id can collide with it and nothing is spent.
    expect(p.addJob(P1, openEndedJob)).toBe("job-1");
  });

  it("leaves the counter alone for a suffix past MAX_SAFE_INTEGER, and still mints uniquely", () => {
    const p = freshProjection();
    p.addJob(P1, { ...openEndedJob, id: "job-9007199254740993" });

    const a = p.addJob(P1, openEndedJob);
    const b = p.addJob(P1, openEndedJob);
    // Honouring the suffix would have set a floor the counter cannot pass — and incrementing
    // a non-safe integer is a no-op, so every later mint would return the SAME id.
    expect(a).toBe("job-1");
    expect(b).toBe("job-2");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("floors the counter on ids a transaction CARRIES, not just the one it mints", () => {
    // A partner arrives already holding `job-9`. It never passes through the mint, so only a
    // floor taken from the committed state sees it.
    const p = freshProjection();
    p.marry({
      month: 24,
      name: "Partner",
      birthYear: 1988,
      id: "partner",
      jobs: [partnerJob("job-9")],
    });

    expect(p.addJob(P1, openEndedJob)).toBe("job-10");
  });

  it("floors the counter on ids a revision introduces", () => {
    const p = freshProjection();
    p.marry({ month: 24, name: "Partner", birthYear: 1988, id: "partner" });
    // The shared counter floors both ids and sequence numbers, so the marriage's own event
    // (which takes the first sequence number) steps the counter one past it — the first
    // authored job is `job-2`, a harmless gap, the same as any other construction path.
    expect(p.addJob(P1, openEndedJob)).toBe("job-2");

    // The partner picks up a job named elsewhere — a second way nested ids arrive.
    p.reviseTransaction("partner", {
      id: "partner",
      type: "RelationshipEvent",
      month: 24,
      person: {
        id: "partner",
        name: "Partner",
        birthYear: 1988,
        retirementTargetAge: 65,
        benefitClaimingAge: 67,
        jobs: [partnerJob("job-12")],
      },
    });

    expect(p.addJob(P1, openEndedJob)).toBe("job-13");
  });

  it("a refused transaction consumes no id, override or not", () => {
    const p = freshProjection();
    const before = p.state;

    expect(() =>
      p.buyHome({
        month: 12,
        ownerId: P1,
        id: "home-8",
        purchasePriceCents: dollarsToCents(500000),
        downPaymentCents: dollarsToCents(400000),
        downPaymentSourceIds: ["savings"],
        mortgageApr: 6,
        mortgageTermMonths: 360,
      }),
    ).toThrow();

    // The refusal never reached the commit, so `home-8` claimed nothing.
    expect(p.state).toBe(before);
    expect(p.state.nextSeq).toBe(before.nextSeq);
    expect(p.addJob(P1, openEndedJob)).toBe("job-1");
  });
});

describe("Projection root — transact wraps one write over plain state", () => {
  it("returns the next state and the write's own result, leaving the input state untouched", () => {
    const before = freshProjection().state;
    const { state, result } = Projection.transact(before, nullJurisdiction, (p) =>
      p.addJob(P1, openEndedJob),
    );

    // The id-returning write hands its id straight back through `result`.
    expect(result).toBe("job-1");
    // The next state carries the write; the state passed in is never mutated in place.
    expect(state.scenario.plan.jobs.map((j) => j.id)).toEqual(["job-1"]);
    expect(before.scenario.plan.jobs).toHaveLength(0);
  });

  it("carries a void write through as an undefined result", () => {
    const seeded = Projection.transact(freshProjection().state, nullJurisdiction, (p) =>
      p.addJob(P1, openEndedJob),
    );
    const { state, result } = Projection.transact(seeded.state, nullJurisdiction, (p) =>
      p.setJobMonthlyIncome("job-1", dollarsToCents(9000)),
    );

    expect(result).toBeUndefined();
    expect(state.scenario.plan.jobs[0]?.salary.startingSalaryCents).toBe(dollarsToCents(108000));
  });

  it("floors the counter on ids the imported state already carries", () => {
    // The handle is built through the flooring path, so a write inside the transaction mints
    // clear of a `job-5` the imported state already holds rather than colliding with it.
    const seeded: ProjectionState = {
      startYear: SAMPLE_START_YEAR,
      nextSeq: 1,
      scenario: {
        plan: { ...samplePlan, jobs: [{ ...openEndedJob, id: "job-5", ownerId: P1 }], budgetLines: [], goals: [] },
        ledger: emptyLedger,
      },
    };

    const { result } = Projection.transact(seeded, nullJurisdiction, (p) => p.addJob(P1, openEndedJob));
    expect(result).toBe("job-6");
  });
});

describe("Projection root — id counter round-trips through serialization", () => {
  it("a reloaded plan continues the sequence without collision", () => {
    const p = freshProjection();
    p.addJob(P1, openEndedJob); // job-1
    p.addBudgetLine(expenseLine); // line-2 → nextSeq now 3

    const snapshot = JSON.parse(JSON.stringify(p.toJSON()));
    const reloaded = Projection.fromState(snapshot, nullJurisdiction);

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

  it("normalizes counters a serialized state got wrong", () => {
    // The least trustworthy input the API takes: a state that has been through JSON, and may
    // have been hand-edited or written by a build whose counters meant something else. Both
    // counters here are stale — `nextSeq` 1 against a `job-5`, and `nextSequenceNumber` 1
    // against an event already at 8.
    const stale: ProjectionState = {
      startYear: SAMPLE_START_YEAR,
      nextSeq: 1,
      scenario: {
        plan: {
          ...samplePlan,
          goals: [],
          budgetLines: [],
          jobs: [
            {
              id: "job-5",
              ownerId: P1,
              startYear: SAMPLE_START_YEAR,
              endYear: null,
              salary: { startingSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
            },
          ],
        },
        ledger: {
          events: [
            {
              id: "imported-loan",
              type: "LoanEvent",
              month: 6,
              sequenceNumber: 8,
              kind: "auto",
              liabilityId: "imported-loan",
              ownerId: P1,
              openingBalanceCents: dollarsToCents(20_000),
              apr: 5,
              termMonths: 60,
            },
          ],
          nextSequenceNumber: 1,
        },
      },
    };

    const p = Projection.fromState(stale, nullJurisdiction);

    // Trusting `nextSeq: 1` would have minted `job-5` a second time.
    const jobId = p.addJob(P1, openEndedJob);
    expect(jobId).not.toBe("job-5");
    const jobIds = p.plan.jobs.map((j) => j.id);
    expect(new Set(jobIds).size).toBe(jobIds.length);

    // Trusting `nextSequenceNumber: 1` would have stamped the next event 1, then 2 — and the
    // ledger already holds 8, so the log would have carried two events at one number before
    // long. The floor is taken from the whole state, so it clears the sequence AND `job-5`.
    const loanId = p.takeLoan({
      month: 12,
      ownerId: P1,
      kind: "auto",
      openingBalanceCents: dollarsToCents(5_000),
      apr: 4,
      termMonths: 24,
    });
    const added = p.ledger.events.find((e) => e.id === loanId);
    expect(added?.sequenceNumber).toBeGreaterThan(8);
    const seqs = p.ledger.events.map((e) => e.sequenceNumber);
    expect(new Set(seqs).size).toBe(seqs.length);
    const eventIds = p.ledger.events.map((e) => e.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("only ever raises a counter, never renumbers what is already authored", () => {
    const p = freshProjection();
    p.addJob(P1, openEndedJob);
    p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const before = p.toJSON();

    const reloaded = Projection.fromState(JSON.parse(JSON.stringify(before)), nullJurisdiction);

    // The id counter is already at its floor, so a reload does not skip ids.
    expect(reloaded.state.nextSeq).toBe(before.nextSeq);
    // One floor serves both counters, so the ledger's own may be RAISED to meet it — a wider
    // gap before the next event, never a lower number.
    expect(reloaded.ledger.nextSequenceNumber).toBeGreaterThanOrEqual(
      before.scenario.ledger.nextSequenceNumber,
    );
    // What matters is that nothing already in the log is renumbered: sequence numbers are
    // identity for the same-month tie-break, and a reload must not reshuffle a timeline.
    expect(reloaded.ledger.events.map((e) => e.sequenceNumber)).toEqual(
      before.scenario.ledger.events.map((e) => e.sequenceNumber),
    );
    expect(reloaded.ledger.events.map((e) => e.id)).toEqual(
      before.scenario.ledger.events.map((e) => e.id),
    );
  });

  it("settles after one normalization — reloading repeatedly does not drift", () => {
    // Idempotence is what makes a save/load cycle safe to repeat: if each pass could raise
    // the counters again, a plan reopened daily would climb without ever being edited.
    const p = freshProjection();
    p.addJob(P1, openEndedJob);
    p.marry({ month: 24, name: "Partner", birthYear: 1988 });

    const once = Projection.fromState(JSON.parse(JSON.stringify(p.toJSON())), nullJurisdiction).toJSON();
    const twice = Projection.fromState(JSON.parse(JSON.stringify(once)), nullJurisdiction).toJSON();

    expect(twice.nextSeq).toBe(once.nextSeq);
    expect(twice.scenario.ledger.nextSequenceNumber).toBe(
      once.scenario.ledger.nextSequenceNumber,
    );
  });

  it("names the round-trip fromState/toState, with toJSON kept as a JSON-protocol alias", () => {
    const p = freshProjection();
    p.addJob(P1, openEndedJob); // job-1
    p.addBudgetLine(expenseLine); // line-2

    // toJSON is the JS protocol name: JSON.stringify calls it automatically, and it returns
    // the same state as toState — one payload, two names.
    expect(p.toJSON()).toBe(p.toState());
    expect(JSON.parse(JSON.stringify(p))).toEqual(p.toState());

    // fromState is the flooring construction path: a reloaded state continues the sequence.
    const reloaded = Projection.fromState(JSON.parse(JSON.stringify(p.toState())), nullJurisdiction);
    expect(reloaded.state.nextSeq).toBe(3);
    expect(
      reloaded.addGoal({
        name: "Trip",
        targetCents: dollarsToCents(5000),
        targetDate: 12,
        disposition: "retain",
        annualReturnPct: 2,
      }),
    ).toBe("goal-3");
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

  it("surfaces the interpreted household and a report built from the same series", () => {
    const p = freshProjection();
    p.addJob(P1, openEndedJob);
    p.marry({ month: 12, name: "Partner", birthYear: 1990 });
    const result = p.run(nullJurisdiction);

    // The household the snapshot panel and owner picker read — both partners present.
    expect(result.household.memberships.map((m) => m.person.name)).toContain("Partner");

    // The report is derived from the very series the chart draws, not a second simulation:
    // every reported month lines up with the result's own series, value for value.
    expect(result.report.months.length).toBe(result.series.months.length);
    const lastReport = result.report.months.at(-1)?.netWorthNominalCents;
    const lastSeries = result.series.months.at(-1)?.netWorthNominalCents;
    expect(lastReport).toBe(lastSeries);

    // Knobs the sim input compiles away survive via meta — the whole plan and the run's rules.
    expect(result.report.meta).toEqual({ plan: p.plan, jurisdictionId: "null" });
  });
});

describe("Projection root — per-line monthly resolution in the result", () => {
  const RENT = "line:rent";
  const FUN = "line:fun";

  it("funds every budget line to its intent in a solvent month, keyed by allocations() id", () => {
    // 8k/mo take-home (nullJurisdiction = no tax) easily covers a $2,500 budget.
    const p = Projection.create(
      {
        plan: { ...samplePlan, goals: [] },
        startYear: SAMPLE_START_YEAR,
      },
      nullJurisdiction,
    );
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
    const p = Projection.create(
      {
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
      },
      nullJurisdiction,
    );
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
    const p = Projection.create(
      {
        plan: {
          ...samplePlan,
          openingBalanceCents: dollarsToCents(2_000_000),
          goals: [],
          healthMonthlyCents: 0,
          postCoverageHealthMonthlyCents: 0,
          enrollsInPublicHealthCoverage: false,
        },
        startYear: SAMPLE_START_YEAR,
      },
      nullJurisdiction,
    );
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

describe("Projection root — authoring validates against the construction-time jurisdiction", () => {
  /**
   * Taxes `capitalGains` at `rate`, returning basis pro-rata — the same monotone shape the
   * `addEvent` gross-up requires. A brokerage down-payment source therefore nets less than its
   * face balance under this jurisdiction, and exactly its balance under {@link nullJurisdiction}.
   */
  function flatCapitalGains(rate: number): Jurisdiction {
    return {
      id: "test-capital-gains",
      computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * rate),
      computeTaxByCategoryCents: (byCat) => {
        const tax = Math.round((byCat.capitalGains ?? 0) * rate);
        return tax > 0 ? { capitalGains: tax } : {};
      },
      taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) => {
        const basisFraction = balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0;
        return grossCents - Math.round(grossCents * basisFraction);
      },
    };
  }

  /**
   * A single high-growth brokerage goal, so surplus accrues into ONE liquid capital-gains
   * account whose balance outruns its basis. By month 24 it holds ~$96.8k of which a large
   * share is embedded gain — the setup that makes a mid-range down payment affordable pre-tax
   * and short once the gain is taxed.
   */
  const NEST_GOAL = {
    id: "nest",
    name: "Nest",
    targetCents: dollarsToCents(1_000_000),
    targetDate: 60,
    disposition: "retain",
    annualReturnPct: 40,
    accountType: "brokerage",
  } as const;

  function nestProjection(jurisdiction: Jurisdiction): Projection {
    return Projection.create(
      { plan: { ...samplePlan, goals: [NEST_GOAL] }, startYear: SAMPLE_START_YEAR },
      jurisdiction,
    );
  }

  // A $90k down payment against a ~$96.8k balance: the face balance covers it, the capital-gains
  // tax on liquidating the embedded gain does not.
  const buyFromNest = {
    month: 24,
    ownerId: P1,
    purchasePriceCents: dollarsToCents(300000),
    downPaymentCents: dollarsToCents(90000),
    downPaymentSourceIds: [goalFundAccountId(NEST_GOAL)],
    mortgageApr: 6,
    mortgageTermMonths: 360,
  };

  it("refuses a buyHome the validation jurisdiction's §4.5 tax gate rejects", () => {
    // Under a capital-gains jurisdiction the funded gain grosses the draw up past the balance,
    // so the gate blocks — the false-accept this change closes.
    const p = nestProjection(flatCapitalGains(0.5));
    expect(() => p.buyHome(buyFromNest)).toThrow(/tax/i);
    expect(p.ledger.events).toHaveLength(0);
  });

  it("accepts the same buyHome when constructed against nullJurisdiction", () => {
    // No tax, so the balance nets in full and the down payment clears — the path that made the
    // weaker check invisible before, now reachable only by asking for it explicitly.
    const p = nestProjection(nullJurisdiction);
    expect(() => p.buyHome(buyFromNest)).not.toThrow();
    expect(p.ledger.events).toHaveLength(1);
  });

  it("keeps run(jurisdiction) independent of the authoring jurisdiction", () => {
    // Authored under a taxing jurisdiction that would refuse the purchase, then projected
    // under another: run() takes its own jurisdiction and never consults the authoring one,
    // so one scenario still re-runs under whatever rules a caller asks for.
    const p = nestProjection(flatCapitalGains(0.5));
    p.marry({ month: 12, name: "Partner", birthYear: 1990 });
    expect(p.run(nullJurisdiction).jurisdictionId).toBe(nullJurisdiction.id);
    expect(p.run(flatCapitalGains(0.5)).jurisdictionId).toBe("test-capital-gains");
    expect(p.run(mockJurisdiction()).jurisdictionId).toBe("mock");
  });
});
