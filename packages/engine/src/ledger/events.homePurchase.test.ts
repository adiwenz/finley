/**
 * **A home, bought — the event's own lifecycle.**
 *
 * What acquiring a property does to the household and the projection, what removing the purchase
 * takes back with it, the mortgage the event carries inline (and the id collision that must be
 * refused), a HOLDING — a home already owned when the plan starts — and what happens when a later
 * edit strands a purchase that was authorable when it was written.
 *
 * The two contracts around the down payment are separate suites, because they are separate
 * questions: `events.homePurchase.downPaymentGate.test.ts` decides whether a purchase may be
 * authored at all, and `events.homePurchase.downPaymentDraw.test.ts` decides where the cash comes
 * from and what liquidating it costs.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent } from "./addEvent";
import { interpretLedger } from "./interpret";
import { buildProjection } from "../projection/buildHouseholdInput";
import { removeEvent } from "./removeEvent";
import type { NewLifeEvent } from "./eventTypes";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { PRE_NOW_MONTH } from "../projection/nowMarker";
import { validateLedger } from "./validateLedger";
import {
  DOWN,
  FINANCED,
  MORTGAGE_ID,
  PRICE,
  addFinanced,
  addWithBase,
  baseWith,
  loanEvent,
  purchase,
} from "./events.homePurchase.testUtils";

describe("HomePurchaseEvent", () => {
  it("creates a property, its mortgage, and a down-payment outflow", () => {
    const base = baseWith(10_000_000); // $100k liquid
    const ledger = addFinanced(emptyLedger, base);
    const household = interpretLedger(ledger, base);

    expect(household.properties).toHaveLength(1);
    expect(household.properties[0].id).toBe("house1");
    expect(household.properties[0].openingValueCents).toBe(PRICE);
    expect(household.properties[0].mortgageLiabilityId).toBe(MORTGAGE_ID);

    expect(household.liabilities).toHaveLength(1);
    expect(household.liabilities[0].id).toBe(MORTGAGE_ID);
    expect(household.liabilities[0].kind).toBe("mortgage");
    expect(household.liabilities[0].openingBalanceCents).toBe(FINANCED);
  });

  it("materializes the SAME mortgage liability id on every interpretation of the same ledger", () => {
    // The id lives on the authored event, not conjured fresh each time `apply` runs — so
    // interpreting the identical ledger twice (a re-run, a reload, a re-derived projection) must
    // land on the exact same id both times, not merely on two ids that happen not to collide.
    const base = baseWith(10_000_000);
    const ledger = addFinanced(emptyLedger, base);

    const first = interpretLedger(ledger, base);
    const second = interpretLedger(ledger, base);

    expect(first.properties[0].mortgageLiabilityId).toBe(MORTGAGE_ID);
    expect(second.properties[0].mortgageLiabilityId).toBe(MORTGAGE_ID);
    expect(second.properties[0].mortgageLiabilityId).toBe(first.properties[0].mortgageLiabilityId);
    expect(second.liabilities[0].id).toBe(first.liabilities[0].id);
  });

  it("materializes the mortgage from one event, needing no prior liability to exist", () => {
    // The mortgage rides inside the purchase — a single event, materialized as a dependent
    // artifact at its authored id — so there is no separate loan to author first and no ordering
    // precondition to satisfy.
    const base = baseWith(10_000_000);
    const result = addEvent(
      emptyLedger,
      base,
      purchase({
        mortgage: { liabilityId: MORTGAGE_ID, openingBalanceCents: FINANCED, apr: 0, termMonths: 360 },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const household = interpretLedger(result.ledger, base);
      expect(household.properties[0].mortgageLiabilityId).toBe(MORTGAGE_ID);
      expect(household.liabilities.map((l) => l.id)).toEqual([MORTGAGE_ID]);
    }
  });

  it("acquires a cash home with no securing liability", () => {
    // The link is optional: a purchase can omit it entirely and stand as a lone property.
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, purchase());
    const household = interpretLedger(ledger, base);
    expect(household.properties[0].mortgageLiabilityId).toBeNull();
    expect(household.liabilities).toHaveLength(0);
  });

  it("conserves net worth at the purchase month (property = down + mortgage)", () => {
    const base = baseWith(10_000_000);
    const ledger = addFinanced(emptyLedger, base);
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.months[2].netWorthNominalCents).toBe(10_000_000);
    expect(series.months[2].propertyValuesCents.house1 ?? 0).toBe(0);

    // The three moves cancel.
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(10_000_000 - DOWN);
    expect(m3.liabilityBalancesCents["house1-mortgage"]).toBe(FINANCED);
    expect(m3.propertyValuesCents.house1).toBe(PRICE);
    expect(m3.netWorthNominalCents).toBe(10_000_000);
  });

  it("takes the down payment for a purchase authored at month 0 (no free equity)", () => {
    // Month 0 is a real processed month now, so a Year-0 purchase drains its source in
    // months[0] rather than silently skipping the draw and granting the property's equity for
    // free. Net worth is conserved: −DOWN cash, +PRICE property, −FINANCED mortgage.
    const base = baseWith(10_000_000);
    const ledger = addFinanced(emptyLedger, base, { month: 0 });
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // `opening` is untouched — the purchase hasn't run at "now".
    expect(series.opening.accountBalancesCents.savings).toBe(10_000_000);
    expect(series.opening.propertyValuesCents.house1 ?? 0).toBe(0);

    const m0 = series.months[0];
    expect(m0.accountBalancesCents.savings).toBe(10_000_000 - DOWN);
    expect(m0.liabilityBalancesCents["house1-mortgage"]).toBe(FINANCED);
    expect(m0.propertyValuesCents.house1).toBe(PRICE);
    expect(m0.netWorthNominalCents).toBe(10_000_000);
  });

  it("appreciates the property value at the base inflation rate by default", () => {
    const base = baseWith(10_000_000, 0.12); // 12%/yr inflation
    const ledger = addWithBase(emptyLedger, base, purchase({ month: 1 }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.months[1].propertyValuesCents.house1).toBe(PRICE);
    // 12 months of monthly compounding ≈ one year of 12% growth.
    const afterOneYear = series.months[13].propertyValuesCents.house1;
    expect(afterOneYear).toBeGreaterThan(PRICE);
    expect(afterOneYear).toBeCloseTo(PRICE * 1.12, -2);
  });

  it("honors an explicit appreciationMode (fixed → flat value)", () => {
    const base = baseWith(10_000_000, 0.12);
    const ledger = addWithBase(
      emptyLedger,
      base,
      purchase({ month: 1, appreciationMode: { type: "fixed" } } as Partial<NewLifeEvent>),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.months[13].propertyValuesCents.house1).toBe(PRICE);
  });

  it("supports multiple coexisting properties", () => {
    const base = baseWith(20_000_000);
    let ledger = addWithBase(emptyLedger, base, purchase({ month: 1 }));
    ledger = addWithBase(ledger, base, {
      ...(purchase({ month: 2 }) as object),
      id: "buy2",
      propertyId: "house2",
    } as NewLifeEvent);
    const household = interpretLedger(ledger, base);
    expect(household.properties.map((p) => p.id).sort()).toEqual(["house1", "house2"]);
  });
});

describe("removeEvent — a financed home purchase", () => {
  it("removing the purchase drops its derived mortgage — the two share one life", () => {
    // The mortgage is a dependent artifact minted from this event, not a separate ledger event.
    // Deleting the purchase re-interprets a ledger without it, so nothing re-derives the mortgage
    // and the liability vanishes — no orphan left behind.
    const base = baseWith(10_000_000);
    const ledger = addFinanced(emptyLedger, base);
    // One event only: a financed purchase no longer splits into a purchase plus a loan.
    expect(ledger.events).toHaveLength(1);
    const result = removeEvent(ledger, "buy1", base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const household = interpretLedger(result.ledger, base);
      expect(household.properties).toHaveLength(0);
      expect(household.liabilities).toHaveLength(0);
    }
  });

  it("blocks the delete when a payoff still targets the derived mortgage", () => {
    // A DebtPayoffEvent aimed at `house1-mortgage` outlives the purchase only if the purchase does.
    // Removing the purchase drops the mortgage, so the payoff strands on replay ("liability not
    // found for payoff") and Strategy A refuses the removal, naming the offending event.
    const base = baseWith(10_000_000);
    const ledger = addWithBase(addFinanced(emptyLedger, base), base, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      liabilityId: MORTGAGE_ID,
      accountId: "savings",
      amountCents: 1_000_000,
    } as NewLifeEvent);
    const result = removeEvent(ledger, "buy1", base);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("payoff1");
      expect(result.conflict).toMatch(/liability "house1-mortgage" not found for payoff/);
    }
  });
});

/** The property half of a HOLDING — a pre-existing home dated at the now marker, opening at its
 * current value with no down payment. Owned outright unless a `mortgage` override is added. */
