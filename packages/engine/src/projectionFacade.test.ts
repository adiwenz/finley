/**
 * The `Projection` root — the npm API surface: standing edits and ledger transactions on one
 * object, deterministic minted ids, immutable state swaps with no undo stack, and
 * `run(jurisdiction)` leaving the plan untouched. Surface/purity is covered elsewhere.
 */
import { describe, it, expect } from "vitest";
import {
  Projection,
  type ProjectionState,
  CURRENT_FORMAT_VERSION,
  UnsupportedVersionError,
} from "./index";
import { validateLedger } from "./ledger/validateLedger";
import { samplePlan, salariedJob, spendLine, stateOf, SAMPLE_START_YEAR } from "./testing/samplePlan";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";
import { dollarsToCents } from "./cashFlowSeries";
import { goalFundAccountId } from "./projectionBase";
import { withLedger } from "./scenario";
import { emptyLedger, type Ledger } from "./ledger/ledger";
import type { LifeEvent } from "./ledger/eventTypes";
import type { Job, PersonId } from "./job";
import type { BudgetLine } from "./budgetLine";
import { RETIREMENT_ID } from "./ids";

const P1 = "p1" as PersonId;

function freshProjection(): Projection {
  // Empty job and budget-line lists so minted ids and roster lengths reflect only what each
  // test adds — the sample plan seeds a spend line that would otherwise skew the counts.
  return Projection.fromState(stateOf({ ...samplePlan, jobs: [], budgetLines: [] }), nullJurisdiction);
}

