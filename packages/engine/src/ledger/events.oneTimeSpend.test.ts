/**
 * `OneTimeSpendEvent`: a dated, source-directed cash outflow. Distinct from Home Purchase in that
 * authoring never refuses on affordability — a shortfall is a projection-time block, not an
 * authoring-time refusal — so these tests exercise the handler, the obligation it produces, the
 * expense-reporting tripwire, and the block, rather than an authoring-time gate.
 */
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
import { Projection } from "../index";
import { stateOf, samplePlan } from "../testing/samplePlan";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";

function savings(openingCents: number): PlanAccount {
  return planAccount({
    id: "savings",
    owners: ["p1" as PersonId],
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

function baseWith(openingCents: number): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [savings(openingCents)],
  };
}

function spend(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "spend1",
    type: "OneTimeSpendEvent",
    month: 3,
    label: "Car",
    amountCents: 3_000_000,
    fundingSourceIds: ["savings"],
    ...overrides,
  } as NewLifeEvent;
}

function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

describe("OneTimeSpendEvent — the sole obligation it produces", () => {
  it("produces exactly one explicitly-funded expense obligation, no dependent artifact", () => {
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, spend());
    const household = interpretLedger(ledger, base);

    expect(household.fundingDraws).toHaveLength(1);
    const draw = household.fundingDraws[0];
    expect(draw.treatment).toBe("expense");
    expect(draw.funding).toEqual({ kind: "explicit", orderedAccountIds: ["savings"] });
    expect(draw.amountCents).toBe(3_000_000);
    expect(draw.sourceEventId).toBe("spend1");
    expect(draw.label).toBe("Car");
    // No property, no liability — unlike Home Purchase, nothing rides along.
    expect(household.properties).toHaveLength(0);
    expect(household.liabilities).toHaveLength(0);
  });

  it("drains the named source at the authored month and leaves net worth reduced by exactly the spend", () => {
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    const m3 = series.months[3];
    expect(m3.accountBalancesCents.savings).toBe(10_000_000 - 3_000_000);
    expect(m3.netWorthNominalCents).toBe(10_000_000 - 3_000_000);
  });

  it("is NOMINAL at its month — not grown, unlike a recurring stream", () => {
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, spend({ month: 12 }));
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    const draw = series.months[12].flows?.obligations.find((o) => o.sourceEventId === "spend1");
    expect(draw?.amountCents).toBe(3_000_000);
  });
});

describe("OneTimeSpendEvent — authoring never refuses on affordability", () => {
  it("accepts a spend whose named source cannot possibly cover it", () => {
    const base = baseWith(1_000_00); // $1k liquid, spend wants $30k
    const result = addEvent(emptyLedger, base, spend({ amountCents: 30_000_00 }));
    expect(result.ok).toBe(true);
  });

  it("still validates that each named source actually exists", () => {
    const base = baseWith(10_000_000);
    const result = addEvent(emptyLedger, base, spend({ fundingSourceIds: ["nope"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/funding source "nope" not found/);
  });

  it("refuses a spend naming zero sources or a repeated one, and a non-positive amount", () => {
    expect(addEvent(emptyLedger, baseWith(0), spend({ fundingSourceIds: [] })).ok).toBe(false);
    expect(
      addEvent(emptyLedger, baseWith(0), spend({ fundingSourceIds: ["savings", "savings"] })).ok,
    ).toBe(false);
    expect(addEvent(emptyLedger, baseWith(0), spend({ amountCents: 0 })).ok).toBe(false);
  });
});

describe("OneTimeSpendEvent — a shortfall blocks the projection rather than throwing", () => {
  it("blocks at the spend's month, naming the event and the shortfall, and does not throw", () => {
    const base = baseWith(1_000_000); // $10k liquid, spend wants $30k
    const ledger = addWithBase(emptyLedger, base, spend({ amountCents: 3_000_000 }));

    expect(() => buildProjection(interpretLedger(ledger, base), base, nullJurisdiction)).not.toThrow();
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(3);
    expect(series.blockingObligation?.sourceEventId).toBe("spend1");
    expect(series.blockingObligation?.shortfallCents).toBe(2_000_000);
    expect(["funding-configuration", "no-eligible-source-suffices"]).toContain(
      series.blockingObligation?.fundingFailure.kind,
    );
    // The event stays authored — the ledger was never refused, only the projection stopped.
    expect(ledger.events).toHaveLength(1);
  });

  it("names an eligible unselected account: funding-configuration", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [
        savings(1_000_000), // $10k, selected
        planAccount({
          id: "brokerage",
          owners: ["p1" as PersonId],
          liquid: true,
          taxProfile: CAPITAL_GAINS_TAX_PROFILE,
          balanceCents: 5_000_000, // $50k, NOT selected — eligible elsewhere
          initialAnnualRate: 0,
        }),
      ],
    };
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ amountCents: 3_000_000, fundingSourceIds: ["savings"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.fundingFailure.kind).toBe("funding-configuration");
  });
});

describe("OneTimeSpendEvent — the double-count tripwire", () => {
  it("appears in expense reporting at its full amount and never in the automatic funding total", () => {
    const base = baseWith(10_000_000);
    const ledger = addWithBase(emptyLedger, base, spend());
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    const m3 = series.months[3];
    // The waterfall was never asked for this money.
    expect(m3.flows?.totalObligationsCents).toBe(0);
    // The expense graph shows it at full amount.
    expect(m3.flows?.expensesCents).toBe(3_000_000);
    const band = m3.flows?.obligations.find((o) => o.sourceEventId === "spend1");
    expect(band).toBeDefined();
    expect(band?.amountCents).toBe(3_000_000);
    expect(band?.funding.kind).toBe("explicit");
  });
});

describe("OneTimeSpendEvent — a credit card among the funding sources", () => {
  it("drains cash before credit in the authored order, borrowing only the remainder", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [savings(2_000_00)],
    };
    const withCard = addWithBase(emptyLedger, base, {
      id: "card1",
      type: "LoanEvent",
      month: -1,
      liabilityId: "visa",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0,
      creditLimitCents: 10_000_00,
    } as NewLifeEvent);
    const ledger = addWithBase(
      withCard,
      base,
      spend({ month: 1, amountCents: 6_000_00, fundingSourceIds: ["savings", "visa"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    expect(series.status).toBe("ran-to-horizon");
    const m1 = series.months[1];
    expect(m1.accountBalancesCents.savings).toBe(0);
    expect(m1.liabilityBalancesCents.visa).toBe(4_000_00);
    expect(m1.netWorthNominalCents).toBe(2_000_00 - 6_000_00);
  });
});

describe("OneTimeSpendEvent — sibling explicit events in the same month", () => {
  it("resolves in event-sequence order, the second validated against what the first left", () => {
    const base = baseWith(5_000_000); // $50k
    let ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 3, amountCents: 4_000_000, fundingSourceIds: ["savings"] }),
    );
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "spend2", month: 3, amountCents: 2_000_000, fundingSourceIds: ["savings"] }),
    );
    const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);

    // $50k − $40k first, then only $10k left for the second's $20k ask.
    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.sourceEventId).toBe("spend2");
    expect(series.blockingObligation?.shortfallCents).toBe(1_000_000);
  });
});