function holding(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return purchase({
    month: PRE_NOW_MONTH,
    downPaymentCents: 0,
    downPaymentSourceIds: [],
    ...overrides,
  });
}

describe("HomePurchaseEvent — mortgage liability id collision", () => {
  // The embedded mortgage's liability id is AUTHORED (minted off the same counter every other id
  // draws from), not derived at interpret time — but authoring cannot stop a hand-edited or
  // imported ledger from handing a standalone LoanEvent that exact id. `liabilitiesById` is a
  // plain Map: without an explicit guard, whichever event lands second silently overwrites the
  // first rather than failing. Every case below asserts the collision is refused explicitly, in
  // both possible orderings, at both the authoring and the import gates.

  it("still creates and links a normal, non-colliding financed purchase's mortgage", () => {
    // The invariant added here must not disturb the ordinary path.
    const base = baseWith(10_000_000);
    const ledger = addFinanced(emptyLedger, base);
    const household = interpretLedger(ledger, base);
    expect(household.properties[0].mortgageLiabilityId).toBe(MORTGAGE_ID);
    expect(household.liabilities.map((l) => l.id)).toEqual([MORTGAGE_ID]);
  });

  it("rejects the purchase when its authored mortgage id collides with an EARLIER standalone loan", () => {
    // Loan authored first, taking the id the purchase's mortgage is (separately) authored to; the
    // purchase must then be refused rather than silently overwriting the standalone loan.
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, loanEvent({ liabilityId: MORTGAGE_ID, month: 1 }));
    const result = addEvent(
      ledger,
      base,
      purchase({
        month: 3,
        mortgage: { liabilityId: MORTGAGE_ID, openingBalanceCents: FINANCED, apr: 0, termMonths: 360 },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain(MORTGAGE_ID);
      expect(result.conflict).toMatch(/already exists/);
    }
  });

  it("rejects a LATER standalone loan authored against an EARLIER purchase's mortgage id", () => {
    // The mirror ordering: the purchase materializes its mortgage first, so the standalone loan's
    // own "liability already exists" precondition is what refuses it — same outcome, other handler.
    const base = baseWith(10_000_000);
    const ledger = addFinanced(emptyLedger, base);
    const result = addEvent(
      ledger,
      base,
      loanEvent({ liabilityId: MORTGAGE_ID, month: 6 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain(MORTGAGE_ID);
      expect(result.conflict).toMatch(/already exists/);
    }
  });

  it("refuses to import a ledger whose loan-before-purchase collision was never authored through the gate", () => {
    // Bypassing `addEvent` entirely, a raw ledger carries a standalone loan and a colliding
    // financed purchase, loan first. `validateLedger` — the restore/import entry point — replays
    // in (month, sequenceNumber) order and must refuse rather than let the purchase's mortgage
    // silently replace the loan in `liabilitiesById`.
    const base = baseWith(10_000_000);
    const ledger: Ledger = {
      events: [
        { ...loanEvent({ liabilityId: MORTGAGE_ID, month: 1 }), sequenceNumber: 1 },
        {
          ...purchase({
            month: 3,
            mortgage: { liabilityId: MORTGAGE_ID, openingBalanceCents: FINANCED, apr: 0, termMonths: 360 },
          }),
          sequenceNumber: 2,
        },
      ] as unknown as Ledger["events"],
      nextSequenceNumber: 3,
    };
    const result = validateLedger(ledger, base);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.event.id).toBe("buy1");
      expect(result.reason).toContain(MORTGAGE_ID);
      expect(result.reason).toMatch(/already exists/);
    }
  });

  it("refuses to import a ledger whose purchase-before-loan collision was never authored through the gate", () => {
    // Same fixture, reversed sequence: the purchase materializes its mortgage first, so the loan
    // is what strands on replay — the other ordering `validateLedger` must also catch.
    const base = baseWith(10_000_000);
    const ledger: Ledger = {
      events: [
        {
          ...purchase({
            month: 1,
            mortgage: { liabilityId: MORTGAGE_ID, openingBalanceCents: FINANCED, apr: 0, termMonths: 360 },
          }),
          sequenceNumber: 1,
        },
        { ...loanEvent({ liabilityId: MORTGAGE_ID, month: 3 }), sequenceNumber: 2 },
      ] as unknown as Ledger["events"],
      nextSequenceNumber: 3,
    };
    const result = validateLedger(ledger, base);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.event.id).toBe("loan1");
      expect(result.reason).toContain(MORTGAGE_ID);
      expect(result.reason).toMatch(/already exists/);
    }
  });
});

