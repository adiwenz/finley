import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  addEvent,
  interpretLedger,
  buildProjection,
  removeEvent,
  type Ledger,
  type LedgerBaseConfig,
  type NewLifeEvent,
} from "./index";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import { nullJurisdiction } from "./jurisdiction";
import { personLit } from "./events.testSupport";

// ─── HomePurchaseEvent (property lifecycle) ───────────────────────────────────

function savings(openingCents: number, rate = 0): SimAccount {
  return new SimAccount({
    id: "savings",
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
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

function purchase(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "buy1",
    type: "HomePurchaseEvent",
    month: 3,
    propertyId: "house1",
    ownerId: "p1",
    purchasePriceCents: PRICE,
    downPaymentCents: DOWN,
    downPaymentAccountId: "savings",
    mortgageLiabilityId: "mtg1",
    mortgageApr: 0,
    mortgageTermMonths: 360,
    ...overrides,
  } as NewLifeEvent;
}

/** Append a HomePurchase fixture against a per-test base, asserting it passes. */
function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

describe("HomePurchaseEvent", () => {
  it("creates a property, its mortgage, and a down-payment outflow", () => {
    const base = baseWith(10_000_000); // $100k liquid
    const ledger = addWithBase(emptyLedger, base, purchase());
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

  it("conserves net worth at the purchase month (property = down + mortgage)", () => {
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, purchase());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // Before purchase: just the liquid account.
    expect(series.months[2].netWorthNominalCents).toBe(10_000_000);
    expect(series.months[2].propertyValuesCents.house1 ?? 0).toBe(0);

    // At purchase: down payment leaves savings; mortgage + property appear; the
    // three moves cancel, so net worth is unchanged.
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(10_000_000 - DOWN);
    expect(m3.liabilityBalancesCents.mtg1).toBe(FINANCED);
    expect(m3.propertyValuesCents.house1).toBe(PRICE);
    expect(m3.netWorthNominalCents).toBe(10_000_000);
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
      mortgageLiabilityId: "mtg2",
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

  it("quotes dollars, not raw cents, and says why other balances don't count", () => {
    // The conflict is read by a person: "6000000¢ exceeds 5000000¢" left users
    // comparing the shortfall against a net worth that already looked sufficient.
    const base = baseWith(5_000_000);
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("$60,000");
      expect(result.conflict).toContain("$50,000");
      expect(result.conflict).not.toMatch(/¢|\d{7}/);
      // Names the reason a larger net worth can still fail the gate.
      expect(result.conflict).toMatch(/goal funds|retirement|brokerage/);
    }
  });

  it("never counts credit as a down-payment source", () => {
    const base = baseWith(5_000_000);
    // A credit card with a large limit is available, but credit is not liquid.
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

// ─── §4.5 gate — liquid goal funds (the cash emergency reserve) are sources ──────
// Issue #105: a goal held as cash (the "liquid reserve" emergency fund) lands in a
// liquid account, so it IS a sourced down-payment fund. The gate must count it, and
// the block message must name which buckets it counted rather than telling the user
// "goal funds do not count" — a claim the model contradicts the moment a cash goal exists.

/** A goal's fund account; liquid when the goal is held as cash (the emergency reserve). */
function goalFund(id: string, label: string, openingCents: number, liquid: boolean): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    label,
    liquid,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
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

describe("HomePurchaseEvent — §4.5 gate counts liquid goal funds", () => {
  it("lets a liquid emergency reserve cover the gap savings alone cannot", () => {
    // $30k savings + $40k cash emergency fund = $70k liquid ≥ $60k down.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 4_000_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(true);
  });

  it("names the liquid goal buckets it counted when the gate still blocks", () => {
    // $30k savings + $20k cash emergency fund = $50k liquid < $60k down.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 2_000_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A liquid goal fund WAS counted, so the message must name it — not claim that
      // goal funds categorically do not count toward a down payment.
      expect(result.conflict).toContain("Emergency fund");
      expect(result.conflict).toContain("$50,000"); // the counted liquid total
    }
  });

  it("still excludes an illiquid goal fund from the down-payment gate", () => {
    // $30k savings + $40k ILLIQUID goal fund → only $30k counts, so the gate blocks.
    const base = baseWithGoalFund(3_000_000, {
      label: "Retirement top-up",
      cents: 4_000_000,
      liquid: false,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
  });

  it("falls back to the account id when a counted bucket has an empty label", () => {
    // An empty-string label must fall back to the id ("goal-emergency"), not print a
    // nameless "()". $30k savings + $15k = $45k < $60k, so the gate blocks and lists both.
    const base = baseWithGoalFund(3_000_000, { label: "", cents: 1_500_000, liquid: true });
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("goal-emergency ($15,000)");
      expect(result.conflict).not.toContain("()");
    }
  });

  it("states a total that equals the sum of the buckets it lists", () => {
    // The stated "$Y of liquid funds" is derived from the same buckets the message
    // itemises, so the two can never disagree. $30k savings + $15k emergency = $45k,
    // and the message names each bucket at exactly the amounts that sum to $45k.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 1_500_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("$45,000"); // the stated total
      expect(result.conflict).toContain("savings ($30,000)");
      expect(result.conflict).toContain("Emergency fund ($15,000)");
    }
  });
});

describe("removeEvent — HomePurchaseEvent", () => {
  it("removes the property and its mortgage together", () => {
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, purchase());
    const result = removeEvent(ledger, "buy1", base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const household = interpretLedger(result.ledger, base);
      expect(household.properties).toHaveLength(0);
      expect(household.liabilities).toHaveLength(0);
    }
  });
});
