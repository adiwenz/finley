import { describe, it, expect } from "vitest";
import { Projection, nullJurisdiction } from "@finley/engine";
import type { Ledger, SnapshotSeries } from "@finley/engine";
import { stateOf } from "./testing/projectionHarness";
import { PLAN_DEFAULTS } from "./planDefaults";
import { summarizeEvent, timelineMarkers, splitMarkers, seriesLabel } from "./ledgerView";

/**
 * Author a timeline through the facade and read back the {@link Ledger} the view consumes —
 * the app never seeds a ledger by hand, it writes events through `Projection`. Event ids are
 * minted by the engine, so a test reads them off the returned ledger rather than naming them.
 */
function authored(write: (p: Projection) => void): Ledger {
  return Projection.transact(stateOf(PLAN_DEFAULTS), nullJurisdiction, write).state.scenario.ledger;
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
    // Authored out of month order: the month-24 child before the month-12 marriage.
    const ledger = authored((p) => {
      p.haveChild({ month: 24, name: "Robin", annualCostCents: 0 });
      p.marry({ month: 12, name: "Sam", birthYear: 1990, lifeExpectancy: PLAN_DEFAULTS.primary.lifeExpectancy });
    });
    const markers = timelineMarkers(ledger);
    expect(markers.map((m) => m.month)).toEqual([12, 24]);
    // The month-12 marriage sorts ahead of the month-24 child.
    const marriageId = ledger.events.find((e) => e.type === "RelationshipEvent")!.id;
    expect(markers[0].id).toBe(marriageId);
  });
});

describe("splitMarkers", () => {
  it("splits events into passed and upcoming relative to the scrub month", () => {
    const ledger = authored((p) => {
      p.haveChild({ month: 12, name: "Robin", annualCostCents: 0 });
      p.haveChild({ month: 48, name: "Sky", annualCostCents: 0 });
    });
    const robin = ledger.events.find((e) => e.month === 12)!.id;
    const sky = ledger.events.find((e) => e.month === 48)!.id;
    const { passed, upcoming } = splitMarkers(ledger, 24);
    expect(passed.map((m) => m.id)).toEqual([robin]);
    expect(upcoming.map((m) => m.id)).toEqual([sky]);
  });
});

describe("seriesLabel — engine series role → snapshot-panel text", () => {
  // `seriesLabel` reads only `role` and `seriesType`, so the fixture supplies exactly those —
  // no branded ids to mint, and no dependence on the internal id constructors.
  function series(
    overrides: Partial<Pick<SnapshotSeries, "role" | "seriesType">>,
  ): Pick<SnapshotSeries, "role" | "seriesType"> {
    return { seriesType: "expense", role: "base", ...overrides };
  }

  it("labels each role in plain language", () => {
    expect(seriesLabel(series({ role: "primaryIncome", seriesType: "income" }))).toBe("Job income");
    expect(seriesLabel(series({ role: "alimony" }))).toBe("Alimony");
    expect(seriesLabel(series({ role: "childSupport" }))).toBe("Child support");
    expect(seriesLabel(series({ role: "base" }))).toBe("Expense");
    expect(seriesLabel(series({ role: "base", seriesType: "income" }))).toBe("Income");
  });
});