/**
 * A jurisdiction that taxes only capital gains, and only past a threshold — isolating the
 * marginal-tax question the §4.5 gate has to price: whose OTHER income a sale stacks on.
 */
function bracketedCapitalGains(thresholdCents: number, rate: number): Jurisdiction {
  const gainTaxCents = (byCat: Partial<Record<string, number>>): number => {
    const ordinary = byCat.ordinaryIncome ?? 0;
    const gains = byCat.capitalGains ?? 0;
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

function liquidAcct(id: string, openingCents: number, rate = 0): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: rate,
  });
}

// gate == sim, the load-bearing invariant Home Purchase's §4.5 gate already pins: the funding
// gate prices a candidate over the SAME base the simulator resolves it against — "after this
// month's explicit draws, before decumulation" — so its predicted shortfall equals the
// simulator's exactly, in a month decumulation also runs. One-Time Spend reads the identical
// seam ({@link fundingLookup}), so this is the same invariant, not a new one, but authoring never
// gates on it: the predicted shortfall is what the simulator's block will report, not a refusal.
describe("OneTimeSpendEvent — gate == sim across a decumulation month", () => {
  it("predicts exactly the shortfall the simulator produces", () => {
    const DOWN = dollarsToCents(60_000);
    const jur = bracketedCapitalGains(dollarsToCents(15_000), 0.4);
    const base: LedgerBaseConfig = {
      horizonMonths: 24,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      // `cash` covers the spend exactly, no gain; `nest` funds decumulation alone.
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
    };
    const buy = spend({ month: 23, amountCents: DOWN, fundingSourceIds: ["cash"] });

    const gate = fundingLookup(emptyLedger, base, jur).availabilityAt(["cash"], DOWN, 23);
    expect(gate.shortfallCents).toBe(0);

    const accepted = addEvent(emptyLedger, base, buy, jur);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const series = buildProjection(interpretLedger(accepted.ledger, base), base, jur);
    const at = series.months[23];

    // gate == sim: the candidate resolved first and took the whole `cash` buffer, exactly as
    // predicted — draining it to zero, never falling short, even though decumulation this same
    // month forces `nest`'s taxed liquidation right after it.
    expect(series.status).toBe("ran-to-horizon");
    expect(at.accountBalancesCents.cash).toBe(0);
    expect(at.flows!.expensesCents).toBe(dollarsToCents(150_000) + DOWN);
    expect(at.flows!.taxCents).toBeGreaterThan(0);
  });
});

describe("Projection.spendOnce — authoring surface", () => {
  it("mints a spend-N id and round-trips through the ledger with deterministic replay", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const id = p.spendOnce({
      month: 6,
      label: "New couch",
      amountCents: 200_000,
      fundingSourceIds: ["savings"],
    });
    expect(id).toBe("spend-1");
    expect(p.ledger.events[0]).toMatchObject({
      id,
      type: "OneTimeSpendEvent",
      label: "New couch",
      amountCents: 200_000,
      fundingSourceIds: ["savings"],
    });

    // Deterministic replay: re-running the SAME ledger twice lands on the identical result.
    const first = p.run(nullJurisdiction);
    const second = p.run(nullJurisdiction);
    expect(second.series.months[6]).toEqual(first.series.months[6]);
  });

  it("removes cleanly via removeTransaction — undo", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const id = p.spendOnce({
      month: 6,
      label: "New couch",
      amountCents: 200_000,
      fundingSourceIds: ["savings"],
    });
    p.removeTransaction(id);
    expect(p.ledger.events).toHaveLength(0);
  });

  it("revises a spend's data in place via spendOnce, keeping its id", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const id = p.spendOnce({
      month: 6,
      label: "New couch",
      amountCents: 200_000,
      fundingSourceIds: ["savings"],
    });
    p.reviseTransaction(id, { type: "spendOnce", amountCents: 300_000 });
    expect(p.ledger.events[0]).toMatchObject({ id, amountCents: 300_000, label: "New couch" });
  });
});
