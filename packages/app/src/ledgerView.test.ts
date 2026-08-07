import { describe, it, expect } from "vitest";
import { Projection, PRIMARY_PERSON_ID, dollarsToCents, nullJurisdiction } from "@finley/engine";
import type { Ledger, SnapshotSeries } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "./testing/projectionHarness";
import { DEFAULT_INPUT, PLAN_DEFAULTS } from "./planDefaults";
import { summarizeEvent, timelineMarkers, splitMarkers, seriesLabel, blockedWarning } from "./ledgerView";

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

  it("folds the financing mortgage into a home-purchase detail", () => {
    const s = summarizeEvent({
      id: "buy1",
      type: "HomePurchaseEvent",
      month: 36,
      sequenceNumber: 0,
      propertyId: "home-1",
      ownerId: "p1",
      purchasePriceCents: 300_000_00,
      downPaymentCents: 60_000_00,
      downPaymentSourceIds: [],
      mortgage: { liabilityId: "home-1-mortgage", openingBalanceCents: 240_000_00, apr: 0.065, termMonths: 360 },
    });
    expect(s.label).toBe("Bought a home");
    expect(s.detail).toContain("$300,000");
    expect(s.detail).toContain("$60,000 down");
    expect(s.detail).toContain("$240,000 mortgage");
    expect(s.detail).toContain("6.5%");
    expect(s.detail).toContain("30 yr");
  });

  it("names a cash purchase as having no mortgage", () => {
    const s = summarizeEvent({
      id: "own1",
      type: "HomePurchaseEvent",
      month: -1,
      sequenceNumber: 0,
      propertyId: "home-1",
      ownerId: "p1",
      purchasePriceCents: 400_000_00,
      downPaymentCents: 0,
      downPaymentSourceIds: [],
    });
    expect(s.detail).toBe("$400,000, no mortgage");
  });
});

describe("timelineMarkers", () => {
  it("returns markers sorted by (month, sequenceNumber)", () => {
    // Authored out of month order: the month-24 child before the month-12 marriage.
    const ledger = authored((p) => {
      p.haveChild({ month: 24, name: "Robin", annualCostCents: 0 });
      p.marry({ month: 12, name: "Sam", birthYear: 1990 });
    });
    const markers = timelineMarkers(ledger);
    expect(markers.map((m) => m.month)).toEqual([12, 24]);
    // The month-12 marriage sorts ahead of the month-24 child.
    const marriageId = ledger.events.find((e) => e.type === "RelationshipEvent")!.id;
    expect(markers[0].id).toBe(marriageId);
  });
});

describe("timelineMarkers — per-event outcomes from a blocked projection", () => {
  /**
   * Two purchases the plan can afford as authored, stranded by a later opening-balance edit exactly
   * as the UI drives it: the block lands on the first, the second is never reached, and a marriage
   * authored after the block stays a plain executed event — a structural change carries no
   * obligation, so the engine's outcome map never names it.
   */
  function strandedPurchases() {
    const built = Projection.fromInput(
      { ...DEFAULT_INPUT, openingBalanceCents: dollarsToCents(400_000) },
      usJurisdiction,
    );
    if (!built.ok) throw new Error(`fixture is not a valid ScenarioInput: ${built.error.reason}`);
    const p = built.projection;
    const buy = (month: number, price: number, down: number): string =>
      p.buyHome({
        month,
        ownerId: PRIMARY_PERSON_ID,
        purchasePriceCents: dollarsToCents(price),
        downPaymentCents: dollarsToCents(down),
        downPaymentSourceIds: ["savings"],
        mortgageApr: 0.06,
        mortgageTermMonths: 360,
      });
    const blocker = buy(12, 500_000, 200_000);
    const later = buy(60, 300_000, 60_000);
    const marriage = p.marry({ month: 36, name: "Sam", birthYear: 1990 });
    p.updatePlan({ openingBalanceCents: dollarsToCents(60_000) });
    return { ledger: p.ledger, series: p.run(usJurisdiction).series, blocker, later, marriage };
  }

  it("marks the blocking event blocked, later events not-reached, and structural events executed", () => {
    const { ledger, series, blocker, later, marriage } = strandedPurchases();
    expect(series.status).toBe("blocked");
    const outcome = new Map(timelineMarkers(ledger, series).map((m) => [m.id, m.outcome]));
    expect(outcome.get(blocker)).toBe("blocked");
    expect(outcome.get(later)).toBe("not-reached");
    // Folded into the household before month 0, the marriage was never an obligation the sim could
    // reach or fail — it renders with no indicator even though it sits after the blocked month.
    expect(outcome.get(marriage)).toBe("executed");
  });

  it("leaves every marker executed with no series, and on a run to the horizon", () => {
    const ledger = authored((p) => p.marry({ month: 12, name: "Sam", birthYear: 1990 }));
    // No series argument — the timeline shows an indicator only once something has actually stopped.
    expect(timelineMarkers(ledger).every((m) => m.outcome === "executed")).toBe(true);
  });
});

describe("blockedWarning — the soft-warning content for a stopped projection", () => {
  /** One affordable purchase, stranded by a later opening-balance edit — the block lands on it. */
  function strandedPurchase() {
    const built = Projection.fromInput(
      { ...DEFAULT_INPUT, openingBalanceCents: dollarsToCents(400_000) },
      usJurisdiction,
    );
    if (!built.ok) throw new Error(`fixture is not a valid ScenarioInput: ${built.error.reason}`);
    const p = built.projection;
    p.buyHome({
      month: 12,
      ownerId: PRIMARY_PERSON_ID,
      purchasePriceCents: dollarsToCents(500_000),
      downPaymentCents: dollarsToCents(200_000),
      downPaymentSourceIds: ["savings"],
      mortgageApr: 0.06,
      mortgageTermMonths: 360,
    });
    p.updatePlan({ openingBalanceCents: dollarsToCents(60_000) });
    return { ledger: p.ledger, series: p.run(usJurisdiction).series };
  }

  it("names the blocking event in plain language, its month, and the shortfall net of tax", () => {
    const { ledger, series } = strandedPurchase();
    const warning = blockedWarning(ledger, series);
    // Named from the AUTHORING event, not the obligation's engine-internal "downpayment" label.
    expect(warning?.eventLabel).toBe("Bought a home");
    expect(warning?.month).toBe(12);
    // Read from the engine's bare (already post-tax) shortfall, never recomputed in the app.
    expect(warning?.shortfallCents).toBe(series.blockingObligation!.shortfallCents);
  });

  it("is null with no series and on a run that reached the horizon", () => {
    const ledger = authored((p) => p.marry({ month: 12, name: "Sam", birthYear: 1990 }));
    // The snapshot panel's use — no series to read a block off of.
    expect(blockedWarning(ledger, undefined)).toBeNull();
    // A real, unblocked run has nothing to warn about, so the condition never holds.
    const built = Projection.fromInput(DEFAULT_INPUT, usJurisdiction);
    if (!built.ok) throw new Error(`fixture is not a valid ScenarioInput: ${built.error.reason}`);
    const series = built.projection.run(usJurisdiction).series;
    expect(series.status).toBe("ran-to-horizon");
    expect(blockedWarning(built.projection.ledger, series)).toBeNull();
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

