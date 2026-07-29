import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  replayLedger,
  removeEvent,
  updateEvent,
  computeDependents,
  validateLedgerStructure,
  type Ledger,
  type LedgerBaseConfig,
} from "./index";
import { dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";
import type { Person } from "./person";
import { personLit, makeLiquidAccount, baseConfig, add } from "./events.testSupport";

// updateEvent — revising an event already in the ledger

describe("updateEvent", () => {
  const cfg: LedgerBaseConfig = {
    horizonMonths: 12,
    annualInflationRate: 0,
    startYear: 2020,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [makeLiquidAccount()],
  };

  /** A partner carrying one open-ended job paying `monthlyDollars`, starting at "now". */
  const partnerEarning = (monthlyDollars: number): Person => ({
    ...personLit("p2", "Bob"),
    jobs: [
      {
        id: "pj1",
        ownerId: "p2",
        startYear: 2020,
        endYear: null,
        salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
      },
    ],
  });

  const partnered = (): Ledger =>
    add(emptyLedger, { id: "r1", type: "RelationshipEvent", month: 0, person: partnerEarning(2000) });

  it("revises a partner's jobs in place — the pay change drives the projection", () => {
    // A partner's jobs live on their RelationshipEvent, so without this write the only way
    // to change their salary is to remove the partner entirely, taking every dependent
    // event with them.
    const result = updateEvent(
      partnered(),
      "r1",
      { id: "r1", type: "RelationshipEvent", month: 0, person: partnerEarning(3000) },
      cfg,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const series = replayLedger(result.ledger, cfg, nullJurisdiction);
    // $3,000/mo across the 12 processed months (0..11) → $36,000; the last month is index 11.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(36_000));
  });

  it("keeps the event's place in the ledger — same sequence number, no number minted", () => {
    const ledger = partnered();
    const result = updateEvent(
      ledger,
      "r1",
      { id: "r1", type: "RelationshipEvent", month: 0, person: partnerEarning(3000) },
      cfg,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ledger.events).toHaveLength(1);
    expect(result.ledger.events[0].sequenceNumber).toBe(ledger.events[0].sequenceNumber);
    expect(result.ledger.nextSequenceNumber).toBe(ledger.nextSequenceNumber);
    expect(validateLedgerStructure(result.ledger).ok).toBe(true);
  });

  it("blocks a revision that strands a dependent event, naming it", () => {
    let ledger = partnered();
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 6,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    // Moving the partnership to month 9 would put the separation before it.
    const result = updateEvent(
      ledger,
      "r1",
      { id: "r1", type: "RelationshipEvent", month: 9, person: partnerEarning(2000) },
      cfg,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Replay runs in (month, sequence) order, so the separation would now come first — and
    // the conflict names the stranded event, not just "invalid".
    expect(result.conflict).toMatch(/sep1/);
    expect(result.conflict).toMatch(/cannot separate/);
  });

  it("refuses to change an event's id or type, and to update one that isn't there", () => {
    const ledger = partnered();
    const renamed = updateEvent(
      ledger,
      "r1",
      { id: "r2", type: "RelationshipEvent", month: 0, person: partnerEarning(2000) },
      cfg,
    );
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.conflict).toMatch(/different id/);

    const retyped = updateEvent(
      ledger,
      "r1",
      {
        id: "r1",
        type: "SeparationEvent",
        month: 0,
        partnerPersonId: "p2",
        alimonyMonthlyCents: 0,
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: 0,
      },
      cfg,
    );
    expect(retyped.ok).toBe(false);
    if (!retyped.ok) expect(retyped.conflict).toMatch(/type is fixed/);

    const missing = updateEvent(
      ledger,
      "nope",
      { id: "nope", type: "RelationshipEvent", month: 0, person: partnerEarning(2000) },
      cfg,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.conflict).toMatch(/No event with id/);
  });

  it("blocks a revision whose own fields are structurally invalid", () => {
    // The same field-level gate `addEvent` runs — a revision is not a way around it.
    const result = updateEvent(
      partnered(),
      "r1",
      { id: "r1", type: "RelationshipEvent", month: 1.5, person: partnerEarning(2000) },
      cfg,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/month must be an integer/);
  });
});

// Sequence number + same-month ordering

describe("addEvent — sequence numbers", () => {
  it("assigns monotonically increasing sequence numbers", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "e1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "loan-1",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 60,
    });
    ledger = add(ledger, {
      id: "e2",
      type: "LoanEvent",
      month: 0,
      liabilityId: "loan-2",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(20_000),
      apr: 0,
      termMonths: 60,
    });
    expect(ledger.events[0].sequenceNumber).toBe(0);
    expect(ledger.events[1].sequenceNumber).toBe(1);
    expect(ledger.nextSequenceNumber).toBe(2);
  });

  it("does not recycle a removed sequence number", () => {
    let ledger = emptyLedger;
    for (const id of ["a", "b", "c"]) {
      ledger = add(ledger, {
        id,
        type: "LoanEvent",
        month: 0,
        liabilityId: `loan-${id}`,
        ownerId: "p1",
        kind: "auto",
        openingBalanceCents: dollarsToCents(1_000),
        apr: 0,
        termMonths: 60,
      });
    }
    expect(ledger.nextSequenceNumber).toBe(3);

    const removed = removeEvent(ledger, "b", baseConfig);
    expect(removed.ok).toBe(true);
    if (removed.ok) ledger = removed.ledger;
    expect(ledger.nextSequenceNumber).toBe(3); // not decremented

    ledger = add(ledger, {
      id: "d",
      type: "LoanEvent",
      month: 0,
      liabilityId: "loan-d",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(1_000),
      apr: 0,
      termMonths: 60,
    });
    expect(ledger.events.at(-1)?.sequenceNumber).toBe(3); // reuses next, not the freed 1
    expect(ledger.nextSequenceNumber).toBe(4);
  });
});