const openEndedJob = {
  startYear: SAMPLE_START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
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

/**
 * A goal, for the counter tests. `GoalInput` still takes an optional `id` — jobs and budget
 * lines do not — so a goal is what an "authored id claims the counter" case is written against.
 */
const carGoalInput = {
  name: "Car",
  targetCents: dollarsToCents(30000),
  targetDate: 36,
  disposition: "retain" as const,
  annualReturnPct: 3,
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

  it("mints a job id whatever the caller passes — `JobInput` cannot name one", () => {
    // Jobs take no `id` at all: authoring one is the engine's to name, and relocating an
    // existing one is `reassignJob`, which names the id as an argument instead.
    const p = freshProjection();
    expect(p.addJob(P1, openEndedJob)).toBe("job-1");
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    expect(p.addPartnerJob(partnerId, openEndedJob)).toMatch(/^job-\d+$/);
    // Including the jobs a partner arrives with, nested inside the marriage.
    const q = freshProjection();
    q.marry({ month: 24, name: "Kim", birthYear: 1990, jobs: [openEndedJob] });
    expect(partnerEvent(q).person.jobs[0]?.id).toMatch(/^job-\d+$/);
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
    p.marry({ month: 24, name: "Partner", birthYear: 1988, jobs: [openEndedJob] });
    // The partner's job is minted like any other, off the same counter the marriage drew from.
    const nested = partnerEvent(p).person.jobs[0]?.id;
    expect(nested).toMatch(/^job-\d+$/);
    // The next mint clears it rather than colliding with it.
    expect(p.addJob(P1, openEndedJob)).not.toBe(nested);
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

  it("composes the mortgage loan first, then the property that secures against it", () => {
    // A purchase is two events now: the financing `LoanEvent` and the property naming it. The
    // mortgage id is parent-suffixed `${propertyId}-mortgage`, so a sort groups it under its home
    // (matching the `${partnerId}-job-N` convention), and the loan is emitted first so it replays
    // before the property, whose precondition requires the securing liability to exist.
    const p = freshProjection();
    const homeId = p.buyHome({
      month: 0,
      ownerId: P1,
      purchasePriceCents: dollarsToCents(100000),
      downPaymentCents: dollarsToCents(10000),
      downPaymentSourceIds: ["savings"],
      mortgageApr: 6,
      mortgageTermMonths: 360,
    });
    expect(homeId).toBe("home-1");

    const [mortgage, home] = p.state.scenario.ledger.events;
    expect(mortgage.type).toBe("LoanEvent");
    if (mortgage.type === "LoanEvent") {
      expect(mortgage.id).toBe("home-1-mortgage");
      expect(mortgage.liabilityId).toBe("home-1-mortgage");
      expect(mortgage.kind).toBe("mortgage");
      expect(mortgage.openingBalanceCents).toBe(dollarsToCents(90000)); // price − down
    }
    expect(home.type).toBe("HomePurchaseEvent");
    if (home.type === "HomePurchaseEvent") {
      expect(home.propertyId).toBe("home-1");
      expect(home.securedByLiabilityId).toBe("home-1-mortgage");
    }
  });

  it("answers the funding question from the current ledger's liquid balances", () => {
    // `funding()` reuses the handle's own base and validation jurisdiction, so a down-payment
    // picker and the §4.5 gate decide on the same numbers.
    const p = freshProjection();
    const savings = p.funding().sourcesAt(0).find((s) => s.id === "savings");
    expect(savings?.balanceCents).toBe(samplePlan.openingBalanceCents);
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
    // A cash purchase (no securing liability): only the down-payment source matters to the guard.
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
    const keep = p.addGoal(carGoal);
    p.removeGoal(p.addGoal(carGoal));
    expect(p.plan.goals.map((g) => g.id)).toEqual([...samplePlan.goals.map((g) => g.id), keep]);
  });

  it("refuses while an event spends from the goal's fund account", () => {
    const p0 = freshProjection();
    const goalId = p0.addGoal(carGoal);
    const p = withPurchaseFundedBy(p0, goalId);
    const before = p.state;

    // The message names the goal, its derived fund account and the event holding it — all by
    // the ids the engine minted, so the assertion builds them from the handle it was given.
    expect(() => p.removeGoal(goalId)).toThrow(
      new RegExp(
        `cannot remove goal — Cannot remove goal "${goalId}": its fund account ` +
          `"fund-${goalId}" funds "e1" \\(HomePurchaseEvent, month 24\\)`,
      ),
    );
    // Refused means untouched, not partially applied.
    expect(p.state).toBe(before);
    expect(p.plan.goals.map((g) => g.id)).toContain(goalId);
  });

  it("allows the removal once the referencing event leaves the ledger", () => {
    const p0 = freshProjection();
    const goalId = p0.addGoal(carGoal);
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

  it("refuses an id the plan does not hold, distinctly from refusing a funded one", () => {
    const p = freshProjection();
    // A different refusal from the funding guard above: nothing is being protected, the goal
    // simply is not there, and the caller's next line assumes a removal that never happened.
    expect(() => p.removeGoal("no-such-goal")).toThrow(/no goal "no-such-goal"/);
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
    const goalId = p.addGoal(carGoal);
    p.updateGoal(goalId, { name: "New car", annualReturnPct: 5 });
    const goal = p.plan.goals.find((g) => g.id === goalId);
    expect(goal).toMatchObject({
      id: goalId,
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
    const first = p.addGoal(carGoal);
    const second = p.addGoal(carGoal);
    const before = p.plan.goals.map((g) => g.id);
    p.updateGoal(first, { name: "Renamed" });
    expect(p.plan.goals.map((g) => g.id)).toEqual(before);
    expect(p.plan.goals.map((g) => g.id)).toEqual([
      ...samplePlan.goals.map((g) => g.id),
      first,
      second,
    ]);
  });

  it("refuses an id the plan does not hold", () => {
    const p = freshProjection();
    const before = p.state;
    expect(() => p.updateGoal("no-such-goal", { name: "x" })).toThrow(/no goal "no-such-goal"/);
    expect(p.state).toBe(before);
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
    const p = Projection.fromState(stateOf({ ...samplePlan, jobs: [], budgetLines: [], goals: [] }), nullJurisdiction);
    return { p, a: p.addGoal(goal), b: p.addGoal(goal), c: p.addGoal(goal) };
  }

  it("moves a goal one slot earlier when funded sooner", () => {
    const { p, a, b, c } = seededProjection();
    p.reorderGoal(b, "up");
    expect(p.plan.goals.map((g) => g.id)).toEqual([b, a, c]);
  });

  it("moves a goal one slot later when funded later", () => {
    const { p, a, b, c } = seededProjection();
    p.reorderGoal(b, "down");
    expect(p.plan.goals.map((g) => g.id)).toEqual([a, c, b]);
  });

  it("refuses a move that cannot happen — at either end, or for an id that is not there", () => {
    const { p, a, b, c } = seededProjection();
    const before = p.state;

    expect(() => p.reorderGoal(a, "up")).toThrow(/already first/);
    expect(() => p.reorderGoal(c, "down")).toThrow(/already last/);
    expect(() => p.reorderGoal("no-such-goal", "up")).toThrow(/no goal "no-such-goal"/);

    expect(p.state).toBe(before);
    expect(p.plan.goals.map((g) => g.id)).toEqual([a, b, c]);
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

  it("refuses an id the plan does not hold, rather than reporting a write it did not make", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    const before = p.state;

    expect(() => p.updateJob("no-such-job", { name: "x" })).toThrow(/no job "no-such-job"/);
    expect(() => p.removeJob("no-such-job")).toThrow(/no job "no-such-job"/);
    expect(() => p.setJobMonthlyIncome("no-such-job", 1)).toThrow(/no job "no-such-job"/);
    expect(() => p.setJobDeferralFraction("no-such-job", 0.5)).toThrow(/no job "no-such-job"/);

    // Same state object throughout: a refusal commits nothing.
    expect(p.state).toBe(before);
    expect(p.plan.jobs.map((j) => j.id)).toEqual([jobId]);
  });

  it("refuses a partner's job id on the plan plane, and the reverse", () => {
    // The two families do not reach across: a job is authored where its owner is, and asking
    // the wrong plane is the same caller error as asking for a job that does not exist.
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 });
    const planJob = p.addJob(P1, openEndedJob);
    const partnerJob = p.addPartnerJob(partnerId, openEndedJob);

    expect(() => p.updateJob(partnerJob, { name: "x" })).toThrow(/no job/);
    expect(() => p.updatePartnerJob(planJob, { name: "x" })).toThrow(/no partner holds a job/);
  });

  it("setJobMonthlyIncome takes monthly cents and stores the annualized salary", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    p.setJobMonthlyIncome(jobId, dollarsToCents(9000));
    expect(p.plan.jobs[0]?.salary).toEqual({
      // Both anchors: stating one salary means a flat history, so the historical
      // reconstruction and the current-salary anchor agree until a pay change parts them.
      startingSalaryCents: dollarsToCents(9000) * 12,
      currentSalaryCents: dollarsToCents(9000) * 12,
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

  it("carries every input field onto an added job, not just the ones a new job is authored from", () => {
    const p = freshProjection();
    // What a job moving between household members arrives holding: an existing job's
    // accumulated adjustments, not a blank draft's fields.
    const jobId = p.addJob(P1, {
      ...matchedJob,
      incomeOverrides: [{ month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      payChanges: [{ month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
    expect(p.plan.jobs[0]).toMatchObject({
      id: jobId,
      name: "Day job",
      deferral: matchedJob.deferral,
      incomeOverrides: [{ month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      payChanges: [{ month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
  });

  it("replaceJob rewrites wholesale, so an absent field CLEARS rather than carrying through", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, matchedJob);

    // The same form re-submitted with the name blanked and the 401(k) rate zeroed. A patch
    // could not say this: naming no `deferral` means "unchanged" to updateJob.
    p.replaceJob(jobId, openEndedJob);

    expect(p.plan.jobs[0]).toEqual({
      id: jobId,
      // Identity survives the rewrite; the owner is not a field an edit restates.
      ownerId: P1,
      startYear: openEndedJob.startYear,
      endYear: null,
      salary: openEndedJob.salary,
    });
  });

  it("keeps one job-id namespace across both planes", () => {
    // No caller can supply a job id, so a duplicate cannot be authored — but the two planes
    // must still draw from ONE counter, since a job's id keys its income band whichever plane
    // it sits on.
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const ids = [
      p.addJob(P1, openEndedJob),
      p.addPartnerJob(partnerId, openEndedJob),
      p.addJob(P1, openEndedJob),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    // Two on the plan, one on the partner's event — three distinct ids from one counter.
    expect(p.plan.jobs).toHaveLength(2);
    expect(partnerEvent(p).person.jobs).toHaveLength(1);
  });

  it("replaceJob keeps the job's list position, and refuses an unknown id", () => {
    const p = freshProjection();
    const first = p.addJob(P1, openEndedJob);
    const second = p.addJob(P1, openEndedJob);
    p.replaceJob(first, { ...openEndedJob, name: "Renamed" });
    expect(() => p.replaceJob("no-such-job", { ...openEndedJob, name: "Nowhere" })).toThrow(
      /no job "no-such-job"/,
    );
    expect(p.plan.jobs.map((j) => j.id)).toEqual([first, second]);
    expect(p.plan.jobs.map((j) => j.name)).toEqual(["Renamed", undefined]);
  });
});

describe("Projection root — jobs on a partner's plane", () => {
  const matchedJob = {
    ...openEndedJob,
    name: "Day job",
    deferral: { deferralFraction: 0.1, fundAccountId: "retirement", employerMatchFraction: 0.5 },
  } as const;

  /** A projection holding one partner, and that partner's id. */
  function withPartner(): { p: Projection; partnerId: PersonId } {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    return { p, partnerId };
  }

  const partnerJobs = (p: Projection) => partnerEvent(p).person.jobs;

  it("adds a job to a partner, minting off the SAME counter the plan plane mints from", () => {
    const { p, partnerId } = withPartner();
    const planJobId = p.addJob(P1, openEndedJob);
    const partnerJobId = p.addPartnerJob(partnerId, openEndedJob);

    // One run of ids, not a per-owner namespace: the partner's is `job-N`, and it is a
    // number the plan plane will never issue again.
    expect(partnerJobId).toMatch(/^job-\d+$/);
    expect(partnerJobId).not.toBe(planJobId);
    expect(p.addJob(P1, openEndedJob)).not.toBe(partnerJobId);

    // It landed on the partner's event, owned by them — and nowhere near the plan.
    expect(partnerJobs(p).map((j) => j.id)).toEqual([partnerJobId]);
    expect(partnerJobs(p)[0]?.ownerId).toBe(partnerId);
    expect(p.plan.jobs.map((j) => j.id)).toEqual([planJobId, expect.any(String)]);
  });

  it("carries every input field onto a partner's job", () => {
    const { p, partnerId } = withPartner();
    const jobId = p.addPartnerJob(partnerId, {
      ...matchedJob,
      incomeOverrides: [{ month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      payChanges: [{ month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
    expect(partnerJobs(p)[0]).toMatchObject({
      id: jobId,
      name: "Day job",
      deferral: matchedJob.deferral,
      incomeOverrides: [{ month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      payChanges: [{ month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
  });

  it("patches a partner's job field-wise, and replaces it wholesale", () => {
    const { p, partnerId } = withPartner();
    const jobId = p.addPartnerJob(partnerId, matchedJob);

    p.updatePartnerJob(jobId, { name: "Night job" });
    expect(partnerJobs(p)[0]).toMatchObject({
      name: "Night job",
      deferral: matchedJob.deferral, // unnamed, so carried through
    });

    // Replace states the whole job, so the fields it omits are gone.
    p.replacePartnerJob(jobId, openEndedJob);
    expect(partnerJobs(p)[0]).toEqual({
      id: jobId,
      ownerId: partnerId,
      startYear: openEndedJob.startYear,
      endYear: null,
      salary: openEndedJob.salary,
    });
  });

  it("keeps a partner's other jobs and their order across an edit", () => {
    const { p, partnerId } = withPartner();
    const first = p.addPartnerJob(partnerId, openEndedJob);
    const second = p.addPartnerJob(partnerId, openEndedJob);
    p.updatePartnerJob(first, { name: "Renamed" });
    expect(partnerJobs(p).map((j) => j.id)).toEqual([first, second]);
    expect(partnerJobs(p).map((j) => j.name)).toEqual(["Renamed", undefined]);
  });

  it("removes a partner's job, leaving the plan and their other jobs alone", () => {
    const { p, partnerId } = withPartner();
    const planJob = p.addJob(P1, openEndedJob);
    const keep = p.addPartnerJob(partnerId, openEndedJob);
    p.removePartnerJob(p.addPartnerJob(partnerId, openEndedJob));

    expect(partnerJobs(p).map((j) => j.id)).toEqual([keep]);
    expect(p.plan.jobs.map((j) => j.id)).toEqual([planJob]);
  });

  it("refuses a partner or a job it cannot find, rather than writing nothing quietly", () => {
    const { p } = withPartner();
    expect(() => p.addPartnerJob("nobody" as PersonId, openEndedJob)).toThrow(/no partner/);
    expect(() => p.updatePartnerJob("job-99", { name: "x" })).toThrow(/no partner holds a job/);
    expect(() => p.replacePartnerJob("job-99", openEndedJob)).toThrow(/no partner holds a job/);
    expect(() => p.removePartnerJob("job-99")).toThrow(/no partner holds a job/);
  });

  it("leaves the state untouched when the revision is refused", () => {
    const { p, partnerId } = withPartner();
    p.addPartnerJob(partnerId, openEndedJob);
    const before = p.state;
    expect(() => p.addPartnerJob("nobody" as PersonId, openEndedJob)).toThrow();
    // Same state object: a refused write consumes no id and commits nothing.
    expect(p.state).toBe(before);
  });
});

describe("Projection root — moving a job between the two planes", () => {
  const richJob = {
    ...openEndedJob,
    name: "Software Engineer",
    deferral: { deferralFraction: 0.1, fundAccountId: "retirement", employerMatchFraction: 0.5 },
    incomeOverrides: [{ month: 6, kind: "addBonus" as const, cents: dollarsToCents(5000) }],
    payChanges: [{ month: 12, kind: "changeBy" as const, cents: dollarsToCents(500) }],
  } as const;

  /** A job as authoring input — its id and owner are the engine's, not the caller's. */
  const inputOf = (job: Job) => {
    const { id: _id, ownerId: _owner, ...rest } = job;
    return rest;
  };

  it("moves a job from the plan to a partner, whole and with its id intact", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const jobId = p.addJob(P1, richJob);

    p.reassignJob(jobId, partnerId, inputOf(p.plan.jobs[0]!));

    expect(p.plan.jobs).toEqual([]);
    // The same job, not a new one: id, overrides, pay changes and employer match all survive.
    expect(partnerEvent(p).person.jobs).toEqual([{ ...richJob, id: jobId, ownerId: partnerId }]);
  });

  it("moves a job from a partner back to the plan, whole and with its id intact", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const jobId = p.addPartnerJob(partnerId, richJob);

    p.reassignJob(jobId, P1, inputOf(partnerEvent(p).person.jobs[0]!));

    expect(partnerEvent(p).person.jobs).toEqual([]);
    expect(p.plan.jobs).toEqual([{ ...richJob, id: jobId, ownerId: P1 }]);
  });

  it("never leaves the id live on both planes at once", () => {
    // The old remove-then-add dance could not be reordered without briefly duplicating the id,
    // which keys the income bands. One method owns both halves, so there is no ordering left
    // for a caller to get wrong.
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const jobId = p.addJob(P1, richJob);

    p.reassignJob(jobId, partnerId, inputOf(p.plan.jobs[0]!));

    const everywhere = [
      ...p.plan.jobs.map((j) => j.id),
      ...partnerEvent(p).person.jobs.map((j) => j.id),
    ];
    expect(everywhere).toEqual([jobId]);
  });

  it("applies the fields the move lands with, so re-owning and editing are one write", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const jobId = p.addJob(P1, richJob);

    p.reassignJob(jobId, partnerId, { ...inputOf(p.plan.jobs[0]!), name: "Consulting" });

    const moved = partnerEvent(p).person.jobs[0]!;
    expect(moved.id).toBe(jobId);
    expect(moved.name).toBe("Consulting");
    expect(moved.incomeOverrides).toEqual(richJob.incomeOverrides);
  });

  it("refuses an unknown job, and an owner who is not in the household", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const jobId = p.addJob(P1, richJob);

    expect(() => p.reassignJob("no-such-job", partnerId, richJob)).toThrow(/no-such-job/);
    // Refused BEFORE the source gives the job up, so a bad owner cannot strip a held job.
    expect(() => p.reassignJob(jobId, "ghost" as PersonId, richJob)).toThrow();
    expect(p.plan.jobs.map((j) => j.id)).toEqual([jobId]);
  });
});

describe("Projection root — one counter across both planes, across a round trip", () => {
  it("never reissues a partner job's id after a state round trip", () => {
    const authored = freshProjection();
    const partnerId = authored.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const partnerJobId = authored.addPartnerJob(partnerId, openEndedJob);
    const planJobId = authored.addJob(P1, openEndedJob);

    // Out through the serialization boundary and back — a fresh handle, no memory of what
    // the first one issued beyond what the state itself carries.
    const reloaded = Projection.fromState(
      JSON.parse(JSON.stringify(authored.toState())) as ProjectionState,
      nullJurisdiction,
    );

    const held = new Set([partnerId, partnerJobId, planJobId]);
    const minted = [
      reloaded.addPartnerJob(partnerId, openEndedJob),
      reloaded.addJob(P1, openEndedJob),
      reloaded.marry({ month: 36, name: "Kim", birthYear: 1990 }),
    ];
    for (const id of minted) expect(held.has(id)).toBe(false);
    expect(new Set(minted).size).toBe(minted.length);
  });

  it("steps past a partner job an imported scenario already holds", () => {
    // The hazard the old per-owner scheme left open: an id shape the counter's floor does not
    // recognize is an id the next mint can hand out a second time. `job-9` is recognized.
    //
    // The id arrives by IMPORT, which is now the only way one can: no authoring path lets a
    // caller name a job, so `fromState` is exactly what the floor exists for.
    const seeded = freshProjection();
    const partnerId = seeded.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const state = seeded.toState();
    const imported: ProjectionState = {
      ...state,
      scenario: withLedger(state.scenario, {
        ...state.scenario.ledger,
        events: state.scenario.ledger.events.map((e) =>
          e.type === "RelationshipEvent"
            ? {
                ...e,
                person: {
                  ...e.person,
                  jobs: [{ ...openEndedJob, id: "job-9", ownerId: partnerId }],
                },
              }
            : e,
        ),
      }),
    };

    const reloaded = Projection.fromState(imported, nullJurisdiction);
    expect(reloaded.addPartnerJob(partnerId, openEndedJob)).toBe("job-10");
    expect(reloaded.addJob(P1, openEndedJob)).toBe("job-11");
  });

  it("keeps the counter monotonic while writes alternate between the planes", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988 }) as PersonId;
    const minted: string[] = [];
    for (let i = 0; i < 4; i++) {
      minted.push(p.addJob(P1, openEndedJob));
      minted.push(p.addPartnerJob(partnerId, openEndedJob));
    }
    // Strictly increasing across the alternation — neither plane restarts or rewinds.
    const numbers = minted.map((id) => Number(id.replace("job-", "")));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
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

  it("refuses an id the plan does not hold", () => {
    const p = freshProjection();
    p.addBudgetLine(expenseLine);
    const before = p.state;

    const missing = /no budget line "no-such-line"/;
    expect(() => p.updateBudgetLine("no-such-line", { label: "x" })).toThrow(missing);
    expect(() => p.removeBudgetLine("no-such-line")).toThrow(missing);
    expect(() =>
      p.addBudgetLineOverride("no-such-line", {
        month: 3,
        monthlyCents: dollarsToCents(100),
        scope: "thisMonthOnly",
      }),
    ).toThrow(missing);

    expect(p.state).toBe(before);
  });

  it("accumulates dated overrides, one per (scope, month), without a read-modify-write", () => {
    const p = freshProjection();
    const lineId = p.addBudgetLine(expenseLine);

    p.addBudgetLineOverride(lineId, {
      month: 6,
      monthlyCents: dollarsToCents(2500),
      scope: "thisMonthOnly",
    });
    // A different month, and the same month at the other scope: both stand beside the first.
    p.addBudgetLineOverride(lineId, {
      month: 12,
      monthlyCents: dollarsToCents(2600),
      scope: "thisMonthOnly",
    });
    p.addBudgetLineOverride(lineId, {
      month: 6,
      monthlyCents: dollarsToCents(2700),
      scope: "fromHereForward",
    });
    // Re-authoring one replaces it rather than stacking a second answer for that month.
    p.addBudgetLineOverride(lineId, {
      month: 6,
      monthlyCents: dollarsToCents(2550),
      scope: "thisMonthOnly",
    });

    expect(p.plan.budgetLines[0]?.overrides).toEqual([
      { month: 12, monthlyCents: dollarsToCents(2600), scope: "thisMonthOnly" },
      { month: 6, monthlyCents: dollarsToCents(2700), scope: "fromHereForward" },
      { month: 6, monthlyCents: dollarsToCents(2550), scope: "thisMonthOnly" },
    ]);
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

  it("revises a transaction's data in place, keeping its id and its place in the log", () => {
    const { p, partnerId } = marriedProjection();
    const [before] = p.ledger.events;

    p.reviseTransaction(partnerId, { type: "marry", month: 36, name: "Partner (renamed)" });

    const [after] = p.ledger.events;
    expect(after).toMatchObject({ id: partnerId, month: 36 });
    expect(after?.type === "RelationshipEvent" && after.person.name).toBe("Partner (renamed)");
    expect(after?.sequenceNumber).toBe(before?.sequenceNumber);
    expect(p.ledger.events).toHaveLength(1);
  });

  it("refuses a revision that would strand a later transaction", () => {
    const { p, partnerId } = marriedProjection();
    p.separate({ month: 36, partnerPersonId: partnerId });
    const before = p.state;

    // Moving the marriage past the separation leaves the separation with nothing to end.
    expect(() => p.reviseTransaction(partnerId, { type: "marry", month: 48 })).toThrow(
      /cannot revise transaction — /,
    );
    expect(p.state).toBe(before);
  });

  it("refuses a revision naming the wrong verb for the event", () => {
    const { p, partnerId } = marriedProjection();
    expect(() => p.reviseTransaction(partnerId, { type: "takeLoan", apr: 9 })).toThrow(
      /is a RelationshipEvent, which a "takeLoan" revision does not address/,
    );
  });

  it("refuses a revision for an id the ledger does not hold", () => {
    const p = freshProjection();
    expect(() => p.reviseTransaction("no-such-event", { type: "marry", month: 1 })).toThrow(
      /no transaction "no-such-event"/,
    );
  });

  it("refuses the companion field belonging to the other loan arm", () => {
    const p = freshProjection();
    const loanId = p.takeLoan({
      month: 3, ownerId: P1, kind: "auto",
      openingBalanceCents: dollarsToCents(10_000), apr: 4, termMonths: 48,
    });
    // `kind` is fixed by the event, so a term loan has no credit limit to revise.
    expect(() => p.reviseTransaction(loanId, { type: "takeLoan", creditLimitCents: 1 })).toThrow(
      /takes termMonths, not the other/,
    );
  });
});

/**
 * A revision changes DATA. It cannot re-point identity, because it never carries any: the
 * event is rebuilt from what is already in the log, so the event id and every durable id
 * hanging off it survive by construction rather than by the caller being careful.
 */
describe("Projection root — a revision cannot replace an identity", () => {
  const marriedProjection = (): { p: Projection; partnerId: string } => {
    const p = freshProjection();
    return { p, partnerId: p.marry({ month: 24, name: "Partner", birthYear: 1988 }) };
  };

  it("keeps the event id, the person id and every nested job id across a marry revision", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const jobId = p.addPartnerJob(partnerId, openEndedJob);
    const before = partnerEvent(p);

    p.reviseTransaction(partnerId, {
      type: "marry",
      month: 30,
      name: "Renamed",
      birthYear: 1990,
      retirementTargetAge: 62,
      benefitClaimingAge: 70,
    });

    const after = partnerEvent(p);
    // The data moved…
    expect(after.month).toBe(30);
    expect(after.person.name).toBe("Renamed");
    expect(after.person.birthYear).toBe(1990);
    expect(after.person.retirementTargetAge).toBe(62);
    // …and every identity stayed, including the job list a revision never mentions.
    expect(after.id).toBe(before.id);
    expect(after.person.id).toBe(partnerId);
    expect(after.person.jobs.map((j) => j.id)).toEqual([jobId]);
    expect(after.person.jobs).toEqual(before.person.jobs);
  });

  it("keeps the child id across a haveChild revision", () => {
    const p = freshProjection();
    const childId = p.haveChild({ month: 12, name: "Robin", annualCostCents: dollarsToCents(12_000) });

    p.reviseTransaction(childId, { type: "haveChild", name: "Robin (renamed)", annualCostCents: 1 });

    const event = p.ledger.events.find((e) => e.id === childId);
    expect(event?.type === "ChildEvent" && event.childName).toBe("Robin (renamed)");
    // `childId` is the same id as the event's own — a revision re-points neither.
    expect(event?.type === "ChildEvent" && event.childId).toBe(childId);
  });

  it("keeps the liability and owner ids across a takeLoan revision", () => {
    const p = freshProjection();
    const loanId = p.takeLoan({
      month: 3, ownerId: P1, kind: "auto",
      openingBalanceCents: dollarsToCents(10_000), apr: 4, termMonths: 48,
    });

    p.reviseTransaction(loanId, { type: "takeLoan", apr: 9, openingBalanceCents: 1, termMonths: 12 });

    const event = p.ledger.events.find((e) => e.id === loanId);
    expect(event?.type === "LoanEvent" && event.apr).toBe(9);
    expect(event?.type === "LoanEvent" && event.liabilityId).toBe(loanId);
    expect(event?.type === "LoanEvent" && event.ownerId).toBe(P1);
    // `kind` is identity-adjacent: a card and a term loan are different instruments.
    expect(event?.type === "LoanEvent" && event.kind).toBe("auto");
  });

  it("keeps the property and its securing-mortgage link across a buyHome revision", () => {
    const p = Projection.fromState(stateOf({ ...samplePlan, goals: [] }), nullJurisdiction);
    const homeId = p.buyHome({
      month: 12, ownerId: P1,
      purchasePriceCents: dollarsToCents(200_000),
      downPaymentCents: dollarsToCents(40_000),
      downPaymentSourceIds: ["savings"],
      mortgageApr: 6, mortgageTermMonths: 360,
    });
    const before = p.ledger.events.find((e) => e.id === homeId);
    const mortgageId = before?.type === "HomePurchaseEvent" ? before.securedByLiabilityId : "";
    expect(mortgageId).toBe(`${homeId}-mortgage`);

    // The property's own fields revise through `buyHome`; the mortgage is a separate `LoanEvent`,
    // revised through `takeLoan` on the derived id. Neither re-mints the other's identity.
    p.reviseTransaction(homeId, { type: "buyHome", downPaymentCents: dollarsToCents(50_000) });
    p.reviseTransaction(`${homeId}-mortgage`, { type: "takeLoan", apr: 5, termMonths: 240 });

    const after = p.ledger.events.find((e) => e.id === homeId);
    expect(after?.type === "HomePurchaseEvent" && after.downPaymentCents).toBe(dollarsToCents(50_000));
    expect(after?.type === "HomePurchaseEvent" && after.propertyId).toBe(homeId);
    expect(after?.type === "HomePurchaseEvent" && after.securedByLiabilityId).toBe(mortgageId);

    const mortgage = p.ledger.events.find((e) => e.id === `${homeId}-mortgage`);
    expect(mortgage?.type === "LoanEvent" && mortgage.apr).toBe(5);
    expect(mortgage?.type === "LoanEvent" && mortgage.kind === "mortgage" && mortgage.termMonths).toBe(240);
  });

  it("offers no way to name an identity, at the type level", () => {
    const { p, partnerId } = marriedProjection();

    // Each of these is the shape the old `NewLifeEvent` parameter accepted. If a revision
    // variant ever grows an identity field again, the `@ts-expect-error` goes unused and the
    // build fails — which is the point.
    // @ts-expect-error — a revision cannot name the event id
    p.reviseTransaction(partnerId, { type: "marry", id: "stolen" });
    // @ts-expect-error — a revision cannot replace the person
    p.reviseTransaction(partnerId, { type: "marry", person: { id: "stolen" } });
    // @ts-expect-error — a revision cannot replace the nested job list
    p.reviseTransaction(partnerId, { type: "marry", jobs: [] });

    // Untouched by any of the refused shapes above.
    expect(partnerEvent(p).person.id).toBe(partnerId);
  });
});

/**
 * Adopting a ledger that already holds ids is RESTORATION, and `fromState` is the only door
 * for it — `resetLedger` (which swapped a caller's ledger straight in) is gone. These pin that
 * the counters still clear whatever the adopted timeline occupies.
 */
describe("Projection root — restoring a timeline that already holds ids", () => {
  it("advances both counters past what the restored ledger already occupies", () => {
    // A counter sitting exactly where the state already is: `nextSeq` 1 beside an imported
    // `child-1` at sequenceNumber 1. Unfloored, the next haveChild() would mint `child-1` a
    // second time and the next append would reuse sequence number 1.
    const restored: Ledger = {
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
    const p = Projection.fromState(
      stateOf({ ...samplePlan, jobs: [], budgetLines: [] }, restored),
      nullJurisdiction,
    );

    const newChildId = p.haveChild({ month: 36, name: "Sam", annualCostCents: dollarsToCents(9_000) });

    // A distinct id, and a place in the log after the event it was restored alongside.
    expect(newChildId).not.toBe("child-1");
    const ids = p.ledger.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const restored0 = p.ledger.events.find((e) => e.id === "child-1");
    const added = p.ledger.events.find((e) => e.id === newChildId);
    expect(added?.sequenceNumber).toBeGreaterThan(restored0?.sequenceNumber ?? 0);

    // Both events remain individually addressable: a revision lands on the restored one and
    // leaves the new one alone, and a removal takes only the event it names.
    p.reviseTransaction("child-1", {
      type: "haveChild",
      name: "Robin (renamed)",
      annualCostCents: dollarsToCents(15_000),
    });
    expect(p.ledger.events.find((e) => e.id === "child-1")).toMatchObject({
      childName: "Robin (renamed)",
      // A revision keeps its place in the log.
      sequenceNumber: restored0?.sequenceNumber,
    });
    expect(p.ledger.events.find((e) => e.id === newChildId)).toMatchObject({ childName: "Sam" });

    p.removeTransaction("child-1");
    expect(p.ledger.events.map((e) => e.id)).toEqual([newChildId]);
  });

  it("clears a sequence number a restored ledger would otherwise hand out twice", () => {
    // A ledger whose own `nextSequenceNumber` violates the Ledger invariant — it is not above
    // every event's `sequenceNumber`. This is the malformed-persisted-state case: unfloored,
    // `addEvent` would stamp 3, then 4, and the 4 would collide with the restored event.
    const p = Projection.fromState(
      stateOf({ ...samplePlan, jobs: [], budgetLines: [] }, {
        events: [
          {
            id: "restored-loan",
            type: "LoanEvent",
            month: 6,
            sequenceNumber: 4,
            kind: "auto",
            liabilityId: "restored-loan",
            ownerId: P1,
            openingBalanceCents: dollarsToCents(20_000),
            apr: 5,
            termMonths: 60,
          },
        ],
        nextSequenceNumber: 3,
      }),
      nullJurisdiction,
    );

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

  it("reads named id fields, not every string it can reach", () => {
    // `childName` is a person's words. A scan over every string in the ledger would read
    // "goal-50000" as a counter reading and advance the mint by fifty thousand on the
    // strength of a name.
    const p = Projection.fromState(
      stateOf({ ...samplePlan, jobs: [], budgetLines: [], goals: [] }, {
        events: [
          {
            id: "restored-child",
            type: "ChildEvent",
            month: 12,
            sequenceNumber: 0,
            childId: "restored-child",
            childName: "room-50000",
            birthMonth: 12,
            annualCostCents: 0,
          },
          {
            id: "restored-child-2",
            type: "ChildEvent",
            month: 18,
            sequenceNumber: 1,
            childId: "restored-child-2",
            // Mint-SHAPED and a real minted kind — still a name, still ignored.
            childName: "goal-50000",
            birthMonth: 18,
            annualCostCents: 0,
          },
        ],
        nextSequenceNumber: 2,
      }),
      nullJurisdiction,
    );

    // Only the two sequence numbers moved the floor, so the next goal is goal-2, not goal-50001.
    expect(p.addGoal(carGoalInput)).toBe("goal-2");
  });
});

describe("Projection root — fromState restores a plan and its timeline together", () => {
  it("carries the timeline and floors both counters past the ids it already holds", () => {
    // State that arrives already built: a plan holding `job-4`, a ledger whose event holds
    // `loan-2` at sequence number 2, and — the reason normalization is not optional — a
    // `nextSeq` and a `nextSequenceNumber` that both understate what the state contains. This
    // is the shape a hand-edited or stale serialization takes, and `fromState` is the only
    // door it can come through.
    const state: ProjectionState = {
      scenario: {
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
      },
      startYear: SAMPLE_START_YEAR,
      nextSeq: 1,
      version: CURRENT_FORMAT_VERSION,
    };

    const p = Projection.fromState(state, nullJurisdiction);

    // The restored event survived the construction — unlike `fromInput`, which authors from a
    // document and always starts from an empty ledger.
    expect(p.ledger.events.map((e) => e.id)).toEqual(["loan-2"]);
    // The id floor cleared `job-4`, so the next mint is `job-5` — not `job-1`, which the
    // state's own `nextSeq` would have handed out on top of a live id.
    expect(p.addJob(P1, openEndedJob)).toBe("job-5");
    // One shared counter: the sequence side was lifted to that same floor, so the next append
    // lands at or above 5 — well clear of the restored event still sitting at 2.
    const eventId = p.takeLoan({ month: 12, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(1000), apr: 4, termMonths: 24 });
    const appended = p.ledger.events.find((e) => e.id === eventId);
    expect(appended?.sequenceNumber).toBeGreaterThanOrEqual(5);
  });

  it("keeps every id and event across a round trip, and never lowers a counter", () => {
    const authored = freshProjection();
    authored.addJob(P1, openEndedJob);
    authored.takeLoan({
      month: 6,
      ownerId: P1,
      kind: "auto",
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 60,
    });
    const before = authored.toState();
    const after = Projection.fromState(before, nullJurisdiction).toState();

    // What the round trip must preserve: the plan, and every event with its id and its place
    // in the sequence.
    expect(after.scenario.plan).toEqual(before.scenario.plan);
    expect(after.scenario.ledger.events).toEqual(before.scenario.ledger.events);
    // Counters only ever rise. `nextSequenceNumber` DOES rise here, and legitimately: the two
    // counters share one floor (see `seqFloor`), but `commit` maintains only `nextSeq` as a
    // write lands, so restoring is where the sequence side catches up. Raising it is always
    // safe — the invariant is "strictly above every event" — and it never reissues a number.
    expect(after.nextSeq).toBeGreaterThanOrEqual(before.nextSeq);
    expect(after.scenario.ledger.nextSequenceNumber).toBeGreaterThanOrEqual(
      before.scenario.ledger.nextSequenceNumber,
    );
  });

  it("is idempotent from the second trip on, so restoring cannot walk a counter upward", () => {
    // The catch-up above happens once. If it repeated, every reload would inflate the counters
    // a little further — so this is the property that makes the raise safe rather than a drift.
    const authored = freshProjection();
    authored.addJob(P1, openEndedJob);
    authored.takeLoan({
      month: 6,
      ownerId: P1,
      kind: "auto",
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 60,
    });

    const once = Projection.fromState(authored.toState(), nullJurisdiction).toState();
    const twice = Projection.fromState(once, nullJurisdiction).toState();
    expect(twice).toEqual(once);
  });
});

describe("Projection root — importing a pre-built ledger rejects one that will not replay", () => {
  // A lone separation with no marriage to end: replay fails its precondition on the first
  // event, so every import path must refuse it and name it rather than install a broken
  // timeline. The offender's type and id surface in the thrown message.
  const unreplayable: Ledger = {
    events: [
      {
        id: "sep-1",
        type: "SeparationEvent",
        month: 24,
        sequenceNumber: 1,
        partnerPersonId: "nobody",
        alimonyMonthlyCents: dollarsToCents(0),
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: dollarsToCents(0),
      },
    ],
    nextSequenceNumber: 2,
  };

  // A ledger holding an event no handler answers to — a hand-edited plan, or one written by a
  // build that knows an event this one doesn't.
  const unknownType: Ledger = {
    events: [
      { id: "bogus-1", type: "Frobnicate", month: 12, sequenceNumber: 1 } as unknown as LifeEvent,
    ],
    nextSequenceNumber: 2,
  };

  it("fromState rejects an un-replayable ledger, naming the offending event", () => {
    const base = freshProjection().toState();
    const state: ProjectionState = {
      ...base,
      scenario: withLedger(base.scenario, unreplayable),
    };
    expect(() => Projection.fromState(state, nullJurisdiction)).toThrow(
      /cannot load — event "sep-1" \(SeparationEvent\) fails —/,
    );
  });

  it("refuses before any handle escapes, so nothing partial is observable", () => {
    // `fromState` is now the ONLY import path — `fromScenario` and `resetLedger` are gone — so
    // the gate has one door to cover rather than three. It throws during construction, which is
    // stronger than the old "a refused reset commits nothing": there is no handle to inspect.
    const base = freshProjection().toState();
    const state: ProjectionState = { ...base, scenario: withLedger(base.scenario, unreplayable) };
    let escaped: Projection | undefined;
    expect(() => {
      escaped = Projection.fromState(state, nullJurisdiction);
    }).toThrow(/cannot load — event "sep-1" \(SeparationEvent\) fails —/);
    expect(escaped).toBeUndefined();
  });

  it("names the offending event even when the reason itself carries no id", () => {
    // Regression: the message used to be `cannot load — ${reason}`, which read correctly only
    // because every `checkEvent` reason happens to open with the event's own type and id. The
    // unknown-type rejection is a reason that names nothing ("unknown event type"), so a message
    // borrowing its detail from the reason would lose the only pointer to the bad row.
    const base = freshProjection().toState();
    const state: ProjectionState = {
      ...base,
      scenario: withLedger(base.scenario, unknownType),
    };

    // The reason the fold returns genuinely omits the id — otherwise this proves nothing.
    const validation = validateLedger(unknownType, {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: [],
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.reason).not.toContain("bogus-1");

    // Yet the thrown message carries both the id and the type.
    let thrown: unknown;
    try {
      Projection.fromState(state, nullJurisdiction);
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('"bogus-1"');
    expect(message).toContain("Frobnicate");
    expect(message).toBe(
      'Projection: cannot load — event "bogus-1" (Frobnicate) fails — unknown event type',
    );
  });

  it("rejects an unknown event type as a load error, not a raw TypeError", () => {
    // The handler lookup returns `undefined` for an unregistered discriminant; calling `.check`
    // on it threw a TypeError that named neither the event nor the plan.
    const base = freshProjection().toState();
    const state: ProjectionState = {
      ...base,
      scenario: withLedger(base.scenario, unknownType),
    };
    expect(() => Projection.fromState(state, nullJurisdiction)).not.toThrow(TypeError);
    expect(() => Projection.fromState(state, nullJurisdiction)).toThrow(
      /cannot load — event "bogus-1" \(Frobnicate\) fails — unknown event type/,
    );

    // `fromState` is the only import path left, so covering it covers every way an unknown
    // type can arrive.
  });
});

describe("Projection root — the serialized format declares its version", () => {
  // A lone separation with no marriage to end — un-replayable, reused to prove the version gate
  // fires before replay even reaches it.
  const unreplayable: Ledger = {
    events: [
      {
        id: "sep-1",
        type: "SeparationEvent",
        month: 24,
        sequenceNumber: 1,
        partnerPersonId: "nobody",
        alimonyMonthlyCents: dollarsToCents(0),
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: dollarsToCents(0),
      },
    ],
    nextSequenceNumber: 2,
  };

  it("stamps the current version on the serialized state", () => {
    expect(freshProjection().toState().version).toBe(CURRENT_FORMAT_VERSION);
  });

  it("round-trips a current-version plan unchanged", () => {
    const authored = freshProjection().toState();
    const reloaded = Projection.fromState(
      JSON.parse(JSON.stringify(authored)) as ProjectionState,
      nullJurisdiction,
    );
    expect(reloaded.toState().version).toBe(CURRENT_FORMAT_VERSION);
  });

  it("rejects a non-current version with UnsupportedVersionError carrying file version and supported version", () => {
    const state: ProjectionState = {
      ...freshProjection().toState(),
      version: CURRENT_FORMAT_VERSION + 1,
    };
    let thrown: unknown;
    try {
      Projection.fromState(state, nullJurisdiction);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedVersionError);
    const error = thrown as UnsupportedVersionError;
    expect(error.fileVersion).toBe(CURRENT_FORMAT_VERSION + 1);
    expect(error.supported).toBe(CURRENT_FORMAT_VERSION);
  });

  it("rejects an OLDER version too — there is nothing to migrate it with", () => {
    // The gate is exact equality, not a range: this build has no transforms, so a v0 file is no
    // more loadable than a v2 one. When real migrations land, an older version stops throwing
    // here because it gets migrated up — not because the accepted range quietly widened.
    const state: ProjectionState = {
      ...freshProjection().toState(),
      version: CURRENT_FORMAT_VERSION - 1,
    };
    let thrown: unknown;
    try {
      Projection.fromState(state, nullJurisdiction);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedVersionError);
    expect((thrown as UnsupportedVersionError).fileVersion).toBe(CURRENT_FORMAT_VERSION - 1);
  });

  it("rejects an unversioned plan as an unsupported version", () => {
    const { version: _drop, ...unversioned } = freshProjection().toState();
    expect(() =>
      Projection.fromState(unversioned as ProjectionState, nullJurisdiction),
    ).toThrow(UnsupportedVersionError);
  });

  it("reports a version mismatch before replay — a foreign shape is never replayed", () => {
    // Both wrong: an unsupported version AND an un-replayable ledger. The version bucket wins,
    // because replaying a shape this build cannot read is meaningless.
    const base = freshProjection().toState();
    const state: ProjectionState = {
      ...base,
      version: CURRENT_FORMAT_VERSION + 1,
      scenario: withLedger(base.scenario, unreplayable),
    };
    expect(() => Projection.fromState(state, nullJurisdiction)).toThrow(UnsupportedVersionError);
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
    salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
  });

  it("mints past a job the supplied plan already holds", () => {
    // The app's own PLAN_DEFAULTS ships a `job-1`; before the fix a counter starting at 1
    // minted a second one and the plan carried two jobs under one id.
    const p = Projection.fromState(stateOf(planWith({ jobs: [jobAt("job-1")] })), nullJurisdiction);

    const added = p.addJob(P1, openEndedJob);
    expect(added).not.toBe("job-1");
    expect(added).toBe("job-2");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes the floor from every plan collection, not just the one it is minting into", () => {
    const p = Projection.fromState(stateOf(planWith({
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
        })), nullJurisdiction);

    // One counter across all kinds, so the highest id in ANY collection sets the floor.
    expect(p.addJob(P1, openEndedJob)).toBe("job-8");
    expect(p.addBudgetLine(expenseLine)).toBe("line-9");
  });

  it("counts ids nested inside a restored partner's own jobs", () => {
    const p = Projection.fromState(
      stateOf(planWith({}), {
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
      }),
      nullJurisdiction,
    );

    expect(p.addJob(P1, openEndedJob)).toBe("job-10");
  });

  it("ignores an id-shaped suffix past MAX_SAFE_INTEGER, and still mints uniquely", () => {
    // Past 2^53 `Number` rounds, so honouring the suffix would set a floor the counter can
    // never pass — and incrementing a non-safe integer is a no-op, so the mint would hand out
    // the SAME id forever. Ignoring it is both safe and correct: `mint` cannot have issued a
    // number it cannot count to.
    const p = Projection.fromState(stateOf(planWith({ jobs: [jobAt("job-9007199254740993")] })), nullJurisdiction);

    const first = p.addJob(P1, openEndedJob);
    const second = p.addJob(P1, openEndedJob);
    expect(first).toBe("job-1");
    expect(second).toBe("job-2");
    expect(first).not.toBe(second);
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Same guard on the ledger side, where the id sits in a real id field of a restored event.
    const q = Projection.fromState(
      stateOf(planWith({}), {
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
      }),
      nullJurisdiction,
    );

    const a = q.takeLoan({ month: 12, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(1_000), apr: 4, termMonths: 24 });
    const b = q.takeLoan({ month: 18, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(1_000), apr: 4, termMonths: 24 });
    expect(a).not.toBe(b);
    const eventIds = q.ledger.events.map((e) => e.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("never walks the counter backwards, however little the restored state admits to", () => {
    const p = Projection.fromState(stateOf(planWith({ jobs: [jobAt("job-6")] })), nullJurisdiction);
    expect(p.addJob(P1, openEndedJob)).toBe("job-7");

    // Restoring a state that UNDERSTATES its counter must not release ids already spent —
    // neither the plan's `job-6` nor the `job-7` just minted. `stateOf` seeds `nextSeq: 1`,
    // so this is that case exactly: the floor is read off what the state holds, not trusted.
    const reloaded = Projection.fromState(stateOf(p.plan), nullJurisdiction);
    expect(reloaded.addJob(P1, openEndedJob)).toBe("job-8");
  });

  it("still addresses the right entity after the counter has been advanced", () => {
    const p = Projection.fromState(stateOf(planWith({ jobs: [jobAt("job-1")] })), nullJurisdiction);
    const added = p.addJob(P1, openEndedJob);

    p.updateJob(added, { name: "Second job" });
    expect(p.plan.jobs.find((j) => j.id === "job-1")).not.toHaveProperty("name");
    expect(p.plan.jobs.find((j) => j.id === added)).toMatchObject({ name: "Second job" });

    p.removeJob(added);
    expect(p.plan.jobs.map((j) => j.id)).toEqual(["job-1"]);
  });
});

/**
 * No authoring input carries an `id`, so the counter is the only thing that issues one. What
 * still needs flooring is an id that arrives WITHOUT passing through the mint: a revision that
 * introduces a whole event, or an imported state (covered in the round-trip suite above).
 */
describe("Projection root — the counter floors ids it did not mint", () => {
  it("mints from one counter across every kind, so two things never share a number", () => {
    const p = freshProjection();
    const ids = [
      p.addGoal(carGoalInput),
      p.addJob(P1, openEndedJob),
      p.addBudgetLine(expenseLine),
      p.takeLoan({
        month: 6,
        ownerId: P1,
        kind: "auto",
        openingBalanceCents: dollarsToCents(20000),
        apr: 5,
        termMonths: 60,
      }),
    ];
    // Distinct, and each says what it names — one counter, so the numbers never repeat.
    expect(ids).toEqual(["goal-1", "job-2", "line-3", "loan-4"]);
  });

  /** A handle over a plan that already holds a job named elsewhere — the import case. */
  const importedHolding = (jobId: string) =>
    Projection.fromState(stateOf({
          ...samplePlan,
          goals: [],
          budgetLines: [],
          jobs: [{ ...openEndedJob, id: jobId, ownerId: P1 }],
        }), nullJurisdiction);

  it("leaves the counter alone for an imported id it could not have minted", () => {
    const p = importedHolding("external-payroll-job");
    // Not a shape `mint` produces, so no id it goes on to issue can collide with it and
    // nothing is spent stepping over it.
    expect(p.addJob(P1, openEndedJob)).toBe("job-1");
  });

  it("ignores an imported suffix past MAX_SAFE_INTEGER, and still mints uniquely", () => {
    const p = importedHolding("job-9007199254740993");

    const a = p.addJob(P1, openEndedJob);
    const b = p.addJob(P1, openEndedJob);
    // Honouring the suffix would have set a floor the counter cannot pass — and incrementing
    // a non-safe integer is a no-op, so every later mint would return the SAME id.
    expect(a).toBe("job-1");
    expect(b).toBe("job-2");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("steps over an imported id of minted shape rather than reissuing it", () => {
    const p = importedHolding("job-2");
    // `job-2` is one of ours, so the counter must clear it — minting 1 then 2 would hand out
    // an id the plan already holds.
    const second = p.addJob(P1, openEndedJob);
    expect(second).toBe("job-3");
    const ids = p.plan.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has nothing to floor after a revision, because a revision introduces no id", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 }) as PersonId;
    // The shared counter floors both ids and sequence numbers, so the marriage's own event
    // (which takes the first sequence number) steps the counter one past it — the first
    // authored job is `job-2`, a harmless gap, the same as any other construction path.
    expect(p.addJob(P1, openEndedJob)).toBe("job-2");
    const spent = p.toState().nextSeq;

    // A revision names data, never an entity, so it cannot smuggle an id into the ledger the
    // way a caller-built event once could. The counter has nothing to step over.
    p.reviseTransaction(partnerId, { type: "marry", month: 30, name: "Renamed" });

    expect(p.toState().nextSeq).toBe(spent);
    expect(p.addJob(P1, openEndedJob)).toBe("job-3");
  });

  it("a refused transaction consumes no id", () => {
    const p = freshProjection();
    const before = p.state;

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

    // The refusal never reached the commit, so it claimed nothing.
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
      version: CURRENT_FORMAT_VERSION,
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
      version: CURRENT_FORMAT_VERSION,
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
              salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
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
  /**
   * `allocations()` keys each line `line:<id>`, and the engine mints that id — so a test adds
   * the line, keeps what `addBudgetLine` returned, and builds the key from it.
   */
  const keyOf = (id: string) => `line:${id}`;

  it("funds every budget line to its intent in a solvent month, keyed by allocations() id", () => {
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
    // Keyed by the allocations() id (`line:<id>`).
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
    return Projection.fromState(stateOf({ ...samplePlan, goals: [NEST_GOAL] }), jurisdiction);
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
    // Two events: the financing mortgage and the property that secures against it.
    expect(p.ledger.events).toHaveLength(2);
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

// ── Reads ────────────────────────────────────────────────────────────────────
//
// The facade answers questions about a household as well as authoring one. Two homes, split
// by what each needs: a question about the plan as authored is a `Projection` method, while
// one that needs the simulated future rides the `ProjectionResult` a `run` produced — asked
// off the pass already in hand rather than provoking another.

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
    const homeId = p.buyHome({
      month: 12,
      ownerId: P1,
      purchasePriceCents: dollarsToCents(100000),
      downPaymentCents: dollarsToCents(10000),
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
      ...openEndedJob,
      salary: { startingSalaryCents: dollarsToCents(120000), currentSalaryCents: dollarsToCents(120000), realGrowthPct: 0 },
    });
    const partnerId = p.marry({
      month: 0,
      name: "Sam",
      birthYear: SAMPLE_START_YEAR - 38,
      jobs: [
        { ...openEndedJob, salary: { startingSalaryCents: dollarsToCents(60000), currentSalaryCents: dollarsToCents(60000), realGrowthPct: 0 } },
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
      ...openEndedJob,
      salary: { startingSalaryCents: dollarsToCents(120000), currentSalaryCents: dollarsToCents(120000), realGrowthPct: 0 },
      deferral: { deferralFraction: 0.1, fundAccountId: RETIREMENT_ID },
    });
    const plain = p.addJob(P1, {
      ...openEndedJob,
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

describe("Projection.retirement — the whole question, one search", () => {
  const covered = mockJurisdiction({
    publicHealthCoverageAge: 65,
    healthCostBenchmarkMonthlyCents: () => dollarsToCents(1000),
  });

  const outlookOf = (plan: typeof samplePlan, jurisdiction = nullJurisdiction) =>
    Projection.fromState(stateOf(plan), nullJurisdiction).retirement(jurisdiction);

  it("evaluates the plan's OWN target age, not one it was told", () => {
    expect(outlookOf({ ...samplePlan, retirementAge: 62 }).target.retirementAge).toBe(62);
  });

  it("falls back to the earliest feasible age when the pinned age cannot be reached", () => {
    // Pinned absurdly early: the target fails, so its nearest-feasible age is the age the
    // SAME search found — the one rule that keeps headline and target describing one household.
    const outlook = outlookOf({ ...samplePlan, retirementAge: 40 });
    expect(outlook.target.feasible).toBe(false);
    expect(outlook.target.nearestFeasibleAge).toBe(outlook.solution.fullRetirementAge);
  });

  it("keeps a reachable pinned age as its own nearest-feasible age", () => {
    const outlook = outlookOf({ ...samplePlan, retirementAge: 80 });
    expect(outlook.target.feasible).toBe(true);
    expect(outlook.target.nearestFeasibleAge).toBe(80);
  });

  it("dates the full-retirement age in months from now, for a chart's reference line", () => {
    const outlook = outlookOf(samplePlan);
    const age = outlook.solution.fullRetirementAge;
    expect(age).not.toBeNull();
    expect(outlook.fullRetirementMonth).toBe((age! - samplePlan.currentAge) * 12);
  });

  it("flags a health gap only when retirement lands before the coverage age", () => {
    // Retiring at 60 with $600/mo authored against a $1,000/mo benchmark: a 5-year gap.
    const flag = outlookOf(samplePlan, covered).earlyRetireeHealth;
    expect(flag.gapYears).toBe(5);
    expect(flag.shortfallMonthlyCents).toBe(dollarsToCents(400));

    // Retiring at the coverage age closes the window, whatever the authored line says.
    expect(outlookOf({ ...samplePlan, retirementAge: 65 }, covered).earlyRetireeHealth.gapYears)
      .toBe(0);
    // A jurisdiction naming no coverage age has no window to be early for.
    expect(outlookOf(samplePlan).earlyRetireeHealth.gapYears).toBe(0);
  });

  it("leaves run() alone — a simulation is not a search", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const result = p.run(nullJurisdiction);
    // Nothing on a run answers the retirement question, so a caller that only wants the graph
    // never pays for the search.
    expect("retirement" in result).toBe(false);
    expect(result.series.months.length).toBeGreaterThan(0);
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
describe("ProjectionResult.assessHomePurchase — the guideline read", () => {
  const purchase = {
    month: 0,
    purchasePriceCents: dollarsToCents(300000),
    downPaymentCents: dollarsToCents(60000),
    apr: 0.065,
    termMonths: 360,
  };

  const ranWith = (monthlyIncomeCents: number) =>
    Projection.fromState(stateOf({ ...samplePlan, jobs: [salariedJob(monthlyIncomeCents)] }), nullJurisdiction).run(nullJurisdiction);

  it("flags a purchase that pushes housing past the front-end guideline", () => {
    // ~$1,517/mo of mortgage against $5,000/mo gross is over 28%.
    const dti = ranWith(dollarsToCents(5000)).assessHomePurchase(purchase);
    expect(dti.monthlyGrossCents).toBe(dollarsToCents(5000));
    expect(dti.assessment.frontEndExceeded).toBe(true);
    expect(dti.exceeded).toBe(true);
  });

  it("stays quiet when the same mortgage is small against the income", () => {
    const dti = ranWith(dollarsToCents(20000)).assessHomePurchase(purchase);
    expect(dti.assessment.frontEndExceeded).toBe(false);
    expect(dti.assessment.backEndExceeded).toBe(false);
    expect(dti.exceeded).toBe(false);
  });

  it("quotes the mortgage the purchase would add, financed on the balance after the deposit", () => {
    const dti = ranWith(dollarsToCents(5000)).assessHomePurchase(purchase);
    // $240,000 at 6.5% over 30 years — around $1,500/mo.
    expect(dti.monthlyMortgageCents).toBeGreaterThan(dollarsToCents(1400));
    expect(dti.monthlyMortgageCents).toBeLessThan(dollarsToCents(1600));
  });

  it("flags nothing at zero gross income rather than dividing by it", () => {
    const dti = Projection.fromState(stateOf({ ...samplePlan, jobs: [] }), nullJurisdiction)
      .run(nullJurisdiction)
      .assessHomePurchase(purchase);
    expect(dti.monthlyGrossCents).toBe(0);
    expect(dti.assessment.frontEndRatio).toBe(0);
    expect(dti.exceeded).toBe(false);
  });

  it("counts debt already being serviced toward the back-end ratio", () => {
    const p = Projection.fromState(stateOf({ ...samplePlan, jobs: [salariedJob(dollarsToCents(12000))] }), nullJurisdiction);
    // Read a year in, where the loan taken at month 0 is being serviced.
    const later = { ...purchase, month: 12 };
    const clean = p.run(nullJurisdiction).assessHomePurchase(later);
    p.takeLoan({
      month: 0,
      ownerId: P1,
      kind: "auto",
      openingBalanceCents: dollarsToCents(60000),
      apr: 6,
      termMonths: 60,
    });
    const withLoan = p.run(nullJurisdiction).assessHomePurchase(later);
    // Housing is unchanged — the loan is not a mortgage — but total debt is not.
    expect(withLoan.assessment.frontEndRatio).toBeCloseTo(clean.assessment.frontEndRatio, 5);
    expect(withLoan.assessment.backEndRatio).toBeGreaterThan(clean.assessment.backEndRatio);
  });
});
