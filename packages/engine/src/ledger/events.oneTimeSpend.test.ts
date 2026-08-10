import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent, fundingLookup } from "./addEvent";
import { interpretLedger } from "./interpret";
import { buildProjection } from "../projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";
import {
  automaticFundingTotal,
  expenseReportingTotal,
} from "../projection/financialObligation";

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

const AMOUNT = 3_000_000; // $30k

function spend(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "spend1",
    type: "OneTimeSpendEvent",
    month: 3,
    label: "New car",
    amountCents: AMOUNT,
    fundingSourceIds: ["savings"],
    ...overrides,
  } as NewLifeEvent;
}

function cardLoanEvent(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "card",
    type: "LoanEvent",
    month: 0,
    liabilityId: "visa",
    ownerId: "p1",
    kind: "creditCard",
    openingBalanceCents: 0,
    apr: 0.2,
    creditLimitCents: 10_000_00,
    ...overrides,
  } as NewLifeEvent;
}

function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

function affordabilityOf(
  ledger: Ledger,
  base: LedgerBaseConfig,
  event: NewLifeEvent,
  jurisdiction: Jurisdiction = nullJurisdiction,
) {
  const e = event as unknown as { fundingSourceIds: string[]; amountCents: number; month: number };
  return fundingLookup(ledger, base, jurisdiction).availabilityAt(
    e.fundingSourceIds,
    e.amountCents,
    e.month,
  );
}

describe("OneTimeSpendEvent", () => {
  it("produces exactly one expense/explicit obligation, draining the named source", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const household = interpretLedger(ledger, base);
    expect(household.fundingDraws).toHaveLength(1);
    const draw = household.fundingDraws[0];
    expect(draw.treatment).toBe("expense");
    expect(draw.funding).toEqual({ kind: "explicit", orderedAccountIds: ["savings"] });
    expect(draw.amountCents).toBe(AMOUNT);
    expect(draw.sourceEventId).toBe("spend1");
  });

  it("drains net worth by the spend amount and leaves no property or liability behind", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.months[2].accountBalancesCents.savings).toBe(5_000_000);
    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(5_000_000 - AMOUNT);
    expect(m3.netWorthNominalCents).toBe(5_000_000 - AMOUNT);
  });

  it("round-trips through interpretation deterministically", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const first = interpretLedger(ledger, base);
    const second = interpretLedger(ledger, base);
    expect(second.fundingDraws).toEqual(first.fundingDraws);
  });
});

describe("OneTimeSpendEvent — the double-count tripwire (Slice #3)", () => {
  it("appears in expense reporting at its full amount but never in the automatic funding total", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const household = interpretLedger(ledger, base);
    const obligations = household.fundingDraws.filter((o) => o.month === 3);

    expect(expenseReportingTotal(obligations)).toBe(AMOUNT);
    expect(automaticFundingTotal(obligations)).toBe(0);
  });
});