// removeEvent — base replay context

describe("removeEvent — replays against base-seeded people", () => {
  it("succeeds when a remaining event's owner is a base person; fails without that person", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "j1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(5_000),
      apr: 0,
      termMonths: 60,
    });
    ledger = add(ledger, {
      id: "b1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "boat",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(1_000),
      apr: 0,
      termMonths: 60,
    });
    // j1 (owned by base person p1) still validates when replayed after removal.
    expect(removeEvent(ledger, "b1", baseConfig).ok).toBe(true);
    // Without p1 in the base, j1's owner precondition fails.
    const noPeople: LedgerBaseConfig = { horizonMonths: 12, annualInflationRate: 0, initialPersons: [] };
    expect(removeEvent(ledger, "b1", noPeople).ok).toBe(false);
  });

  it("returns a failure when the event id does not exist", () => {
    const result = removeEvent(emptyLedger, "does-not-exist", baseConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toContain("does-not-exist");
  });
});

// computeDependents — transitive cascade

describe("computeDependents — transitive cascade", () => {
  it("returns the whole causedBy chain, and removeEvent cascades all of it", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 120,
    });
    ledger = add(ledger, {
      id: "pay1",
      type: "DebtPayoffEvent",
      month: 3,
      causedByEventId: "loan1",
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(1_000),
    });
    ledger = add(ledger, {
      id: "pay2",
      type: "DebtPayoffEvent",
      month: 6,
      causedByEventId: "pay1",
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(1_000),
    });

    const deps = computeDependents(ledger, "loan1");
    expect(deps).toEqual(expect.arrayContaining(["loan1", "pay1", "pay2"]));
    expect(deps).toHaveLength(3);

    const result = removeEvent(ledger, "loan1", baseConfig);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ledger.events).toHaveLength(0);
  });
});

// Undo: Strategy A (precondition check)

describe("removeEvent — Strategy A", () => {
  it("blocks removing a RelationshipEvent if a SeparationEvent depends on the person", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 6,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    // Removing r1 would leave sep1 referencing a non-existent person.
    const result = removeEvent(ledger, "r1", baseConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("p2");
    }
  });

  it("blocks removing a LoanEvent if a DebtPayoffEvent targets that liability", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.05,
      termMonths: 60,
    });
    ledger = add(ledger, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(3_000),
    });
    const result = removeEvent(ledger, "loan1", baseConfig);
    expect(result.ok).toBe(false);
  });

  it("allows removing a standalone event with no dependents", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "b1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(1_000),
      apr: 0,
      termMonths: 60,
    });
    const result = removeEvent(ledger, "b1", baseConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ledger.events).toHaveLength(0);
    }
  });
});

// Undo: Strategy B (computeDependents cascade)

describe("computeDependents", () => {
  it("returns just the event id when there are no dependents", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "e1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 60,
    });
    expect(computeDependents(ledger, "e1")).toEqual(["e1"]);
  });

  it("includes events whose sourceEventId matches the target", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.05,
      termMonths: 60,
    });
    // Tag a payoff as a child of loan1 via sourceEventId
    ledger = add(ledger, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      causedByEventId: "loan1",
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(3_000),
    });
    const deps = computeDependents(ledger, "loan1");
    expect(deps).toContain("loan1");
    expect(deps).toContain("payoff1");
  });
});

describe("removeEvent — Strategy B cascade", () => {
  it("removes dependent events (sourceEventId chain) along with the target", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    // A loan owned by the partner, tagged as a child of r1 via causedByEventId.
    ledger = add(ledger, {
      id: "j1",
      type: "LoanEvent",
      month: 0,
      causedByEventId: "r1",
      liabilityId: "car",
      ownerId: "p2",
      kind: "auto",
      openingBalanceCents: dollarsToCents(5_000),
      apr: 0,
      termMonths: 60,
    });
    // No SeparationEvent — so removing r1 is not blocked by Strategy A.
    const result = removeEvent(ledger, "r1", baseConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both r1 and j1 (its dependent) are removed.
      expect(result.ledger.events).toHaveLength(0);
    }
  });
});
