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
    downPaymentSourceIds: ["savings"],
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

  it("hard-blocks on any shortfall — one cent short still fails the gate", () => {
    // The gate drains the down payment from the sources and blocks on a positive
    // shortfall, so exact coverage passes but a single-cent gap does not.
    const base = baseWith(DOWN - 1); // one cent under the down payment
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
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
      // A selected liquid goal fund WAS counted, so the message must name it.
      expect(result.conflict).toContain("Emergency fund");
      expect(result.conflict).toContain("$50,000"); // the counted selected total
    }
  });

  it("still excludes an illiquid goal fund even when it is selected", () => {
    // $30k savings + $40k ILLIQUID goal fund → the illiquid one contributes 0, so only
    // $30k counts and the gate blocks despite both being selected.
    const base = baseWithGoalFund(3_000_000, {
      label: "Retirement top-up",
      cents: 4_000_000,
      liquid: false,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
  });

  it("falls back to the account id when a counted bucket has an empty label", () => {
    // An empty-string label must fall back to the id ("goal-emergency"), not print a
    // nameless "()". $30k savings + $15k = $45k < $60k, so the gate blocks and lists both.
    const base = baseWithGoalFund(3_000_000, { label: "", cents: 1_500_000, liquid: true });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("goal-emergency ($15,000)");
      expect(result.conflict).not.toContain("()");
    }
  });

  it("states a total that equals the sum of the buckets it lists", () => {
    // The stated "$Y available" is derived from the same buckets the message itemises,
    // so the two can never disagree. $30k savings + $15k emergency = $45k, and the
    // message names each selected bucket at exactly the amounts that sum to $45k.
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

// ─── Ordered multi-source down payment (#129/#151/#153) ──────────────────────
// The down payment drains an ORDERED list of sources: the shared funding helper
// takes as much as each holds before moving to the next, so an early source empties
// before a later one is touched. Each contributing source receives its own outflow.

/** A liquid asset account with an id, opening balance, rate, and optional label. */
function liquidAcct(id: string, openingCents: number, rate = 0, label?: string): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    ...(label !== undefined ? { label } : {}),
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: rate,
  });
}

function baseWithAccounts(accounts: SimAccount[], inflation = 0): LedgerBaseConfig {
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
    // Savings empties ($40k), the remaining $20k comes from brokerage.
    const base = baseWithAccounts([
      liquidAcct("savings", 4_000_000),
      liquidAcct("brokerage", 4_000_000),
    ]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      purchase({ month: 3, downPaymentSourceIds: ["savings", "brokerage"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // Before the purchase: both accounts untouched, $80k liquid.
    expect(series.months[2].accountBalancesCents.savings).toBe(4_000_000);
    expect(series.months[2].accountBalancesCents.brokerage).toBe(4_000_000);
    const netBefore = series.months[2].netWorthNominalCents;

    // At the purchase month: savings drained dry, brokerage down by the $20k remainder,
    // so two distinct sources funded the down payment — not one over-drawn account.
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(0);
    expect(m3.accountBalancesCents.brokerage).toBe(2_000_000);
    // The purchase conserves net worth (property + mortgage = price; the draws are the
    // only net move, and they sum to the down payment across the two sources).
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
    // Brokerage now drains first (empties); savings keeps the $20k remainder.
    expect(m3.accountBalancesCents.brokerage).toBe(0);
    expect(m3.accountBalancesCents.savings).toBe(2_000_000);
  });

  it("hard-blocks a multi-source shortfall, naming every selected source and the total", () => {
    // $30k savings + $20k brokerage = $50k < $60k down: the combined selected balance
    // falls short, so the gate blocks and itemises both selected sources.
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

// ─── Down-payment draw reporting (#122-consistent) ───────────────────────────
// The draw converts a liquid asset into home equity (net worth conserved), but it
// still surfaces in the diagnostic flow view: a cash source's whole draw as a savings
// drawdown, an investment source's realized GAIN as capital-gains income and its
// returned PRINCIPAL as a savings drawdown.

describe("HomePurchaseEvent — down-payment draw reporting", () => {
  it("reports a cash-funded draw as a savings drawdown, with no capital gain", () => {
    // $80k cash savings (0% growth → basis == balance, no embedded gain). A $60k down
    // payment is pure returned principal: it reports as a savings drawdown, nothing as
    // capital gains.
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
    // No capital-gains band — a zero-growth cash account has no gain to realize.
    expect(flows!.incomeSources.some((s) => s.category === "capitalGains")).toBe(false);
    // A drawdown is spending an asset, not income: it stays out of the income total.
    expect(flows!.incomeByCategoryCents.capitalGains ?? 0).toBe(0);
  });

  it("splits an investment-funded draw into capital-gains income and returned principal", () => {
    // A brokerage grown 12 months at 12%/yr carries an embedded gain over its cost
    // basis (its $50k opening). A $40k draw realizes the gain as capital-gains income
    // and returns the rest as principal (a savings drawdown); the two sum to the draw.
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

    // The balance the draw sees is the end-of-month-11 balance (the draw runs before
    // month 12 compounds); basis is the untouched $50k opening (rate growth adds none).
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
    // The gain is genuine capital-gains income in the rollup; the principal is not.
    expect(flows!.incomeByCategoryCents.capitalGains).toBe(expectedGain);
  });
});
