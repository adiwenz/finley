/**
 * The `Projection` root (§2, §18, §20, "npm API surface", issue #70, slice 7).
 *
 * These tests pin the six acceptance criteria of the slice:
 *   1. standing-edit + ledger-transaction methods on ONE root, ONE undo stack;
 *   2. creating writes mint deterministic sequence ids and return them; `{ id }` overrides;
 *   3. the id counter round-trips through serialization (reload continues, no collision);
 *   4. `run(jurisdiction)` returns an immutable `ProjectionResult`; two jurisdictions,
 *      one plan, no mutation;
 *   5. `undo()` reverts standing edits and ledger transactions uniformly;
 *   6. (barrel/purity covered elsewhere.)
 */
import { describe, it, expect } from "vitest";
import { Projection } from "./projectionRoot";
import { samplePlan, SAMPLE_START_YEAR } from "./testing/samplePlan";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { nullJurisdiction } from "./jurisdiction";
import { dollarsToCents } from "./cashFlowSeries";
import type { PersonId } from "./job";

const P1 = "p1" as PersonId;

function freshProjection(): Projection {
  return Projection.create({ plan: samplePlan, startYear: SAMPLE_START_YEAR });
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

describe("Projection root — creating writes mint deterministic ids (AC2)", () => {
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
    expect(p.takeLoan({ month: 6, kind: "auto", openingBalanceCents: dollarsToCents(20000), apr: 5, termMonths: 60 })).toBe("loan-4");
  });

  it("honours a caller `{ id }` override without consuming the counter", () => {
    const p = freshProjection();
    expect(p.addJob(P1, { ...openEndedJob, id: "day-job" })).toBe("day-job");
    // The override did not advance the counter, so the next minted id is still "-1".
    expect(p.addBudgetLine(expenseLine)).toBe("line-1");
  });

  it("routes the added job onto the standing plan, owned by the person", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    const jobs = p.state.plan.jobs ?? [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: jobId, owners: [P1], endYear: null });
  });
});

describe("Projection root — one root, standing + ledger, one undo stack (AC1, AC5)", () => {
  it("exposes both standing edits and ledger transactions on the same object", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, openEndedJob);
    const loanId = p.takeLoan({
      month: 12,
      kind: "auto",
      openingBalanceCents: dollarsToCents(25000),
      apr: 6,
      termMonths: 60,
    });
    expect(jobId).toBe("job-1");
    expect(loanId).toBe("loan-2");
    expect(p.state.plan.jobs).toHaveLength(1);
    expect(p.state.ledger.events).toHaveLength(1);
    expect(p.depth).toBe(2);
  });

  it("undo() reverts a standing edit and a ledger transaction uniformly (LIFO)", () => {
    const p = freshProjection();
    const baseRetirement = p.state.plan.retirementAge;
    p.setRetirementTarget(55); // standing edit
    p.takeLoan({ month: 3, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 }); // ledger

    expect(p.state.ledger.events).toHaveLength(1);
    expect(p.state.plan.retirementAge).toBe(55);

    // Pop the ledger transaction: ledger empties, the standing edit remains.
    expect(p.undo()).toBe(true);
    expect(p.state.ledger.events).toHaveLength(0);
    expect(p.state.plan.retirementAge).toBe(55);

    // Pop the standing edit: retirement age is back to baseline.
    expect(p.undo()).toBe(true);
    expect(p.state.plan.retirementAge).toBe(baseRetirement);

    // Nothing left to undo.
    expect(p.undo()).toBe(false);
    expect(p.depth).toBe(0);
  });

  it("a fully-undone ledger transaction consumes no id counter residue", () => {
    const p = freshProjection();
    p.takeLoan({ month: 3, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });
    p.undo();
    // The counter reverts with the state, so the next mint restarts at 1.
    expect(p.state.nextSeq).toBe(1);
    expect(p.addJob(P1, openEndedJob)).toBe("job-1");
  });

  it("marry() adds a partner as a ledger event", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    expect(partnerId).toBe("person-1");
    expect(p.state.ledger.events[0]).toMatchObject({ type: "RelationshipEvent" });
  });

  it("a refused ledger transaction leaves history and the id counter untouched", () => {
    const p = freshProjection();
    const before = p.state;
    // Down payment far exceeds any liquid balance → §4.5 hard block refuses it.
    expect(() =>
      p.buyHome({
        month: 12,
        purchasePriceCents: dollarsToCents(500000),
        downPaymentCents: dollarsToCents(400000),
        downPaymentAccountId: "savings",
        mortgageApr: 6,
        mortgageTermMonths: 360,
      }),
    ).toThrow();
    expect(p.state).toBe(before);
    expect(p.depth).toBe(0);
    expect(p.addJob(P1, openEndedJob)).toBe("job-1");
  });
});

describe("Projection root — id counter round-trips through serialization (AC3)", () => {
  it("a reloaded plan continues the sequence without collision", () => {
    const p = freshProjection();
    p.addJob(P1, openEndedJob); // job-1
    p.addBudgetLine(expenseLine); // line-2 → nextSeq now 3

    const snapshot = JSON.parse(JSON.stringify(p.toJSON()));
    const reloaded = Projection.fromJSON(snapshot);

    // The counter survived the round-trip: the next mint is 3, not a colliding 1.
    expect(reloaded.state.nextSeq).toBe(3);
    expect(reloaded.addGoal({
      name: "Trip",
      targetCents: dollarsToCents(5000),
      targetDate: 12,
      disposition: "spend",
      annualReturnPct: 2,
    })).toBe("goal-3");
    // Standing data survived too.
    expect(reloaded.state.plan.jobs).toHaveLength(1);
    expect(reloaded.state.plan.budgetLines).toHaveLength(1);
  });
});

describe("Projection root — run(jurisdiction) → immutable result, no mutation (AC4)", () => {
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
    const taxed = p.run(mockJurisdiction({ id: "flat-tax", computeTaxCents: () => dollarsToCents(1500) }));

    expect(taxed.jurisdictionId).toBe("flat-tax");
    const lastUntaxed = untaxed.series.months.at(-1)?.netWorthNominalCents;
    const lastTaxed = taxed.series.months.at(-1)?.netWorthNominalCents;
    expect(lastTaxed).not.toBe(lastUntaxed);

    // run() is read-only: the authoring state is byte-identical before and after.
    expect(p.toJSON()).toBe(before);
    expect(p.depth).toBe(1);
  });
});
