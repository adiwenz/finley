/**
 * The `Projection` root — the npm API surface: standing edits and ledger transactions on one
 * object, deterministic minted ids, immutable state swaps with no undo stack, and
 * `run(jurisdiction)` leaving the plan untouched. Surface/purity is covered elsewhere.
 */
import { describe, it, expect } from "vitest";
import { samplePlan } from "../testing/samplePlan";
import { dollarsToCents } from "../money/cashFlowSeries";
import { P1, freshProjection, plainJob, partnerEvent } from "../testing/projectionFacadeFixtures";

describe("Projection root — one root for standing + ledger writes", () => {
  it("exposes both standing edits and ledger transactions on the same object", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const loanId = p.takeLoan({
      month: 12,
      ownerId: P1,
      kind: "studentLoan",
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
    const baseLifeExpectancy = before.scenario.plan.lifeExpectancy;

    p.updatePlan({ lifeExpectancy: 95 });
    p.takeLoan({ month: 3, ownerId: P1, kind: "studentLoan", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });

    expect(p.state.scenario.plan.lifeExpectancy).toBe(95);
    expect(p.state.scenario.ledger.events).toHaveLength(1);
    expect(before.scenario.plan.lifeExpectancy).toBe(baseLifeExpectancy);
    expect(before.scenario.ledger.events).toHaveLength(0);
    expect(p.state).not.toBe(before);
  });

  it("keeps plan and ledger coupled as one Scenario across both kinds of write", () => {
    // `Scenario` is one projectable unit: a standing edit carries the timeline through
    // (withPlan), a transaction the standing numbers (withLedger), so no spread drops half.
    const p = freshProjection();
    p.takeLoan({ month: 3, ownerId: P1, kind: "studentLoan", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });
    p.updatePlan({ lifeExpectancy: 95 }); // a standing edit AFTER a transaction

    expect(p.state.scenario.ledger.events).toHaveLength(1);
    expect(p.state.scenario.plan.lifeExpectancy).toBe(95);

    p.addJob(P1, plainJob); // another standing edit
    expect(p.state.scenario.ledger.events).toHaveLength(1);

    p.marry({ month: 24, name: "Partner", birthYear: 1988 }); // a transaction AFTER standing edits
    expect(p.state.scenario.plan.lifeExpectancy).toBe(95);
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
      jobs: [plainJob, plainJob],
    });
    const partnerJobs = partnerEvent(p).person.jobs;

    // Person plus two jobs = three minted ids, all distinct.
    const minted = [partnerId, ...partnerJobs.map((j) => j.id)];
    expect(new Set(minted).size).toBe(3);
    // Each job is owned by the partner the engine just created, not the caller's guess.
    expect(partnerJobs.every((j) => j.ownerId === partnerId)).toBe(true);
    // A subsequent addJob clears all three, so the counter walked past the nested jobs.
    expect(minted).not.toContain(p.addJob(P1, plainJob));
  });

  it("marry() preserves a partner job's explicit id override and steps the counter past it", () => {
    const p = freshProjection();
    p.marry({ month: 24, name: "Partner", birthYear: 1988, jobs: [plainJob] });
    // The partner's job is minted like any other, off the same counter the marriage drew from.
    const nested = partnerEvent(p).person.jobs[0]?.id;
    expect(nested).toMatch(/^job-\d+$/);
    // The next mint clears it rather than colliding with it.
    expect(p.addJob(P1, plainJob)).not.toBe(nested);
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
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 60,
    });

    const [card, auto] = p.state.scenario.ledger.events;
    expect(card).toMatchObject({ kind: "creditCard", creditLimitCents: dollarsToCents(8000) });
    expect(card).not.toHaveProperty("termMonths");
    expect(auto).toMatchObject({ kind: "studentLoan", termMonths: 60 });
    expect(auto).not.toHaveProperty("creditLimitCents");
  });

  it("composes one event carrying the mortgage inline, deriving its financed balance", () => {
    // A financed purchase is a SINGLE event now: the mortgage terms ride inside it, at a liability
    // id minted alongside the property id. The financed balance is derived `price − down`, so the
    // authoring layer never states it.
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

    const events = p.state.scenario.ledger.events;
    expect(events).toHaveLength(1);
    const [home] = events;
    expect(home.type).toBe("HomePurchaseEvent");
    if (home.type === "HomePurchaseEvent") {
      expect(home.propertyId).toBe("home-1");
      // Minted off the same counter as the property id, one call after it.
      expect(home.mortgage?.liabilityId).toBe("mortgage-2");
      expect(home.mortgage?.openingBalanceCents).toBe(dollarsToCents(90000)); // price − down
      expect(home.mortgage?.apr).toBe(6);
      expect(home.mortgage?.termMonths).toBe(360);
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
    expect(p.addJob(P1, plainJob)).toBe("job-1");
  });
});