describe("HomePurchaseEvent — a holding (a home already owned at start)", () => {
  it("opens the property at its value with no down-payment draw, drawing on no source", () => {
    // A near-empty account: a holding names no source and drains nothing, so the purchase stands
    // where a same-priced transaction would be hard-blocked for want of funds.
    const base = baseWith(100_000);
    const ledger = addWithBase(emptyLedger, base, holding());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // On the books at "now": the property opens at its full value and savings is untouched.
    expect(series.opening.propertyValuesCents.house1).toBe(PRICE);
    expect(series.opening.accountBalancesCents.savings).toBe(100_000);
    expect(series.months[0].accountBalancesCents.savings).toBe(100_000);
  });

  it("carries acquiredMonth and originalPriceCents without touching the opening value", () => {
    const base = baseWith(100_000);
    const ledger = addWithBase(
      emptyLedger,
      base,
      holding({ acquiredMonth: -96, originalPriceCents: 20_000_000 }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    // Behavior-free: the basis metadata is recorded but the property still opens at CURRENT value.
    expect(series.opening.propertyValuesCents.house1).toBe(PRICE);
  });

  it("rejects a property holding dated at a negative month other than the now marker", () => {
    // Anchors (marriage, birth) sit at any true past month, but a holding opens at CURRENT terms,
    // so its only valid pre-now date is the now marker — a `-5` would ask the sim to reconstruct
    // an origination it deliberately does not model.
    const base = baseWith(10_000_000);
    const result = addEvent(emptyLedger, base, holding({ month: -5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/now marker/);
  });

  it("rejects a loan holding dated at a negative month other than the now marker", () => {
    const base = baseWith(10_000_000);
    const result = addEvent(emptyLedger, base, loanEvent({ month: -5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/now marker/);
  });

  it("rejects a mis-dated holding on import, so a hand-edited ledger cannot smuggle one in", () => {
    // Bypassing the authoring methods, a raw ledger carries the property at `-5`; the import gate
    // replays each event's precondition and strands here.
    const base = baseWith(10_000_000);
    const ledger: Ledger = {
      events: [{ ...holding({ month: -5 }), sequenceNumber: 1 } as unknown as Ledger["events"][number]],
      nextSequenceNumber: 2,
    };
    const result = validateLedger(ledger, base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/now marker/);
  });
});

describe("HomePurchaseEvent — a purchase stranded by a later edit blocks the projection", () => {
  // The epic's core bug: an affordable purchase becomes unfundable after it was authored — the
  // gate never re-runs on the stranded event, so only the simulator can catch it. It must stop,
  // not fabricate the home. Reproduced by draining the down-payment source with an earlier cash
  // purchase authored AFTER the financed one, so neither trips the append-time gate.
  it("originates no property, mortgage, or drained cash for the stranded purchase", () => {
    const base = baseWith(10_000_000); // $100k liquid savings

    // A financed home at month 3 needing a $60k down payment — affordable when authored.
    const withFinanced = addFinanced(emptyLedger, base);
    // Then a $70k cash home at month 1 that drains savings to $30k — still affordable at month 1,
    // and it does not re-litigate the month-3 purchase.
    const ledger = addWithBase(
      withFinanced,
      base,
      purchase({
        id: "buy0",
        propertyId: "house0",
        month: 1,
        purchasePriceCents: 7_000_000,
        downPaymentCents: 7_000_000,
        downPaymentSourceIds: ["savings"],
      }),
    );

    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // The month-3 purchase now falls $30k short of its $60k down payment: the projection stops.
    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(3);
    expect(series.blockingObligation?.sourceEventId).toBe("buy1");
    expect(series.blockingObligation?.shortfallCents).toBe(3_000_000);
    expect(series.months).toHaveLength(4);

    const blocked = series.months[3];
    // No fictional equity: neither the home nor its mortgage originate.
    expect(blocked.propertyValuesCents.house1 ?? 0).toBe(0);
    expect(blocked.liabilityBalancesCents["house1-mortgage"] ?? 0).toBe(0);
    // The affordable cash home DID execute — blocking is scoped to the one stranded purchase.
    expect(blocked.propertyValuesCents.house0).toBe(7_000_000);
    // Savings retains the $30k the stranded draw never took.
    expect(blocked.accountBalancesCents.savings).toBe(3_000_000);
    // Net worth is exactly the genuine $100k: $30k cash + $70k cash home, no minted equity.
    expect(blocked.netWorthNominalCents).toBe(10_000_000);
  });

  // A block stops funding resolution for the WHOLE month, so a second purchase sharing that month
  // never draws its down payment either. Its home and mortgage are created by a step separate from
  // that draw, so suppressing only the blocking event let the second purchase through unfunded —
  // exactly the fabrication blocking exists to stop, just one event further along.
  it("originates nothing for a LATER same-month purchase whose draw the block skipped", () => {
    const base = baseWith(10_000_000); // $100k liquid savings

    // Two financed homes at month 3, each with a $60k down payment. Both are affordable when
    // authored: the first leaves $40k, and the second is gated against that remainder... so author
    // the second cheaply enough to pass, at a $30k down payment.
    const withFirst = addFinanced(emptyLedger, base);
    const withSecond = addWithBase(
      withFirst,
      base,
      purchase({
        id: "buy2",
        propertyId: "house2",
        month: 3,
        purchasePriceCents: 30_000_000,
        downPaymentCents: 3_000_000,
        mortgage: { liabilityId: "house2-mortgage", openingBalanceCents: 27_000_000, apr: 0, termMonths: 360 },
      }),
    );
    // Then a $70k cash home at month 1 drains savings to $30k, stranding the month-3 pair. Authored
    // last and dated earlier, so it re-litigates neither.
    const ledger = addWithBase(
      withSecond,
      base,
      purchase({
        id: "buy0",
        propertyId: "house0",
        month: 1,
        purchasePriceCents: 7_000_000,
        downPaymentCents: 7_000_000,
        downPaymentSourceIds: ["savings"],
      }),
    );

    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(3);
    // Reporting still names the FIRST purchase and its own gap — the second was never priced.
    expect(series.blockingObligation?.sourceEventId).toBe("buy1");
    expect(series.blockingObligation?.shortfallCents).toBe(3_000_000);
    // Both events are reported omitted, so both had their artifacts suppressed.
    expect(series.omittedSourceEventIds).toEqual(["buy1", "buy2"]);

    const blocked = series.months[3];
    // NEITHER down payment was withdrawn: savings holds the whole $30k the cash home left.
    expect(blocked.accountBalancesCents.savings).toBe(3_000_000);
    // NEITHER property was created.
    expect(blocked.propertyValuesCents.house1 ?? 0).toBe(0);
    expect(blocked.propertyValuesCents.house2 ?? 0).toBe(0);
    // NEITHER mortgage was originated.
    expect(blocked.liabilityBalancesCents["house1-mortgage"] ?? 0).toBe(0);
    expect(blocked.liabilityBalancesCents["house2-mortgage"] ?? 0).toBe(0);
    // The month-1 cash home still stands, and net worth is the genuine $100k.
    expect(blocked.propertyValuesCents.house0).toBe(7_000_000);
    expect(blocked.netWorthNominalCents).toBe(10_000_000);
  });
});