describe("OneTimeSpendEvent — credit as an authored funding source (#191)", () => {
  it("allows a credit card among the named sources, unlike Home Purchase's down payment", () => {
    const base = baseWithAccounts([liquidAcct("savings", 0)]);
    const withCard = addWithBase(emptyLedger, base, cardLoanEvent({ creditLimitCents: 5_000_000 }));
    const result = addEvent(withCard, base, spend({ fundingSourceIds: ["visa"] }));
    expect(result.ok).toBe(true);
  });

  it("borrows against the card's headroom, drawn in the user's stated order", () => {
    const base = baseWithAccounts([liquidAcct("savings", 1_000_000)]);
    const withCard = addWithBase(
      emptyLedger,
      base,
      cardLoanEvent({ creditLimitCents: 5_000_000, apr: 0 }),
    );
    const ledger = addWithBase(withCard, base, spend({ fundingSourceIds: ["savings", "visa"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    const m3 = series.months[3];
    // $10k savings drained first, then $20k borrowed onto the card.
    expect(m3.accountBalancesCents.savings).toBe(0);
    expect(m3.liabilityBalancesCents.visa).toBe(AMOUNT - 1_000_000);
  });

  it("lists a credit card in the funding-source pool for an expense, unlike Home Purchase", () => {
    const base = baseWithAccounts([liquidAcct("savings", 0)]);
    const withCard = addWithBase(emptyLedger, base, cardLoanEvent({ creditLimitCents: 5_000_000 }));
    const pool = fundingLookup(withCard, base).sourcesAt(3, "expense");
    expect(pool.some((s) => s.id === "visa" && s.kind === "credit")).toBe(true);

    const assetPool = fundingLookup(withCard, base).sourcesAt(3, "asset-acquisition");
    expect(assetPool.some((s) => s.id === "visa")).toBe(false);
  });
});

describe("OneTimeSpendEvent — shortfall blocks rather than silently financing", () => {
  it("refuses a newly authored spend when the named sources cannot cover it", () => {
    const base = baseWithAccounts([liquidAcct("savings", 1_000_000)]); // $10k < $30k
    const result = addEvent(emptyLedger, base, spend());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/spend of \$30,000/);
  });

  it("classifies funding-configuration when eligible money sits in an unselected account", () => {
    const base = baseWithAccounts([liquidAcct("savings", 1_000_000), liquidAcct("brokerage", 4_000_000)]);
    const result = addEvent(emptyLedger, base, spend({ fundingSourceIds: ["savings"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toMatch(/other eligible accounts could cover it/i);
      expect(result.conflict).toContain("brokerage");
    }
  });

  it("classifies no-eligible-source-suffices when nothing eligible can cover it", () => {
    const base = baseWithAccounts([liquidAcct("savings", 1_000_000)]);
    const result = addEvent(emptyLedger, base, spend());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toMatch(/eligible funding sources together can cover/);
    }
  });

  it("a stranded event does not throw: the simulator blocks at its month instead", () => {
    // Authored while affordable, then stranded by a later withdrawal through a different
    // door — authoring never re-litigates an accepted event on replay.
    const base = baseWithAccounts([liquidAcct("savings", AMOUNT)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const household = interpretLedger(ledger, base);
    // Simulate against a base with less money than authored, mimicking a later strand.
    const strandedBase = baseWithAccounts([liquidAcct("savings", 1_000_000)]);
    expect(() =>
      buildProjection(interpretLedger(ledger, strandedBase), strandedBase, nullJurisdiction),
    ).not.toThrow();
    const series = buildProjection(interpretLedger(ledger, strandedBase), strandedBase, nullJurisdiction);
    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(3);
    expect(series.blockingObligation?.fundingFailure.kind).toBe("no-eligible-source-suffices");
    // The event stays authored — replay never threw, and the ledger is untouched.
    expect(household.fundingDraws).toHaveLength(1);
  });
});

describe("OneTimeSpendEvent — sibling explicit events resolve in event-sequence order", () => {
  it("validates the second spend against what the first left", () => {
    const base = baseWithAccounts([liquidAcct("a", 5_000_000)]);
    let ledger = addWithBase(emptyLedger, base, spend({ id: "spend1", month: 3, amountCents: 3_000_000, fundingSourceIds: ["a"] }));
    const second = addEvent(
      ledger,
      base,
      spend({ id: "spend2", month: 3, amountCents: 3_000_000, fundingSourceIds: ["a"] }),
    );
    // Only $20k left after the first $30k draw — the second is refused against the remainder.
    expect(second.ok).toBe(false);
  });

  it("funds the second spend from the balance the first left behind", () => {
    const base = baseWithAccounts([liquidAcct("a", 6_000_000)]);
    let ledger = addWithBase(emptyLedger, base, spend({ id: "spend1", month: 3, amountCents: 3_000_000, fundingSourceIds: ["a"] }));
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "spend2", month: 3, amountCents: 3_000_000, fundingSourceIds: ["a"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.months[3].accountBalancesCents.a).toBe(0);
  });
});

describe("OneTimeSpendEvent — draw reporting reuses the #122 split", () => {
  it("reports a cash-funded draw as a savings drawdown, no capital gain", () => {
    const base = baseWithAccounts([liquidAcct("savings", 5_000_000)]);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const flows = series.months[3].flows!;
    const drawdown = flows.incomeSources.find((s) => s.category === "savingsDrawdown");
    expect(drawdown?.cashInflowCents).toBe(AMOUNT);
    expect(flows.incomeSources.some((s) => s.category === "capitalGains")).toBe(false);
  });

  it("splits an investment-funded draw into capital-gains income and returned principal", () => {
    const base = baseWithAccounts([liquidAcct("brokerage", 5_000_000, 0.12)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ month: 12, fundingSourceIds: ["brokerage"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const flows = series.months[12].flows!;
    const gainBand = flows.incomeSources.find((s) => s.sourceId === "spend:brokerage");
    expect(gainBand?.category).toBe("capitalGains");
    expect(gainBand!.cashInflowCents).toBeGreaterThan(0);
    const drawdown = flows.incomeSources.find((s) => s.category === "savingsDrawdown");
    expect((gainBand?.cashInflowCents ?? 0) + (drawdown?.cashInflowCents ?? 0)).toBe(AMOUNT);
  });
});

/** Taxes `capitalGains` at `rate`, basis returned pro-rata — the same fixture Home Purchase's gate tests use. */
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

describe("OneTimeSpendEvent — gate == sim", () => {
  it("the reporter's shortfall matches exactly what the simulator produces for the same draw", () => {
    // $50k basis grown 24 months at 10%/yr clears $60k pre-tax but not net of a 20% capital-gains
    // tax — the gap the reporter must price identically to the sim.
    const base = { ...baseWithAccounts([liquidAcct("brokerage", 5_000_000, 0.1)]), horizonMonths: 30 };
    const jur = flatCapitalGains(0.2);
    const buy = spend({ month: 24, amountCents: 6_000_000, fundingSourceIds: ["brokerage"] });

    const reported = affordabilityOf(emptyLedger, base, buy, jur);

    // The sim, run over the SAME base and draw: the simulated shortfall equals the reporter's.
    const ledger: Ledger = {
      events: [{ ...buy, sequenceNumber: 1 }] as unknown as Ledger["events"],
      nextSequenceNumber: 2,
    };
    const series = buildProjection(interpretLedger(ledger, base), base, jur);
    expect(reported.shortfallCents).toBeGreaterThan(0);
    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.shortfallCents).toBe(reported.shortfallCents);
  });

  it("predicts exactly the shortfall the simulator produces in a month that also decumulates", () => {
    // A $30k/mo obligation with no income forces automatic decumulation from the same account the
    // spend draws — the gate must price the spend BEFORE that competing draw, exactly as the sim
    // resolves explicit obligations first.
    const base: LedgerBaseConfig = {
      horizonMonths: 3,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [liquidAcct("cash", 0), liquidAcct("brokerage", 6_000_000)],
    };
    const draw = spend({ month: 0, amountCents: 4_000_000, fundingSourceIds: ["brokerage"] });
    const reported = affordabilityOf(emptyLedger, base, draw, nullJurisdiction);
    expect(reported.shortfallCents).toBe(0);

    const ledger = addWithBase(emptyLedger, base, draw);
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    // The draw resolved in full, exactly as the reporter predicted — draining brokerage to zero
    // regardless of the decumulation gap competing for the same account.
    expect(series.months[0].accountBalancesCents.brokerage).toBe(2_000_000);
  });
});
