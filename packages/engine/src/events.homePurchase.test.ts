import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  addEvent,
  fundingLookup,
  interpretLedger,
  buildProjection,
  removeEvent,
  type Ledger,
  type LedgerBaseConfig,
  type NewLifeEvent,
} from "./index";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import { SimCashFlowSeries, dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";
import { personLit } from "./events.testSupport";

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

/** Appends a fixture, asserting it passes. */
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

    expect(series.months[2].netWorthNominalCents).toBe(10_000_000);
    expect(series.months[2].propertyValuesCents.house1 ?? 0).toBe(0);

    // The three moves cancel.
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

// Sources drain in order, each taken to zero before the next is touched; each gets its own outflow.

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

describe("HomePurchaseEvent — investment-funded down payment is taxed", () => {
  it("grosses up the draw and drops net worth by the capital-gains tax it pays", () => {
    // An otherwise-identical no-tax run isolates the tax from the month's growth.
    const base = baseWithAccounts([liquidAcct("brokerage", 8_000_000, 0.12)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      purchase({ month: 12, downPaymentSourceIds: ["brokerage"] }),
    );
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
    const ledger = addWithBase(
      emptyLedger,
      base,
      purchase({ month: 3, downPaymentSourceIds: ["savings"] }),
    );
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
  // sits under the $15k threshold, untaxed, exactly covering the $60,000 down payment.
  const jurisdiction = () => bracketedCapitalGains(dollarsToCents(15_000), 0.4);
  const twoBrokerages = () =>
    baseWithAccounts([
      liquidAcct("brokerage-a", 5_000_000, 0.1),
      liquidAcct("brokerage-b", 5_000_000, 0.1),
    ]);
  const secondPurchase = purchase({
    id: "buy2",
    month: 24,
    propertyId: "house2",
    mortgageLiabilityId: "mtg2",
    downPaymentSourceIds: ["brokerage-b"],
  });

  it("blocks the second purchase, whose gain the first purchase pushes over the threshold", () => {
    const jur = jurisdiction();
    const base = twoBrokerages();
    const first = addEvent(
      emptyLedger,
      base,
      purchase({ month: 24, downPaymentSourceIds: ["brokerage-a"] }),
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
