import { describe, expect, it } from "vitest";
import type { Ledger, SnapshotSeries } from "@finley/engine";
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

const ledger = (...events: any[]): Ledger =>
  ({ events, nextSequenceNumber: events.length }) as Ledger;

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
    // The engine keys outcomes by obligation id and mirrors the authoring event onto each as
    // `sourceEventId`; structural events spawn no obligation and so appear nowhere in the map.
    const series = {
      status: "blocked",
      obligationOutcomes: {
        "downpayment:blocked": { status: "blocked", sourceEventId: "blocked" },
        "downpayment:later": { status: "not-reached", sourceEventId: "later" },
      },
    } as any;

    expect(
      new Map(timelineMarkers(events, series).map((marker) => [marker.id, marker.outcome])),
    ).toEqual(
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
  /** A blocked series carrying one engine-classified funding failure. */
  const blocked = (fundingFailure: unknown) =>
    ({
      status: "blocked",
      blockingObligation: {
        label: "downpayment",
        sourceEventId: "blocked",
        month: 12,
        shortfallCents: 1_500_000,
        fundingFailure,
      },
    }) as any;

  it("combines the blocking event's app label with the engine-provided shortfall", () => {
    const warning = blockedWarning(
      ledger(home("blocked", 12, 0)),
      blocked({ kind: "no-eligible-source-suffices" }),
    );

    expect(warning).toMatchObject({
      eventLabel: "Bought a home",
      month: 12,
      shortfallCents: 1_500_000,
    });
  });

  it("passes through the engine's no-eligible-source-suffices verdict", () => {
    const warning = blockedWarning(
      ledger(home("blocked", 12, 0)),
      blocked({ kind: "no-eligible-source-suffices" }),
    );
    expect(warning?.kind).toBe("no-eligible-source-suffices");
  });

  it("resolves each alternative account id to its funding-pool label, amounts untouched", () => {
    const series = blocked({
      kind: "funding-configuration",
      alternativeSources: [
        { accountId: "houseFund", availableCents: 9_000_000 },
        { accountId: "brokerage", availableCents: 2_500_000 },
      ],
    });
    // The picker's own liquid pool, supplied directly — the label lookup is the view's only work.
    const funding = {
      sourcesAt: (_month: number) => [
        { id: "houseFund", label: "House fund", balanceCents: 9_000_000 },
        { id: "brokerage", label: "Brokerage", balanceCents: 2_500_000 },
      ],
    } as any;

    const warning = blockedWarning(ledger(home("blocked", 12, 0)), series, funding);
    if (warning?.kind !== "funding-configuration") throw new Error("expected funding-configuration");
    expect(warning.alternativeSources).toEqual([
      { label: "House fund", availableCents: 9_000_000 },
      { label: "Brokerage", availableCents: 2_500_000 },
    ]);
  });

  it("falls back to the raw account id when no funding pool is supplied", () => {
    const warning = blockedWarning(
      ledger(home("blocked", 12, 0)),
      blocked({
        kind: "funding-configuration",
        alternativeSources: [{ accountId: "houseFund", availableCents: 9_000_000 }],
      }),
    );
    if (warning?.kind !== "funding-configuration") throw new Error("expected funding-configuration");
    expect(warning.alternativeSources.map((a) => a.label)).toEqual(["houseFund"]);
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
  ): Pick<SnapshotSeries, "role" | "seriesType"> => ({
    seriesType: "expense",
    role: "base",
    ...over,
  });

  it("maps engine series roles to app-facing labels", () => {
    expect(seriesLabel(series({ role: "primaryIncome", seriesType: "income" }))).toBe("Job income");
    expect(seriesLabel(series({ role: "alimony" }))).toBe("Alimony");
    expect(seriesLabel(series({ role: "childSupport" }))).toBe("Child support");
    expect(seriesLabel(series({ role: "base" }))).toBe("Expense");
    expect(seriesLabel(series({ role: "base", seriesType: "income" }))).toBe("Income");
  });
});
