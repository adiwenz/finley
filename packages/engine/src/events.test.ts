import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  replayLedger,
  snapshotAt,
  validateLedgerStructure,
  validateNewEvent,
  type Ledger,
  type LifeEvent,
} from "./index";
import { dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";
import { personLit, baseConfig, add } from "./events.testSupport";

// ─── Replay basics ────────────────────────────────────────────────────────────

describe("replayLedger — empty ledger", () => {
  it("empty ledger with no income/expense produces flat zero projection", () => {
    const series = replayLedger(emptyLedger, baseConfig, nullJurisdiction);
    expect(series.months.length).toBe(13);
    expect(series.months[0].netWorthNominalCents).toBe(0);
    expect(series.months[12].netWorthNominalCents).toBe(0);
  });
});

// ─── Event validation ─────────────────────────────────────────────────────────

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

  it("validateNewEvent rejects ending a nonexistent series", () => {
    const result = validateNewEvent(emptyLedger, baseConfig, {
      id: "e1", type: "BudgetItemEndEvent", month: 0, seriesId: "ghost",
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
    // Partner joins at month 60; a separation dated month 12 predates the partnership.
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

// ─── Replay order — (month, sequenceNumber) ───────────────────────────────────

describe("replay order", () => {
  it("same-month producer-before-consumer: an end applies after the series it ends", () => {
    let ledger = emptyLedger;
    // s1 runs from month 0; at month 12 it ends and s2 begins in the same month.
    ledger = add(ledger, {
      id: "j1", type: "BudgetItemStartEvent", month: 0, seriesId: "s1", ownerId: "p1",
      seriesType: "income", monthlyCents: dollarsToCents(3_000), growthMode: { type: "fixed" }, taxCategory: "wages",
    });
    ledger = add(ledger, {
      id: "end1", type: "BudgetItemEndEvent", month: 12, seriesId: "s1",
    });
    ledger = add(ledger, {
      id: "j2", type: "BudgetItemStartEvent", month: 12, seriesId: "s2", ownerId: "p1",
      seriesType: "income", monthlyCents: dollarsToCents(5_000), growthMode: { type: "fixed" }, taxCategory: "wages",
    });
    const snap = snapshotAt(ledger, 12, { initialPersons: [personLit("p1", "Alice")] });
    // s1 ended at month 11 (12−1); only s2 is active at month 12.
    expect(snap.income.map((s) => s.id)).toEqual(["s2"]);
  });

  it("orders by sequenceNumber, not array position", () => {
    // Hand-built ledger with the events stored in reverse of their sequence.
    const j1: LifeEvent = {
      id: "j1", type: "BudgetItemStartEvent", sequenceNumber: 0, month: 0, seriesId: "s1", ownerId: "p1",
      seriesType: "income", monthlyCents: dollarsToCents(1_000), growthMode: { type: "fixed" }, taxCategory: "wages",
    };
    const end1: LifeEvent = {
      id: "end1", type: "BudgetItemEndEvent", sequenceNumber: 1, month: 0, seriesId: "s1",
    };
    const j2: LifeEvent = {
      id: "j2", type: "BudgetItemStartEvent", sequenceNumber: 2, month: 0, seriesId: "s2", ownerId: "p1",
      seriesType: "income", monthlyCents: dollarsToCents(2_000), growthMode: { type: "fixed" }, taxCategory: "wages",
    };
    const ledger: Ledger = { events: [j2, end1, j1], nextSequenceNumber: 3 };
    const snap = snapshotAt(ledger, 0, { initialPersons: [personLit("p1", "Alice")] });
    // Sorted by (month, seq): j1 creates s1, end1 ends it, j2 creates s2 → only s2 active.
    expect(snap.income.map((s) => s.id)).toEqual(["s2"]);
  });
});
