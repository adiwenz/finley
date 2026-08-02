import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger/ledger";
import { addEvent, fundingLookup } from "./ledger/addEvent";
import { interpretLedger } from "./ledger/interpret";
import { buildProjection } from "./projection/buildHouseholdInput";
import { removeEvent } from "./ledger/removeEvent";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import type { NewLifeEvent } from "./ledger/eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import { SimCashFlowSeries, dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "./planAccount";
import type { PersonId } from "./job";
import { PRE_NOW_MONTH } from "./projection/nowMarker";
import { validateLedger } from "./ledger/validateLedger";
import { SYNTHETIC_CARD_ID } from "./liability";

function savings(openingCents: number, rate = 0): PlanAccount {
  return planAccount({
    id: "savings",
    owners: ["p1" as PersonId],
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: rate,
  });
}

function baseWith(openingCents: number, inflation = 0): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: inflation,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [savings(openingCents)],
  };
}

const PRICE = 30_000_000; // $300k
const DOWN = 6_000_000; // $60k
const FINANCED = PRICE - DOWN; // $240k

/**
 * The property half of a purchase — a slimmed `HomePurchaseEvent` that acquires the home and
 * drains the down payment. Financing is a separate `LoanEvent` ({@link mortgage}); a bare
 * `purchase()` is a cash acquisition (no `securedByLiabilityId`), which the down-payment gate
 * scrutinises identically since the gate never depends on the mortgage.
 */
function purchase(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "buy1",
    type: "HomePurchaseEvent",
    month: 3,
    propertyId: "house1",
    ownerId: "p1",
    purchasePriceCents: PRICE,
    downPaymentCents: DOWN,
    downPaymentSourceIds: ["savings"],
    ...overrides,
  } as NewLifeEvent;
}

/** The financing mortgage a purchase names — a `LoanEvent` the property secures against. */
function mortgage(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "mtg1",
    type: "LoanEvent",
    month: 3,
    liabilityId: "mtg1",
    ownerId: "p1",
    kind: "mortgage",
    openingBalanceCents: FINANCED,
    apr: 0,
    termMonths: 360,
    ...overrides,
  } as NewLifeEvent;
}

/** Appends a fixture, asserting it passes. */
function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

/**
 * Append a financed purchase the way `buyHome` composes one: the mortgage first (so it replays
 * before the home, whose precondition needs it present), then the property securing it at the
 * same month. The financed balance follows the price/down overrides.
 */
function addFinanced(
  ledger: Ledger,
  base: LedgerBaseConfig,
  homeOverrides: Partial<NewLifeEvent> = {},
): Ledger {
  const o = homeOverrides as { month?: number; purchasePriceCents?: number; downPaymentCents?: number };
  const month = o.month ?? 3;
  const financed = (o.purchasePriceCents ?? PRICE) - (o.downPaymentCents ?? DOWN);
  const withMortgage = addWithBase(ledger, base, mortgage({ month, openingBalanceCents: financed }));
  return addWithBase(withMortgage, base, purchase({ ...homeOverrides, securedByLiabilityId: "mtg1" }));
}

