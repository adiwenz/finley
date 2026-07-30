import { describe, it, expect } from "vitest";
import type { SnapshotSeries } from "@finley/engine";
import { PLAN_DEFAULTS } from "./planDefaults";
import { readerOf, runOf } from "./testing/projectionHarness";
import { summarizeEvent, timelineMarkers, splitMarkers, seriesLabel } from "./ledgerView";

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
    // Built through the Projection's typed event methods — each asserts validation the way the
    // old `add` helper did, since a refused write throws.
    const p = readerOf(PLAN_DEFAULTS);
    p.haveChild({ id: "c1", month: 24, name: "Robin", annualCostCents: 0 });
    p.marry({ id: "j1", month: 12, name: "Sam", birthYear: 1990 });
    const markers = timelineMarkers(p.ledger);
    expect(markers.map((m) => m.month)).toEqual([12, 24]);
    expect(markers[0].id).toBe("j1");
  });
});

describe("splitMarkers", () => {
  it("splits events into passed and upcoming relative to the scrub month", () => {
    const p = readerOf(PLAN_DEFAULTS);
    p.haveChild({ id: "c1", month: 12, name: "Robin", annualCostCents: 0 });
    p.haveChild({ id: "c2", month: 48, name: "Sky", annualCostCents: 0 });
    const { passed, upcoming } = splitMarkers(p.ledger, 24);
    expect(passed.map((m) => m.id)).toEqual(["c1"]);
    expect(upcoming.map((m) => m.id)).toEqual(["c2"]);
  });
});

describe("seriesLabel — engine series role → snapshot-panel text", () => {
  // A real series off a run, for its branded `id`/`ownerId` — `seriesLabel` reads neither, but
  // the `SnapshotSeries` fixture needs valid ones, taken from public data rather than branded by hand.
  const sample = runOf(PLAN_DEFAULTS).snapshot(0).income[0];

  function series(overrides: Partial<SnapshotSeries>): SnapshotSeries {
    return {
      id: sample.id,
      ownerId: sample.ownerId,
      seriesType: "expense",
      role: "base",
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
    expect(seriesLabel(series({ role: "base" }))).toBe("Expense");
    expect(seriesLabel(series({ role: "base", seriesType: "income" }))).toBe("Income");
  });
});

