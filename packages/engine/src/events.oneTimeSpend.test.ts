import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  addEvent,
  removeEvent,
  interpretLedger,
  buildProjection,
  type Ledger,
  type LedgerBaseConfig,
  type NewLifeEvent,
} from "./index";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";
import { personLit } from "./events.testSupport";

/** A flat capital-gains test jurisdiction (mirrors the home-purchase suite's). */
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
      return grossCents - Math.round(grossCents * basisFraction);
    },
  };
}

// ─── OneTimeSpendEvent — a source-directed, cash-only pure outflow (#154) ─────────
// A discretionary one-time spend drains an ordered list of the user's own liquid
// accounts and HARD-BLOCKS if they cannot cover it (financing is a LoanEvent's job).
// Unlike a Home Purchase it originates no asset: the money simply leaves net worth.

function liquidAcct(id: string, openingCents: number, rate = 0, label?: string): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: rate,
    label,
  });
}

function baseWith(accounts: SimAccount[], inflation = 0): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: inflation,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: accounts,
  };
}

function spend(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "spend1",
    type: "OneTimeSpendEvent",
    month: 3,
    amountCents: 3_000_000, // $30k
    fundingSourceIds: ["savings"],
    label: "New car",
    ...overrides,
  } as NewLifeEvent;
}

function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