describe("HomePurchaseEvent", () => {
  it("creates a property, its mortgage, and a down-payment outflow", () => {
    const base = baseWith(10_000_000); // $100k liquid
    const ledger = addFinanced(emptyLedger, base);
    const household = interpretLedger(ledger, base);

    expect(household.properties).toHaveLength(1);
    expect(household.properties[0].id).toBe("house1");
    expect(household.properties[0].openingValueCents).toBe(PRICE);
    expect(household.properties[0].mortgageLiabilityId).toBe("mtg1");

    expect(household.liabilities).toHaveLength(1);
    expect(household.liabilities[0].id).toBe("mtg1");
    expect(household.liabilities[0].kind).toBe("mortgage");
    expect(household.liabilities[0].openingBalanceCents).toBe(FINANCED);
  });

  it("rejects a purchase whose securing liability has not been minted", () => {
    // The link is referential: naming a liability no prior event created is a dangling pointer,
    // caught the same way `debtPayoff` catches a missing liability.
    const base = baseWith(10_000_000);
    const result = addEvent(emptyLedger, base, purchase({ securedByLiabilityId: "ghost" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/securing liability "ghost" not found/);
  });

  it("requires the mortgage to be ordered before the property it secures", () => {
    // Same-month events replay in append order, so the mortgage appended second would replay
    // second and the property would strand — the ordering the precondition enforces.
    const base = baseWith(10_000_000);
    const outOfOrder = addEvent(emptyLedger, base, purchase({ securedByLiabilityId: "mtg1" }));
    expect(outOfOrder.ok).toBe(false);

    // Loan first, then the property: accepted.
    const inOrder = addFinanced(emptyLedger, base);
    expect(interpretLedger(inOrder, base).properties[0].mortgageLiabilityId).toBe("mtg1");
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
    expect(m3.liabilityBalancesCents.mtg1).toBe(FINANCED);
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
    expect(m0.liabilityBalancesCents.mtg1).toBe(FINANCED);
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

describe("HomePurchaseEvent — down-payment hard block", () => {
  it("blocks the purchase when liquid funds cannot cover the down payment", () => {
    const base = baseWith(5_000_000); // $50k < $60k down
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/down payment/);
  });

  it("allows the purchase when liquid funds cover the down payment", () => {
    const base = baseWith(6_000_000); // exactly $60k
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(true);
  });

  it("hard-blocks on any shortfall — one cent short still fails the gate", () => {
    const base = baseWith(DOWN - 1);
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
  });

  it("quotes dollars, not raw cents, and says why other balances don't count", () => {
    const base = baseWith(5_000_000);
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("$60,000");
      expect(result.conflict).toContain("$50,000");
      expect(result.conflict).not.toMatch(/¢|\d{7}/);
      expect(result.conflict).toMatch(/goal funds|retirement|brokerage/);
    }
  });

  it("never counts credit as a down-payment source", () => {
    const base = baseWith(5_000_000);
    // Credit is not liquid.
    const withCard = addWithBase(emptyLedger, base, {
      id: "card",
      type: "LoanEvent",
      month: 0,
      liabilityId: "cc1",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0.2,
      creditLimitCents: 50_000_000,
    } as NewLifeEvent);
    const result = addEvent(withCard, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
  });
});

// §4.5 gate: a goal held as cash lands in a liquid account, so the gate counts it and the
// block message must name the buckets it counted.

function goalFund(id: string, label: string, openingCents: number, liquid: boolean): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    label,
    liquid,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

function baseWithGoalFund(
  savingsCents: number,
  goal: { label: string; cents: number; liquid: boolean },
): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [savings(savingsCents), goalFund("goal-emergency", goal.label, goal.cents, goal.liquid)],
  };
}

const BOTH_SOURCES = ["savings", "goal-emergency"];

describe("HomePurchaseEvent — §4.5 gate counts selected liquid goal funds", () => {
  it("lets a selected liquid emergency reserve cover the gap savings alone cannot", () => {
    // $30k savings + $40k cash emergency fund = $70k liquid ≥ $60k down, both selected.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 4_000_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(true);
  });

  it("names the selected goal buckets it counted when the gate still blocks", () => {
    // $30k savings + $20k cash emergency fund = $50k liquid < $60k down.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 2_000_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("Emergency fund");
      expect(result.conflict).toContain("$50,000"); // the counted selected total
    }
  });

  it("still excludes an illiquid goal fund even when it is selected", () => {
    // The illiquid fund contributes 0: only $30k of the selected $70k counts.
    const base = baseWithGoalFund(3_000_000, {
      label: "Retirement top-up",
      cents: 4_000_000,
      liquid: false,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
  });

  it("falls back to the account id when a counted bucket has an empty label", () => {
    // $30k + $15k = $45k < $60k, so the gate blocks and lists both.
    const base = baseWithGoalFund(3_000_000, { label: "", cents: 1_500_000, liquid: true });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("goal-emergency ($15,000)");
      expect(result.conflict).not.toContain("()");
    }
  });

  it("states a total that equals the sum of the buckets it lists", () => {
    // $30k + $15k = $45k: the stated total derives from the buckets it itemises.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 1_500_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("$45,000"); // the stated total
      expect(result.conflict).toContain("savings ($30,000)");
      expect(result.conflict).toContain("Emergency fund ($15,000)");
    }
  });
});

describe("removeEvent — a decomposed home purchase", () => {
  it("removing the property leaves the standalone mortgage — 'sold the house, still owe'", () => {
    // The property names its mortgage, not the reverse, so there is no causedBy edge to pull the
    // loan out with the home. The mortgage is a plain liability that outlives the house.
    const base = baseWith(10_000_000);
    const ledger = addFinanced(emptyLedger, base);
    const result = removeEvent(ledger, "buy1", base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const household = interpretLedger(result.ledger, base);
      expect(household.properties).toHaveLength(0);
      expect(household.liabilities.map((l) => l.id)).toEqual(["mtg1"]);
    }
  });

  it("blocks removing the mortgage while the property still names it", () => {
    // The property's precondition strands on replay: removing the loan the house is secured by
    // would leave a dangling reference, so the removal is refused and names the offending event.
    const base = baseWith(10_000_000);
    const ledger = addFinanced(emptyLedger, base);
    const result = removeEvent(ledger, "mtg1", base);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("buy1");
      expect(result.conflict).toMatch(/securing liability "mtg1" not found/);
    }
  });
});

/** The property half of a HOLDING — a pre-existing home dated at the now marker, opening at its
 * current value with no down payment. Owned outright unless a `securedByLiabilityId` is added. */
function holding(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return purchase({
    month: PRE_NOW_MONTH,
    downPaymentCents: 0,
    downPaymentSourceIds: [],
    ...overrides,
  });
}

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
    const result = addEvent(emptyLedger, base, mortgage({ month: -5 }));
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

// Sources drain in order, each taken to zero before the next is touched; each gets its own outflow.

function liquidAcct(id: string, openingCents: number, rate = 0, label?: string): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    ...(label !== undefined ? { label } : {}),
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: rate,
  });
}

