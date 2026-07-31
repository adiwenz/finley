import { describe, it, expect } from "vitest";
import { emptyLedger, validateLedgerStructure, type Ledger } from "./ledger/ledger";
import { replayLedger } from "./projection/buildHouseholdInput";
import { snapshotAt } from "./projection/snapshot";
import { validateNewEvent } from "./ledger/addEvent";
import type { LifeEvent } from "./ledger/eventTypes";
import { dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";
import { personLit, baseConfig, addBase, add } from "./events.testSupport";

// Replay basics

describe("replayLedger — empty ledger", () => {
  it("empty ledger with no income/expense produces flat zero projection", () => {
    const series = replayLedger(emptyLedger, baseConfig, nullJurisdiction);
    // months holds exactly horizonMonths processed months (0..11); the flow-free "now"
    // snapshot lives on series.opening.
    expect(series.months.length).toBe(12);
    expect(series.opening.netWorthNominalCents).toBe(0);
    expect(series.months[11].netWorthNominalCents).toBe(0);
  });
});

// Event validation

describe("event validation", () => {
  it("validateLedgerStructure rejects a duplicate event id", () => {
    const dup: Ledger = {
      events: [
        { id: "x", type: "ChildEvent", sequenceNumber: 0, month: 0, childId: "k1", childName: "A", birthMonth: 0, annualCostCents: 0 },
        { id: "x", type: "ChildEvent", sequenceNumber: 1, month: 0, childId: "k2", childName: "B", birthMonth: 0, annualCostCents: 0 },
      ],
      nextSequenceNumber: 2,
    };
    expect(validateLedgerStructure(dup).ok).toBe(false);
  });

  it("validateNewEvent rejects a duplicate person id", () => {
    const ledger = add(emptyLedger, {
      id: "r1", type: "RelationshipEvent", month: 0, person: personLit("p2", "Sam"),
    });
    const result = validateNewEvent(ledger, baseConfig, {
      id: "r2", type: "RelationshipEvent", month: 0, person: personLit("p2", "Other"),
    });
    expect(result.ok).toBe(false);
  });

  it("validateNewEvent rejects a debt payoff against a liability that doesn't exist", () => {
    // addBase carries the checking account, so only the dangling liability can fail this —
    // the precondition catches a reference to something the ledger never created.
    const result = validateNewEvent(emptyLedger, addBase, {
      id: "pay1", type: "DebtPayoffEvent", month: 0, liabilityId: "ghost",
      accountId: "checking", amountCents: dollarsToCents(1_000),
    });
    expect(result.ok).toBe(false);
  });

  it("validateNewEvent rejects separating from an already-separated partner", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, { id: "r1", type: "RelationshipEvent", month: 0, person: personLit("p2", "Sam") });
    ledger = add(ledger, {
      id: "sep1", type: "SeparationEvent", month: 6, partnerPersonId: "p2",
      alimonyMonthlyCents: 0, alimonyDurationMonths: 0, childSupportMonthlyCents: 0,
    });
    const result = validateNewEvent(ledger, baseConfig, {
      id: "sep2", type: "SeparationEvent", month: 12, partnerPersonId: "p2",
      alimonyMonthlyCents: 0, alimonyDurationMonths: 0, childSupportMonthlyCents: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("validateNewEvent rejects separating before the partnership month", () => {
    // Partner joins at month 60, so a separation at month 12 predates the partnership.
    const ledger = add(emptyLedger, {
      id: "r1", type: "RelationshipEvent", month: 60, person: personLit("p2", "Sam"),
    });
    const result = validateNewEvent(ledger, baseConfig, {
      id: "sep1", type: "SeparationEvent", month: 12, partnerPersonId: "p2",
      alimonyMonthlyCents: 0, alimonyDurationMonths: 0, childSupportMonthlyCents: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("before partnering");
  });
});

// Replay order — (month, sequenceNumber)

describe("replay order", () => {
  it("same-month producer-before-consumer: the consumer applies after the producer it needs", () => {
    let ledger = emptyLedger;
    // A partner joins and separates in the SAME month. The separation only validates and
    // applies because the partnership event, earlier in sequence, is folded in first.
    ledger = add(ledger, {
      id: "r1", type: "RelationshipEvent", month: 6, person: personLit("p2", "Sam"),
    });
    ledger = add(ledger, {
      id: "sep1", type: "SeparationEvent", month: 6, partnerPersonId: "p2",
      alimonyMonthlyCents: 0, alimonyDurationMonths: 0, childSupportMonthlyCents: 0,
    });
    const snap = snapshotAt(ledger, 6, { initialPersons: [personLit("p1", "Alice")] });
    // Both applied in order — had the separation run first it would have found no partner
    // to end, leaving p2 present. It ended, so only p1 remains at the separation month.
    expect(snap.persons.map((p) => p.id)).toEqual(["p1"]);
  });

  it("orders by sequenceNumber, not array position", () => {
    // Events stored in reverse of their sequence — replay must sort before applying.
    const r1: LifeEvent = {
      id: "r1", type: "RelationshipEvent", sequenceNumber: 0, month: 0, person: personLit("p2", "Sam"),
    };
    const sep1: LifeEvent = {
      id: "sep1", type: "SeparationEvent", sequenceNumber: 1, month: 0, partnerPersonId: "p2",
      alimonyMonthlyCents: 0, alimonyDurationMonths: 0, childSupportMonthlyCents: 0,
    };
    const ledger: Ledger = { events: [sep1, r1], nextSequenceNumber: 2 };
    const snap = snapshotAt(ledger, 0, { initialPersons: [personLit("p1", "Alice")] });
    // Sorted by (month, seq): r1 adds p2, sep1 separates it → only p1 remains. Array order
    // would apply the separation to an empty household and leave p2 present.
    expect(snap.persons.map((p) => p.id)).toEqual(["p1"]);
  });
});