describe("OneTimeSpendEvent", () => {
  it("drains the funding source and the amount leaves net worth", () => {
    const base = baseWith([liquidAcct("savings", 10_000_000)]); // $100k cash
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // Before the spend: the whole liquid balance.
    expect(series.months[2].netWorthNominalCents).toBe(10_000_000);

    // At the spend month: the source drops by exactly the amount, and — with no offsetting
    // asset — net worth drops by the same amount. A pure outflow, and totals are conserved.
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(10_000_000 - 3_000_000);
    expect(m3.netWorthNominalCents).toBe(10_000_000 - 3_000_000);
  });

  it("hard-blocks when the selected sources cannot cover the spend", () => {
    const base = baseWith([liquidAcct("savings", 2_000_000)]); // $20k < $30k spend
    const result = addEvent(emptyLedger, base, spend({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Cash-only hard block: it says how much is short, quotes dollars not cents, and — like
      // the down-payment gate — explains why a larger net worth can still fail.
      expect(result.conflict).toContain("$30,000");
      expect(result.conflict).toContain("$20,000");
      expect(result.conflict).not.toMatch(/¢|\d{7}/);
      expect(result.conflict).toMatch(/credit is never a source/);
    }
  });

  it("hard-blocks on any shortfall — one cent short still fails the gate", () => {
    const base = baseWith([liquidAcct("savings", 3_000_000 - 1)]);
    expect(addEvent(emptyLedger, base, spend({ month: 1 })).ok).toBe(false);
  });

  it("allows the spend when the sources cover it exactly", () => {
    const base = baseWith([liquidAcct("savings", 3_000_000)]); // exactly $30k
    expect(addEvent(emptyLedger, base, spend({ month: 1 })).ok).toBe(true);
  });

  it("never counts credit as a funding source", () => {
    const base = baseWith([liquidAcct("savings", 2_000_000)]);
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
    // The card cannot be named as a source (it is not liquid), and even alongside it the cash
    // shortfall still blocks — financing is a LoanEvent's job, not this event's.
    expect(addEvent(withCard, base, spend({ month: 1 })).ok).toBe(false);
  });
});

describe("OneTimeSpendEvent — ordered multi-source drain", () => {
  it("drains sources in order: the first empties before the second is touched", () => {
    // $20k + $50k, spending $30k from [savings, brokerage]: savings empties, brokerage covers
    // the $10k remainder — the same ordered drain the down payment uses.
    const base = baseWith([liquidAcct("savings", 2_000_000), liquidAcct("brokerage", 5_000_000)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ month: 3, fundingSourceIds: ["savings", "brokerage"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(0);
    expect(m3.accountBalancesCents.brokerage).toBe(5_000_000 - 1_000_000);
  });

  it("reverses which source empties when the order is reversed", () => {
    const base = baseWith([liquidAcct("savings", 2_000_000), liquidAcct("brokerage", 5_000_000)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ month: 3, fundingSourceIds: ["brokerage", "savings"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const m3 = series.months[3];
    // Brokerage is drained first now: it drops $30k, savings is untouched.
    expect(m3.accountBalancesCents.brokerage).toBe(5_000_000 - 3_000_000);
    expect(m3.accountBalancesCents.savings).toBe(2_000_000);
  });
});

describe("OneTimeSpendEvent — funding draw reporting (#122-consistent)", () => {
  it("reports a cash-funded spend as a savings drawdown, with no capital gain", () => {
    // $80k cash (0% growth → basis == balance, no embedded gain). A $30k spend is pure
    // returned principal: it surfaces as a savings drawdown, nothing as capital gains — the
    // chart shows the money was lived off assets, not conjured from nowhere.
    const base = baseWith([liquidAcct("savings", 8_000_000)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ month: 3, fundingSourceIds: ["savings"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const flows = series.months[3].flows;
    expect(flows).toBeDefined();

    const drawdown = flows!.incomeSources.find((s) => s.category === "savingsDrawdown");
    expect(drawdown?.cashInflowCents).toBe(3_000_000);
    expect(flows!.incomeSources.some((s) => s.category === "capitalGains")).toBe(false);
    expect(flows!.incomeByCategoryCents.capitalGains ?? 0).toBe(0);
  });

  it("splits an investment-funded spend into capital-gains income and returned principal", () => {
    // A brokerage grown 12 months at 12%/yr carries an embedded gain over its $50k basis. A
    // $40k spend realizes the gain as capital-gains income and returns the rest as principal
    // (a savings drawdown), reported under this event's own `spend:` band — the same
    // gain-vs-principal split #122 uses for a decumulation draw.
    const base = baseWith([liquidAcct("brokerage", 5_000_000, 0.12)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ month: 12, amountCents: 4_000_000, fundingSourceIds: ["brokerage"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    const balanceAtDraw = series.months[11].accountBalancesCents.brokerage;
    const basis = 5_000_000;
    const expectedPrincipal = Math.round(4_000_000 * (basis / balanceAtDraw));
    const expectedGain = 4_000_000 - expectedPrincipal;
    expect(expectedGain).toBeGreaterThan(0);

    const flows = series.months[12].flows;
    expect(flows).toBeDefined();
    const gainBand = flows!.incomeSources.find((s) => s.sourceId === "spend:brokerage");
    expect(gainBand?.category).toBe("capitalGains");
    expect(gainBand?.cashInflowCents).toBe(expectedGain);

    const drawdown = flows!.incomeSources.find((s) => s.category === "savingsDrawdown");
    expect(drawdown?.cashInflowCents).toBe(expectedPrincipal);

    // Conserved: the two bands sum to the whole spend.
    expect((gainBand?.cashInflowCents ?? 0) + (drawdown?.cashInflowCents ?? 0)).toBe(4_000_000);
    expect(flows!.incomeByCategoryCents.capitalGains).toBe(expectedGain);
  });
});

describe("OneTimeSpendEvent — investment-funded spend is taxed", () => {
  it("grosses up the draw and net worth falls by the tax, with no asset originated", () => {
    // A brokerage grown 12 months carries an embedded gain over its $50k basis. Spending $40k
    // from it grosses up over the gain's tax; with no offsetting asset, the tax is a genuine
    // net-worth loss. Compared against an identical no-tax run isolates the tax's effect from
    // the month's growth (a smaller residual compounds less, so the gap is not exactly the tax).
    const base = baseWith([liquidAcct("brokerage", 5_000_000, 0.12)]);
    const household = interpretLedger(
      addWithBase(emptyLedger, base, spend({ month: 12, amountCents: 4_000_000, fundingSourceIds: ["brokerage"] })),
      base,
    );
    const taxed = buildProjection(household, base, flatCapitalGains(0.2));
    const untaxed = buildProjection(household, base, nullJurisdiction);

    const at = taxed.months[12];
    // A real gain was realized and taxed at the spend month.
    expect(at.flows!.taxCents).toBeGreaterThan(0);
    // The gross-up drained MORE from the brokerage than the bare spend did.
    expect(at.accountBalancesCents.brokerage).toBeLessThan(
      untaxed.months[12].accountBalancesCents.brokerage,
    );
    // Net worth is strictly lower than the untaxed run — the spend now costs the household the
    // tax. And the tax charged is exactly 20% of the reported gain (no double-count).
    expect(at.netWorthNominalCents!).toBeLessThan(untaxed.months[12].netWorthNominalCents!);
    const gainBand = at.flows!.incomeSources.find((s) => s.sourceId === "spend:brokerage");
    expect(at.flows!.taxCents).toBe(Math.round(gainBand!.cashInflowCents * 0.2));
    // No asset is originated — a pure outflow leaves no property behind.
    expect(Object.keys(at.propertyValuesCents ?? {})).toHaveLength(0);
  });
});

describe("OneTimeSpendEvent — authored at month 0 (\"now\")", () => {
  // Month 0 is the flow-free opening snapshot: the simulator processes no month before
  // "now", so the funding-draw step is never called for it. A draw authored AT month 0 —
  // which is exactly what the app's "Year 0" option records — used to match no processed
  // month at all and vanish: the gate accepted the spend, the ledger kept it, the timeline
  // listed it, and net worth never moved. It resolves in month 1 instead, the first
  // processed month and the earliest with a tax chokepoint to charge a gain through.
  it("drains the source and leaves net worth, exactly as a later spend does", () => {
    const base = baseWith([liquidAcct("savings", 10_000_000)]); // $100k cash
    const ledger = addWithBase(emptyLedger, base, spend({ month: 0 }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // The opening snapshot itself is untouched — month 0 still reports the world as it is
    // before any flow runs.
    expect(series.months[0].accountBalancesCents.savings).toBe(10_000_000);
    // By the first processed month the spend has been taken, and stays taken.
    expect(series.months[1].accountBalancesCents.savings).toBe(10_000_000 - 3_000_000);
    expect(series.months[1].netWorthNominalCents).toBe(10_000_000 - 3_000_000);
    expect(series.months[12].accountBalancesCents.savings).toBe(10_000_000 - 3_000_000);
  });

  it("is drained once, not once per skipped month", () => {
    const base = baseWith([liquidAcct("savings", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend({ month: 0 }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    // Clamping the draw's month must not let it re-match a later month: the balance after
    // month 1 never moves again.
    expect(series.months[2].accountBalancesCents.savings).toBe(10_000_000 - 3_000_000);
    expect(series.months[2].netWorthNominalCents).toBe(10_000_000 - 3_000_000);
  });

  it("still hard-blocks at month 0 when the sources cannot cover it", () => {
    // The gate prices the month the draw RESOLVES in, so a month-0 spend is judged against
    // month 1's balances — the very ones the simulator will drain.
    const base = baseWith([liquidAcct("savings", 2_000_000)]); // $20k < $30k spend
    expect(addEvent(emptyLedger, base, spend({ month: 0 })).ok).toBe(false);
  });
});

describe("OneTimeSpendEvent — ledger round-trip (replay + undo)", () => {
  it("replays deterministically: the same ledger yields the same projection", () => {
    const base = baseWith([liquidAcct("savings", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const a = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const b = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(b.months[3].netWorthNominalCents).toBe(a.months[3].netWorthNominalCents);
    expect(b.months[3].accountBalancesCents.savings).toBe(a.months[3].accountBalancesCents.savings);
  });

  it("undoes cleanly: removing the spend restores net worth exactly", () => {
    const base = baseWith([liquidAcct("savings", 10_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());

    const removed = removeEvent(ledger, "spend1", base);
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      const series = buildProjection(interpretLedger(removed.ledger, base), base, nullJurisdiction);
      // The spend and its draw are gone: the account and net worth are back to the full $100k.
      expect(series.months[3].accountBalancesCents.savings).toBe(10_000_000);
      expect(series.months[3].netWorthNominalCents).toBe(10_000_000);
    }
  });
});
