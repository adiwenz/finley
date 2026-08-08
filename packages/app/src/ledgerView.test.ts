import { describe, expect, it } from "vitest";
import type {
  BlockedObligation,
  Ledger,
  ObligationOutcome,
  ProjectionSeries,
  SnapshotSeries,
} from "@finley/engine";
import {
  blockedWarning,
  seriesLabel,
  splitMarkers,
  summarizeEvent,
  timelineMarkers,
} from "./ledgerView";

const child = (id: string, month: number, sequenceNumber: number, name = "Robin") => ({
  id,
  type: "ChildEvent" as const,
  month,
  sequenceNumber,
  childId: `child-${id}`,
  childName: name,
  birthMonth: month,
  annualCostCents: 0,
});

const home = (id: string, month: number, sequenceNumber: number) => ({
  id,
  type: "HomePurchaseEvent" as const,
  month,
  sequenceNumber,
  propertyId: `home-${id}`,
  ownerId: "primary",
  purchasePriceCents: 30_000_000,
  downPaymentCents: 6_000_000,
  downPaymentSourceIds: [] as string[],
  mortgage: {
    liabilityId: `mortgage-${id}`,
    openingBalanceCents: 24_000_000,
    apr: 0.065,
    termMonths: 360,
  },
});

const ledger = (...events: any[]): Ledger => ({ events, nextSequenceNumber: events.length }) as Ledger;

/**
 * A blocked run, supplied directly. Which obligations the simulator classifies as blocked or
 * not-reached is the engine's (`projection/simulate.blocking.test.ts`); what these pin is the join
 * back to the AUTHORING event, which is the app's alone.
 */
const blockedRun = (
  blocking: Partial<BlockedObligation>,
  outcomes: Record<string, ObligationOutcome> = {},
): Pick<ProjectionSeries, "status" | "obligationOutcomes" | "blockingObligation"> => ({
  status: "blocked",
  obligationOutcomes: outcomes,
  blockingObligation: {
    obligationId: "downpayment:blocked",
    label: "downpayment",
    month: 12,
    requiredCents: 6_000_000,
    availableCents: 4_500_000,
    shortfallCents: 1_500_000,
    markerNetWorthCents: null,
    ...blocking,
  },
});

describe("summarizeEvent", () => {
  it("turns authored events into timeline language", () => {
    expect(summarizeEvent(child("c1", 24, 0, "Robin"))).toMatchObject({
      label: "Had a child",
    });
    expect(summarizeEvent(child("c1", 24, 0, "Robin")).detail).toContain("Robin");

    const purchase = summarizeEvent(home("h1", 36, 0));
    expect(purchase.label).toBe("Bought a home");
    expect(purchase.detail).toContain("$300,000");
    expect(purchase.detail).toContain("$60,000 down");
    expect(purchase.detail).toContain("$240,000 mortgage");
  });

  it("describes a cash purchase without inventing financing", () => {
    expect(
      summarizeEvent({
        ...home("h1", -1, 0),
        purchasePriceCents: 40_000_000,
        downPaymentCents: 0,
        mortgage: undefined,
      } as any).detail,
    ).toBe("$400,000, no mortgage");
  });
});

describe("timelineMarkers", () => {
  it("sorts by month then sequence number", () => {
    const markers = timelineMarkers(
      ledger(child("later", 24, 0), child("second", 12, 2), child("first", 12, 1)),
    );
    expect(markers.map((marker) => marker.id)).toEqual(["first", "second", "later"]);
  });

  it("maps engine-provided event outcomes without re-running the engine", () => {
    const events = ledger(home("blocked", 12, 0), child("structural", 36, 1), home("later", 60, 2));
    // Keyed by OBLIGATION id, joined back to the event through `sourceEventId`. The structural
    // event bears no obligation at all, so it is absent and must fall through to executed.
    const series = blockedRun(
      { sourceEventId: "blocked" },
      {
        "downpayment:blocked": { status: "blocked", month: 12, shortfallCents: 1_500_000, sourceEventId: "blocked" },
        "downpayment:later": { status: "not-reached", blockedByObligationId: "downpayment:blocked", sourceEventId: "later" },
      },
    );

    expect(new Map(timelineMarkers(events, series).map((marker) => [marker.id, marker.outcome]))).toEqual(
      new Map([
        ["blocked", "blocked"],
        ["structural", "executed"],
        ["later", "not-reached"],
      ]),
    );
  });

  it("defaults every marker to executed when no projection series is supplied", () => {
    expect(timelineMarkers(ledger(child("c1", 12, 0))).map((marker) => marker.outcome)).toEqual([
      "executed",
    ]);
  });
});

describe("blockedWarning", () => {
  it("combines the blocking event's app label with the engine-provided shortfall", () => {
    const events = ledger(home("blocked", 12, 0));

    expect(blockedWarning(events, blockedRun({ sourceEventId: "blocked" }))).toMatchObject({
      // The household's words, not the obligation's internal "downpayment" band name.
      eventLabel: "Bought a home",
      month: 12,
      shortfallCents: 1_500_000,
    });
  });

  it("falls back to the obligation's own label when no authoring event carries it", () => {
    // A pre-existing holding blocks: there is no authored event to name, and rendering blank
    // would be worse than the band name.
    expect(blockedWarning(ledger(), blockedRun({}))).toMatchObject({ eventLabel: "downpayment" });
  });

  it("returns no warning when there is no blocked projection", () => {
    const events = ledger(child("c1", 12, 0));
    expect(blockedWarning(events, undefined)).toBeNull();
    expect(blockedWarning(events, { status: "ran-to-horizon" } as any)).toBeNull();
  });
});

describe("splitMarkers", () => {
  it("splits the already-derived timeline around the scrub month", () => {
    const events = ledger(child("past", 12, 0), child("future", 48, 1));
    const { passed, upcoming } = splitMarkers(events, 24);
    expect(passed.map((marker) => marker.id)).toEqual(["past"]);
    expect(upcoming.map((marker) => marker.id)).toEqual(["future"]);
  });
});

describe("seriesLabel", () => {
  const series = (
    over: Partial<Pick<SnapshotSeries, "role" | "seriesType">>,
  ): Pick<SnapshotSeries, "role" | "seriesType"> => ({ seriesType: "expense", role: "base", ...over });

  it("maps engine series roles to app-facing labels", () => {
    expect(seriesLabel(series({ role: "primaryIncome", seriesType: "income" }))).toBe("Job income");
    expect(seriesLabel(series({ role: "alimony" }))).toBe("Alimony");
    expect(seriesLabel(series({ role: "childSupport" }))).toBe("Child support");
    expect(seriesLabel(series({ role: "base" }))).toBe("Expense");
    expect(seriesLabel(series({ role: "base", seriesType: "income" }))).toBe("Income");
  });
});
