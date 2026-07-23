/**
 * The `Projection` root (§2, §18, §20, "npm API surface", issue #70, slice 7).
 *
 * These tests pin the six acceptance criteria of the slice:
 *   1. standing-edit + ledger-transaction methods on ONE root;
 *   2. creating writes mint deterministic sequence ids and return them; `{ id }` overrides;
 *   3. the id counter round-trips through serialization (reload continues, no collision);
 *   4. `run(jurisdiction)` returns an immutable `ProjectionResult`; two jurisdictions,
 *      one plan, no mutation;
 *   5. writes swap in a new immutable state and are NOT reversible by the root
 *      (no undo stack — reversal is addressable removal, landing in a later slice);
 *   6. (barrel/purity covered elsewhere.)
 */
import { describe, it, expect } from "vitest";
import { Projection } from "./projectionRoot";
import { samplePlan, careerJob, SAMPLE_START_YEAR } from "./testing/samplePlan";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { nullJurisdiction } from "./jurisdiction";
import { dollarsToCents } from "./cashFlowSeries";
import type { PersonId } from "./job";

const P1 = "p1" as PersonId;

function freshProjection(): Projection {
  // Start from an empty job list so the ids these tests mint (and the roster lengths
  // they assert) reflect only the jobs added under test, not the fixture's career job.
  return Projection.create({ plan: { ...samplePlan, jobs: [] }, startYear: SAMPLE_START_YEAR });
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
    expect(p.takeLoan({ month: 6, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(20000), apr: 5, termMonths: 60 })).toBe("loan-4");
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
    const jobs = p.state.scenario.plan.jobs ?? [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: jobId, ownerId: P1, endYear: null });
  });
});

describe("Projection root — one root for standing + ledger writes (AC1, AC5)", () => {
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

  it("swaps in a new state rather than mutating the one already read out (AC5)", () => {
    // The immutable core (§2): a caller holding a state from before a write — a React
    // render closure, a serialized snapshot — must never see it change underfoot.
    const p = freshProjection();
    const before = p.state;
    const baseRetirement = before.scenario.plan.retirementAge;

    p.setRetirementTarget(55); // standing edit
    p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 }); // ledger

    expect(p.state.scenario.plan.retirementAge).toBe(55);
    expect(p.state.scenario.ledger.events).toHaveLength(1);
    // The previously-read state is untouched by either write.
    expect(before.scenario.plan.retirementAge).toBe(baseRetirement);
    expect(before.scenario.ledger.events).toHaveLength(0);
    expect(p.state).not.toBe(before);
  });

  it("keeps plan and ledger coupled as one Scenario across both kinds of write (§6)", () => {
    // The state holds the projectable unit, not two sibling fields: a standing edit
    // carries the timeline through (withPlan) and a transaction carries the standing
    // numbers through (withLedger), so neither half can be dropped by a spread that
    // forgot a field — which is the whole reason `Scenario` exists.
    const p = freshProjection();
    p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });
    p.setRetirementTarget(55); // a standing edit AFTER a transaction

    expect(p.state.scenario.ledger.events).toHaveLength(1); // survived the standing edit
    expect(p.state.scenario.plan.retirementAge).toBe(55);

    p.addJob(P1, openEndedJob); // another standing edit
    expect(p.state.scenario.ledger.events).toHaveLength(1); // still there

    p.marry({ month: 24, name: "Partner", birthYear: 1988 }); // a transaction AFTER standing edits
    expect(p.state.scenario.plan.retirementAge).toBe(55); // standing numbers survived
    expect(p.state.scenario.plan.jobs).toHaveLength(1);
  });

  it("has no undo — writes are reversed by addressable removal, not a stack (AC5)", () => {
    // Deliberate: reversal names the thing to drop (a future `removeTransaction(id)`),
    // so a UI can delete row 3 without knowing what order rows were created in, and
    // nothing pretends to offer cross-session undo. See the module doc + issue #70.
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
    // The payload is discriminated on `kind`: a card takes a credit limit and never a
    // term, a term loan the reverse — so neither arm can be authored with the other's
    // field, and each lands on the event without an `undefined` placeholder.
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
    // Down payment far exceeds any liquid balance → §4.5 hard block refuses it.
    expect(() =>
      p.buyHome({
        month: 12,
        ownerId: P1,
        purchasePriceCents: dollarsToCents(500000),
        downPaymentCents: dollarsToCents(400000),
        downPaymentAccountId: "savings",
        mortgageApr: 6,
        mortgageTermMonths: 360,
      }),
    ).toThrow();
    expect(p.state).toBe(before);
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
    expect(reloaded.state.scenario.plan.jobs).toHaveLength(1);
    expect(reloaded.state.scenario.plan.budgetLines).toHaveLength(1);
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
  });
});

describe("Projection root — per-line monthly resolution in the result (§Q27, issue #71)", () => {
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
    // Keyed by the allocations() id (`line:<id>`), author line ↔ funded line.
    expect(flows?.lineMonthlyCents[RENT]).toBe(dollarsToCents(2_000));
    expect(flows?.lineMonthlyCents[FUN]).toBe(dollarsToCents(500));
  });

  it("reports every line at its full amount even once the plan is insolvent", () => {
    // $3k/mo income against a $6k/mo budget, no assets to liquidate → a genuine
    // shortfall. §15 priority funds rent (a need) before fun (a want).
    const p = Projection.create({
      plan: {
        ...samplePlan,
        jobs: [careerJob(dollarsToCents(3_000))],
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

    // A squeezed month is absorbed by savings, then by credit — the household really
    // did pay for all of it, so both lines report their full amount.
    expect(months[1]?.flows?.lineMonthlyCents[FUN]).toBe(dollarsToCents(2_000));
    expect(months[1]?.flows?.lineMonthlyCents[RENT]).toBe(dollarsToCents(4_000));

    // And once even credit is exhausted, the budget is STILL reported as authored. The
    // engine surfaces that the plan broke (`isInsolvent`); it does not decide on the
    // user's behalf which spending they would have given up.
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
    // The retirement gap: samplePlan retires at 60 and claims its benefit at 67, so
    // ages 60–67 have NO income at all. A household with savings funds its budget by
    // drawing them down — that is the plan working, not a starved budget, so the
    // per-line map must stay at full intent throughout the gap.
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
    expect(flows?.totalIncomeCents).toBe(0); // no paycheck, no benefit yet

    // Fully funded = the funded lines add up to the month's whole intent. Asserted
    // against the rollup rather than a literal, since a budget rises with prices.
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