function baseWithAccounts(accounts: PlanAccount[], inflation = 0): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: inflation,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: accounts,
  };
}

describe("HomePurchaseEvent — ordered multi-source down payment", () => {
  it("drains sources in order: the first empties before the second is touched", () => {
    // $40k savings + $40k brokerage, $60k down, ordered [savings, brokerage].
    const base = baseWithAccounts([
      liquidAcct("savings", 4_000_000),
      liquidAcct("brokerage", 4_000_000),
    ]);
    const ledger = addFinanced(emptyLedger, base, {
      month: 3,
      downPaymentSourceIds: ["savings", "brokerage"],
    });
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.months[2].accountBalancesCents.savings).toBe(4_000_000);
    expect(series.months[2].accountBalancesCents.brokerage).toBe(4_000_000);
    const netBefore = series.months[2].netWorthNominalCents;

    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(0);
    expect(m3.accountBalancesCents.brokerage).toBe(2_000_000);
    // Net worth conserved: the draws sum to the down payment.
    expect(m3.netWorthNominalCents).toBe(netBefore);
  });

  it("respects the drain order — reversing the sources reverses which one empties", () => {
    const base = baseWithAccounts([
      liquidAcct("savings", 4_000_000),
      liquidAcct("brokerage", 4_000_000),
    ]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      purchase({ month: 3, downPaymentSourceIds: ["brokerage", "savings"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.brokerage).toBe(0);
    expect(m3.accountBalancesCents.savings).toBe(2_000_000);
  });

  it("hard-blocks a multi-source shortfall, naming every selected source and the total", () => {
    // Combined selected balance $50k < $60k down, so the gate blocks and itemises both.
    const base = baseWithAccounts([
      liquidAcct("savings", 3_000_000),
      liquidAcct("brokerage", 2_000_000, 0, "Brokerage"),
    ]);
    const result = addEvent(
      emptyLedger,
      base,
      purchase({ month: 1, downPaymentSourceIds: ["savings", "brokerage"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("$60,000"); // the down payment
      expect(result.conflict).toContain("$50,000"); // combined selected balance
      expect(result.conflict).toContain("savings ($30,000)");
      expect(result.conflict).toContain("Brokerage ($20,000)");
    }
  });
});

// A draw surfaces in the flow view: a cash source's whole draw as savings drawdown; an
// investment source's realized gain as capital gains, its principal as drawdown.

describe("HomePurchaseEvent — down-payment draw reporting", () => {
  it("reports a cash-funded draw as a savings drawdown, with no capital gain", () => {
    // 0% growth → basis == balance, no embedded gain.
    const base = baseWithAccounts([liquidAcct("savings", 8_000_000)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      purchase({ month: 3, downPaymentSourceIds: ["savings"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const flows = series.months[3].flows;
    expect(flows).toBeDefined();

    const drawdown = flows!.incomeSources.find((s) => s.category === "savingsDrawdown");
    expect(drawdown?.cashInflowCents).toBe(DOWN);
    expect(flows!.incomeSources.some((s) => s.category === "capitalGains")).toBe(false);
    // A drawdown is spending an asset, not income.
    expect(flows!.incomeByCategoryCents.capitalGains ?? 0).toBe(0);
  });

  it("splits an investment-funded draw into capital-gains income and returned principal", () => {
    // A brokerage grown 12 months at 12%/yr carries an embedded gain over its $50k basis.
    const base = baseWithAccounts([liquidAcct("brokerage", 5_000_000, 0.12)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      purchase({
        month: 12,
        purchasePriceCents: 20_000_000,
        downPaymentCents: 4_000_000,
        downPaymentSourceIds: ["brokerage"],
      }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // The draw runs before month 12 compounds, so it sees the end-of-month-11 balance.
    const balanceAtDraw = series.months[11].accountBalancesCents.brokerage;
    const basis = 5_000_000;
    const expectedPrincipal = Math.round(4_000_000 * (basis / balanceAtDraw));
    const expectedGain = 4_000_000 - expectedPrincipal;
    expect(expectedGain).toBeGreaterThan(0); // there genuinely is an embedded gain

    const flows = series.months[12].flows;
    expect(flows).toBeDefined();
    const gainBand = flows!.incomeSources.find((s) => s.sourceId === "downpayment:brokerage");
    expect(gainBand?.category).toBe("capitalGains");
    expect(gainBand?.cashInflowCents).toBe(expectedGain);

    const drawdown = flows!.incomeSources.find((s) => s.category === "savingsDrawdown");
    expect(drawdown?.cashInflowCents).toBe(expectedPrincipal);

    // Conserved: the two bands sum to the whole draw.
    expect((gainBand?.cashInflowCents ?? 0) + (drawdown?.cashInflowCents ?? 0)).toBe(4_000_000);
    expect(flows!.incomeByCategoryCents.capitalGains).toBe(expectedGain);
  });
});

// Liquidating an appreciated source realizes a taxable gain: the draw grosses up over the tax,
// and the §4.5 gate sizes on the down payment PLUS the tax.

/** Taxes `capitalGains` at `rate`, basis returned pro-rata. Monotone, as the gross-up requires. */
function flatCapitalGains(rate: number): Jurisdiction {
  return {
    id: "test-capital-gains",
    computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * rate),
    computeTaxByCategoryCents: (byCat) => {
      const tax = Math.round((byCat.capitalGains ?? 0) * rate);
      return tax > 0 ? { capitalGains: tax } : {};
    },
    taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) => {
      const basisFraction = balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0;
      return grossCents - Math.round(grossCents * basisFraction); // the gain over basis
    },
  };
}

/**
 * A gain stacked on ordinary income: untaxed up to `thresholdCents`, taxed at `rate` above, so
 * its tax depends on the owner's OTHER income. Ordinary income is untaxed, to isolate the gain.
 */
function bracketedCapitalGains(thresholdCents: number, rate: number): Jurisdiction {
  const gainTaxCents = (byCat: Partial<Record<string, number>>): number => {
    const ordinary = byCat.ordinaryIncome ?? 0;
    const gains = byCat.capitalGains ?? 0;
    // The slice of `gains` sitting above the threshold once stacked on ordinary income.
    const taxable =
      Math.max(0, ordinary + gains - thresholdCents) - Math.max(0, ordinary - thresholdCents);
    return Math.round(Math.max(0, taxable) * rate);
  };
  return {
    id: "test-bracketed-capital-gains",
    computeTaxCents: gainTaxCents,
    computeTaxByCategoryCents: (byCat) => {
      const tax = gainTaxCents(byCat);
      return tax > 0 ? { capitalGains: tax } : {};
    },
    taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) => {
      const basisFraction = balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0;
      return grossCents - Math.round(grossCents * basisFraction);
    },
  };
}

// Explicit obligations resolve BEFORE the automatic waterfall, so a down-payment draw sells its
// sources first and decumulation sizes its liquidation against the balances left behind. When
// both compete for one account, the draw takes its share first and the automatic resolver can be
// starved — falling short spills to the credit cascade rather than pre-empting the purchase.

describe("HomePurchaseEvent — explicit draw resolves before automatic decumulation", () => {
  // `cash` is the liquid sink (first liquid account), left empty so it holds no buffer;
  // `brokerage` funds both the down payment and any decumulation. A $30k/mo obligation with no
  // income forces a $30k decumulation gap every month.
  function baseWithExpense(): LedgerBaseConfig {
    return {
      horizonMonths: 3,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [liquidAcct("cash", 0), liquidAcct("brokerage", 6_000_000)],
      initialExpenseSeries: [
        {
          series: new SimCashFlowSeries(0, dollarsToCents(30_000), { type: "fixed" }, { baselineUnit: "monthly" }),
          ownerId: "p1" as PersonId,
        },
      ],
    };
  }

  it("spills the automatic obligation to credit once the draw takes the account first", () => {
    // $60k brokerage, $40k down payment at month 0, $30k automatic obligation. Explicit first:
    // the draw takes its $40k, leaving $20k — decumulation covers only $20k of its $30k gap, so
    // the remaining $10k of groceries is financed on the synthetic card. Were the automatic
    // resolver to run first it would fund the whole $30k from the untouched $60k and borrow
    // nothing; the down payment would fall short instead. The credit balance is the proof of
    // order: it exists ONLY because the explicit draw resolved ahead of decumulation.
    const base = baseWithExpense();
    const ledger = addWithBase(emptyLedger, base, purchase({ month: 0, downPaymentCents: 4_000_000, downPaymentSourceIds: ["brokerage"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // The draw delivered in full: brokerage drained to zero.
    expect(series.months[0].accountBalancesCents.brokerage).toBe(0);
    // The $10k decumulation could no longer cover, financed on the cascade card — the borrowed
    // principal plus one month of its interest, so at least $10k and under $10.5k.
    const financed = series.months[0].liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0;
    expect(financed).toBeGreaterThanOrEqual(1_000_000);
    expect(financed).toBeLessThan(1_050_000);
  });

  it("borrows nothing for the same obligation when no draw competes for the account", () => {
    // The control: the $30k obligation alone draws $30k from the untouched $60k brokerage and
    // finances nothing — so the borrowing above is the draw's doing, not the obligation's size.
    const base = baseWithExpense();
    const series = buildProjection(interpretLedger(emptyLedger, base), base, nullJurisdiction);
    expect(series.months[0].liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBe(0);
  });
});

describe("HomePurchaseEvent — investment-funded down payment is taxed", () => {
  it("grosses up the draw and drops net worth by the capital-gains tax it pays", () => {
    // An otherwise-identical no-tax run isolates the tax from the month's growth.
    const base = baseWithAccounts([liquidAcct("brokerage", 8_000_000, 0.12)]);
    const ledger = addFinanced(emptyLedger, base, { month: 12, downPaymentSourceIds: ["brokerage"] });
    const household = interpretLedger(ledger, base);
    const taxed = buildProjection(household, base, flatCapitalGains(0.2));
    const untaxed = buildProjection(household, base, nullJurisdiction);

    const at = taxed.months[12];
    expect(at.flows!.taxCents).toBeGreaterThan(0);
    expect(at.netWorthNominalCents!).toBeLessThan(untaxed.months[12].netWorthNominalCents!);
    // Grossed up: taxation drained more than the bare down payment.
    expect(at.accountBalancesCents.brokerage).toBeLessThan(
      untaxed.months[12].accountBalancesCents.brokerage,
    );
    // The tax is the household's loss, not the home's: equity is still price − financed.
    expect(at.propertyValuesCents.house1).toBe(PRICE);
    expect(at.liabilityBalancesCents.mtg1).toBe(FINANCED);
  });

  it("conserves net worth for a cash-funded down payment (no gain → no tax)", () => {
    // basis == balance → no embedded gain.
    const base = baseWithAccounts([liquidAcct("savings", 10_000_000, 0)]);
    const ledger = addFinanced(emptyLedger, base, { month: 3, downPaymentSourceIds: ["savings"] });
    const series = buildProjection(interpretLedger(ledger, base), base, flatCapitalGains(0.2));
    const at = series.months[3];
    expect(at.flows!.taxCents).toBe(0);
    expect(at.netWorthNominalCents).toBe(series.months[2].netWorthNominalCents);
    expect(at.accountBalancesCents.savings).toBe(10_000_000 - DOWN);
  });

  it("reports the gain as capital-gains income taxed at the jurisdiction's rate", () => {
    const base = baseWithAccounts([liquidAcct("brokerage", 8_000_000, 0.12)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      purchase({ month: 12, downPaymentSourceIds: ["brokerage"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, flatCapitalGains(0.2));
    const flows = series.months[12].flows!;
    const gainBand = flows.incomeSources.find((s) => s.sourceId === "downpayment:brokerage");
    expect(gainBand?.category).toBe("capitalGains");
    expect(gainBand!.cashInflowCents).toBeGreaterThan(0);
    expect(flows.incomeSources.some((s) => s.category === "savingsDrawdown")).toBe(true);
    expect(flows.taxCents).toBe(Math.round(gainBand!.cashInflowCents * 0.2));
  });
});

describe("HomePurchaseEvent — §4.5 gate sizes on down payment + tax", () => {
  it("blocks when a selected investment source covers the down payment but not the tax on it", () => {
    // $50k basis grown 24 months at 10%/yr clears $60k pre-tax; the tax on the gain does not.
    const base = baseWithAccounts([liquidAcct("brokerage", 5_000_000, 0.1)]);
    // Allowed with no tax: the block is the tax, not insufficiency.
    const allowed = addEvent(
      emptyLedger,
      base,
      purchase({ month: 24, downPaymentSourceIds: ["brokerage"] }),
      nullJurisdiction,
    );
    expect(allowed.ok).toBe(true);

    const blocked = addEvent(
      emptyLedger,
      base,
      purchase({ month: 24, downPaymentSourceIds: ["brokerage"] }),
      flatCapitalGains(0.2),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.conflict).toMatch(/tax/i);
  });

  it("prices the gain MARGINALLY over the owner's other income, not standalone", () => {
    // Same brokerage, same down payment: affordable with no other income, unaffordable once a
    // wage pushes the gain into the taxed band. Only a gate reading the owner's other income
    // can tell these apart.
    const wage = new SimCashFlowSeries(0, dollarsToCents(15_000), { type: "fixed" }, { baselineUnit: "monthly" });
    const accounts = () => [liquidAcct("savings", 0), liquidAcct("brokerage", 5_000_000, 0.1)];
    const jur = bracketedCapitalGains(dollarsToCents(15_000), 0.4); // $15k/mo threshold, 40% above

    const withoutWage: LedgerBaseConfig = {
      horizonMonths: 24,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: accounts(),
    };
    const withWage: LedgerBaseConfig = {
      ...withoutWage,
      initialAccounts: accounts(),
      initialIncomeSeries: [{ series: wage, ownerId: "p1" }],
    };
    const buy = purchase({ month: 24, downPaymentSourceIds: ["brokerage"] });

    // No other income: the ~$10k gain sits below the $15k threshold → untaxed → affordable.
    expect(addEvent(emptyLedger, withoutWage, buy, jur).ok).toBe(true);
    // The wage stacks the gain above the threshold → taxed → proceeds no longer cover it.
    const blocked = addEvent(emptyLedger, withWage, buy, jur);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.conflict).toMatch(/tax/i);
  });
});

// §4.5 gate, sibling draws: the sim threads one working base across a month's draws, stacking
// the first's realized gain under the second. The gate must price a candidate over that stacked
// base, not the pre-funding one.

describe("HomePurchaseEvent — §4.5 gate stacks a sibling draw in the same month", () => {
  // Each brokerage: $50k basis grown 24 months at 10%/yr → ~$60,021, a ~$10,021 gain. Alone it
  // sits under the $15k threshold, untaxed, exactly covering the $60,000 down payment. Purchase
  // at month 23: months[23] holds those 24 flow-months of growth now that month 0 is processed.
  const jurisdiction = () => bracketedCapitalGains(dollarsToCents(15_000), 0.4);
  const twoBrokerages = () =>
    baseWithAccounts([
      liquidAcct("brokerage-a", 5_000_000, 0.1),
      liquidAcct("brokerage-b", 5_000_000, 0.1),
    ]);
  const secondPurchase = purchase({
    id: "buy2",
    month: 23,
    propertyId: "house2",
    downPaymentSourceIds: ["brokerage-b"],
  });

  it("blocks the second purchase, whose gain the first purchase pushes over the threshold", () => {
    const jur = jurisdiction();
    const base = twoBrokerages();
    const first = addEvent(
      emptyLedger,
      base,
      purchase({ month: 23, downPaymentSourceIds: ["brokerage-a"] }),
      jur,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The sim resolves this AFTER its sibling, stacking that ~$10k gain underneath: this gain
    // crosses the threshold and leaves the brokerage short of $60,000.
    const second = addEvent(first.ledger, base, secondPurchase, jur);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.conflict).toMatch(/tax/i);
  });

  it("accepts that same second purchase when it has no sibling (the block IS the stacking)", () => {
    // The control: identical but for the sibling.
    expect(addEvent(emptyLedger, twoBrokerages(), secondPurchase, jurisdiction()).ok).toBe(true);
  });
});

// Sibling explicit draws in one month resolve in EVENT SEQUENCE — the order the events were
// authored (month, then sequence number). `resolveFundingDraws` drains balances in place per
// draw, so each sibling sees what its predecessors left; a second purchase is funded from the
// remainder, never the pre-funding balance. Two events competing for one account cannot both
// spend it in full.

describe("HomePurchaseEvent — sibling explicit draws resolve in event sequence", () => {
  it("funds the second purchase from what the first left in the shared account", () => {
    // A $100k pool `a` plus a $30k spillover `b`, two $60k down payments at month 3, authored
    // first→second. The first takes $60k from `a` (→$40k); the second finds only that $40k left,
    // drains it to zero, and spills its last $20k into `b` (→$10k). Reverse the order and the
    // second — source `a` only — would strand $20k short instead, so this exact end state is the
    // proof the draws resolved in authoring order off a shared, shrinking balance.
    const base = baseWithAccounts([liquidAcct("a", 10_000_000), liquidAcct("b", 3_000_000)]);
    let ledger = addWithBase(emptyLedger, base, purchase({ month: 3, downPaymentSourceIds: ["a"] }));
    ledger = addWithBase(ledger, base, purchase({
      id: "buy2",
      month: 3,
      propertyId: "house2",
      downPaymentSourceIds: ["a", "b"],
    }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];

    expect(m3.accountBalancesCents.a).toBe(0);
    expect(m3.accountBalancesCents.b).toBe(1_000_000);
    expect(m3.propertyValuesCents.house1).toBe(PRICE);
    expect(m3.propertyValuesCents.house2).toBe(PRICE);
  });

  it("gates the second purchase on the first sibling's remainder, not the pre-funding balance", () => {
    // Both purchases draw the SAME account, sized so the two $60k downs fit to the cent ($120k).
    // The second's gate must see the first sibling's $60k already gone — the post-funding balance
    // seam the sim resolves the second against.
    const exact = baseWithAccounts([liquidAcct("a", 12_000_000)]);
    const withFirst = addWithBase(emptyLedger, exact, purchase({ month: 3, downPaymentSourceIds: ["a"] }));
    const second = addEvent(
      withFirst,
      exact,
      purchase({ id: "buy2", month: 3, propertyId: "house2", downPaymentSourceIds: ["a"] }),
    );
    expect(second.ok).toBe(true);

    // One cent short of covering both: the first still funds, but the second is priced on the
    // $59,999 it left and blocked. A gate reading the pre-funding $120k would wrongly accept it —
    // gate == sim on the event-sequence axis.
    const short = baseWithAccounts([liquidAcct("a", 12_000_000 - 1)]);
    const shortWithFirst = addWithBase(emptyLedger, short, purchase({ month: 3, downPaymentSourceIds: ["a"] }));
    const blocked = addEvent(
      shortWithFirst,
      short,
      purchase({ id: "buy2", month: 3, propertyId: "house2", downPaymentSourceIds: ["a"] }),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.conflict).toMatch(/down payment/);
  });
});

describe("HomePurchaseEvent — down-payment obligation ids", () => {
  it("gives two home purchases distinct, stable FinancialObligation ids", () => {
    // Every purchase shares `sourceId: "downpayment"` for report-band namespacing, but each is
    // its own obligation — sharing an `id` too would make the second purchase silently overwrite
    // or collide with the first wherever obligations are keyed by id.
    const base = baseWithAccounts([liquidAcct("a", 20_000_000), liquidAcct("b", 20_000_000)]);
    let ledger = addWithBase(emptyLedger, base, purchase({ month: 3, downPaymentSourceIds: ["a"] }));
    ledger = addWithBase(
      ledger,
      base,
      purchase({ id: "buy2", month: 10, propertyId: "house2", downPaymentSourceIds: ["b"] }),
    );

    const draws = interpretLedger(ledger, base).fundingDraws;
    expect(draws).toHaveLength(2);
    const ids = draws.map((d) => d.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(["draw:downpayment:buy1", "draw:downpayment:buy2"]);
    // `sourceId` stays the shared report-band namespace for both.
    expect(draws.every((d) => d.sourceId === "downpayment")).toBe(true);

    // Stable: re-interpreting the same ledger reproduces the same ids.
    const idsAgain = interpretLedger(ledger, base).fundingDraws.map((d) => d.id);
    expect(idsAgain).toEqual(ids);
  });
});

// gate == sim, the load-bearing invariant: the affordability gate prices a candidate over the
// SAME base the simulator resolves it against, so it blocks exactly when the sim would fall
// short — never wider. Explicit draws now resolve before automatic decumulation, so a
// candidate's marginal context is "after explicit draws, before decumulation": decumulation's
// gains come AFTER it and are none of the candidate's tax. A gate that still read the
// after-decumulation base would stack decumulation's gain under the candidate, over-tax the
// sale, and block a purchase the sim funds in full — this fixture is the guard against that
// regression.

describe("HomePurchaseEvent — §4.5 gate == sim across a decumulation month", () => {
  // The candidate draws `cash` (a $60k buffer, no gain); decumulation draws the appreciated
  // `nest`. The gains-above-$15k jurisdiction taxes `nest`'s liquidation but never the cash
  // draw, so the candidate's shortfall is purely a question of balance — precisely the axis the
  // reorder moved.
  const jur = () => bracketedCapitalGains(dollarsToCents(15_000), 0.4);
  // One decumulation month at the purchase: $150k of expense with no income at month 23 only,
  // so `nest` grows untouched until then and liquidates exactly once, alongside the draw. In the
  // PRE-CANDIDATE projection the gate probes, decumulation would spend the whole $60k `cash`
  // buffer here and liquidate `nest` for the rest — so end-of-month `cash` reads $0. The gate
  // must instead see `cash` as it stands BEFORE decumulation, which is what the candidate (first
  // in resolution order) actually draws from.
  const baseWithLateExpense = (): LedgerBaseConfig => ({
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [liquidAcct("cash", DOWN, 0), liquidAcct("nest", 20_000_000, 0.1)],
    initialExpenseSeries: [
      {
        series: new SimCashFlowSeries(
          23,
          dollarsToCents(150_000),
          { type: "fixed" },
          { baselineUnit: "monthly", endMonth: 23 },
        ),
        ownerId: "p1" as PersonId,
      },
    ],
  });
  const buy = purchase({ month: 23, downPaymentSourceIds: ["cash"] });

  it("accepts a candidate the sim funds in full from a buffer decumulation would otherwise spend", () => {
    const base = baseWithLateExpense();

    // The gate, probing the pre-candidate ledger, prices the $60k down payment against `cash` as
    // it stands BEFORE the month's decumulation — the full $60k buffer — so it predicts zero
    // shortfall and (cash has no gain) zero tax. This is the load-bearing read: end-of-month
    // `cash` is $0 there, and a gate reading it would predict a full $60k shortfall and block.
    const gate = fundingLookup(emptyLedger, base, jur()).availabilityAt(["cash"], DOWN, 23);
    expect(gate.taxCents).toBe(0);
    expect(gate.shortfallCents).toBe(0);

    // The discriminating assertion: the gate accepts, matching the sim below. Read the
    // post-decumulation balance and it would block a purchase the simulator funds in full.
    const accepted = addEvent(emptyLedger, base, buy, jur());
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const series = buildProjection(interpretLedger(accepted.ledger, base), base, jur());
    const at = series.months[23];

    // gate == sim: the candidate resolved FIRST and took the full $60k `cash` buffer, draining
    // it to exactly zero — the shortfall the gate predicted (none) is the shortfall the sim
    // produced (none), and the property was acquired.
    expect(at.accountBalancesCents.cash).toBe(0);
    expect(at.propertyValuesCents.house1).toBe(PRICE);
    // The month genuinely decumulated AND taxed it: the $150k expense forced `nest`'s
    // liquidation, whose gain crossed the $15k threshold — the very decumulation whose balance
    // drain and tax the gate had to keep off the candidate.
    expect(at.flows!.expensesCents).toBe(dollarsToCents(150_000));
    expect(at.flows!.taxCents).toBeGreaterThan(0);
    expect(at.accountBalancesCents.nest).toBeLessThan(series.months[22].accountBalancesCents.nest);
  });
});

// Membership is a property of the account, not the month: every liquid account is listed at
// every month and only `balanceCents` moves. Omitting empty ones let a picker row vanish while
// its id stayed selected.

describe("fundingLookup — the source pool", () => {
  // $40k savings + $40k brokerage, $60k down at month 3: savings empties, brokerage keeps $20k.
  const base = () =>
    baseWithAccounts([liquidAcct("savings", 4_000_000), liquidAcct("brokerage", 4_000_000)]);
  const spendIt = purchase({ month: 3, downPaymentSourceIds: ["savings", "brokerage"] });

  it("lists an account the plan has emptied, at $0, rather than dropping it", () => {
    const b = base();
    const ledger = addWithBase(emptyLedger, b, spendIt);
    const { sourcesAt } = fundingLookup(ledger, b, nullJurisdiction);

    expect(sourcesAt(2).map((s) => s.id).sort()).toEqual(["brokerage", "savings"]);
    expect(sourcesAt(3).map((s) => s.id).sort()).toEqual(["brokerage", "savings"]);
    expect(sourcesAt(2).find((s) => s.id === "savings")?.balanceCents).toBe(4_000_000);
    expect(sourcesAt(3).find((s) => s.id === "savings")?.balanceCents).toBe(0);
    expect(sourcesAt(3).find((s) => s.id === "brokerage")?.balanceCents).toBe(2_000_000);
  });

  it("keeps the largest-first order, so the empty accounts sort to the bottom", () => {
    const b = base();
    const ledger = addWithBase(emptyLedger, b, spendIt);
    // The picker's default drain order: biggest bucket first.
    expect(fundingLookup(ledger, b, nullJurisdiction).sourcesAt(3).map((s) => s.id)).toEqual([
      "brokerage",
      "savings",
    ]);
  });

  it("omits accounts that could never fund a draw, empty or not", () => {
    // Membership is "liquid", not "has money": the illiquid fund is absent, the empty liquid
    // account present.
    const b = baseWithAccounts([liquidAcct("savings", 0), goalFund("retirement", "401(k)", 5_000_000, false)]);
    expect(fundingLookup(emptyLedger, b, nullJurisdiction).sourcesAt(6).map((s) => s.id)).toEqual([
      "savings",
    ]);
  });
});
