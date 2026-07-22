import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  addEvent,
  dollarsToCents,
  asSeriesId,
  asPersonId,
  type Ledger,
  type LedgerBaseConfig,
  type NewLifeEvent,
  type SnapshotSeries,
} from "@finley/engine";
import { summarizeEvent, timelineMarkers, splitMarkers, seriesLabel } from "./ledgerView";

const addBase: LedgerBaseConfig = {
  horizonMonths: 360,
  annualInflationRate: 0,
  initialPersons: [{ id: "p1", name: "Alex" }],
};

/** Build a ledger fixture, asserting each event passes validation. */
function add(ledger: Ledger, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, addBase, event);
  if (!result.ok) throw new Error(`fixture event rejected: ${result.conflict}`);
  return result.ledger;
}

describe("summarizeEvent — one plain-language label per structural change", () => {
  it("labels a child event", () => {
    const s = summarizeEvent({
      id: "c1",
      type: "ChildEvent",
      month: 24,
      sequenceNumber: 0,
      childId: "kid1",
      childName: "Robin",
      birthMonth: 24,
      annualCostCents: 0,
    });
    expect(s.label).toBe("Had a child");
    expect(s.detail).toContain("Robin");
  });

  it("labels a job change with the monthly amount", () => {
    const s = summarizeEvent({
      id: "j1",
      type: "JobChangeEvent",
      month: 12,
      sequenceNumber: 0,
      seriesId: "s1",
      ownerId: "p1",
      annualIncomeCents: dollarsToCents(60_000),
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    expect(s.label).toBe("Started a job");
    expect(s.detail).toContain("5,000");
  });

  it("labels a separation", () => {
    const s = summarizeEvent({
      id: "sep1",
      type: "SeparationEvent",
      month: 60,
      sequenceNumber: 0,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    expect(s.label).toBe("Separated");
  });
});

describe("timelineMarkers", () => {
  it("returns markers sorted by (month, sequenceNumber)", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "c1",
      type: "ChildEvent",
      month: 24,
      childId: "kid1",
      childName: "Robin",
      birthMonth: 24,
      annualCostCents: 0,
    });
    ledger = add(ledger, {
      id: "j1",
      type: "JobChangeEvent",
      month: 12,
      seriesId: "s1",
      ownerId: "p1",
      annualIncomeCents: dollarsToCents(60_000),
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    const markers = timelineMarkers(ledger);
    expect(markers.map((m) => m.month)).toEqual([12, 24]);
    expect(markers[0].id).toBe("j1");
  });
});

describe("splitMarkers", () => {
  it("splits events into passed and upcoming relative to the scrub month", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "c1",
      type: "ChildEvent",
      month: 12,
      childId: "kid1",
      childName: "Robin",
      birthMonth: 12,
      annualCostCents: 0,
    });
    ledger = add(ledger, {
      id: "c2",
      type: "ChildEvent",
      month: 48,
      childId: "kid2",
      childName: "Sky",
      birthMonth: 48,
      annualCostCents: 0,
    });
    const { passed, upcoming } = splitMarkers(ledger, 24);
    expect(passed.map((m) => m.id)).toEqual(["c1"]);
    expect(upcoming.map((m) => m.id)).toEqual(["c2"]);
  });
});

describe("seriesLabel — engine series role → snapshot-panel text", () => {
  function series(overrides: Partial<SnapshotSeries>): SnapshotSeries {
    return {
      id: asSeriesId("s1"),
      ownerId: asPersonId("p1"),
      seriesType: "expense",
      role: "budgetItem",
      monthlyCents: 0,
      causedByEventId: "e1",
      startMonth: 0,
      endMonth: null,
      ...overrides,
    };
  }

  it("labels each role in plain language", () => {
    expect(seriesLabel(series({ role: "primaryIncome", seriesType: "income" }))).toBe("Job income");
    expect(seriesLabel(series({ role: "alimony" }))).toBe("Alimony");
    expect(seriesLabel(series({ role: "childSupport" }))).toBe("Child support");
    expect(seriesLabel(series({ role: "budgetItem" }))).toBe("Expense");
    expect(seriesLabel(series({ role: "budgetItem", seriesType: "income" }))).toBe("Income");
  });
});
