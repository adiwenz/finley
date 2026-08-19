/**
 * `OneTimeSpendEvent`: a dated, source-directed cash outflow. Like Home Purchase's down payment,
 * authoring hard-refuses when the selected sources cannot fully cover it — the same §4.5-style
 * gate, over the identical `fundingLookup` seam, so gate == sim holds one step earlier than the
 * projection block it used to rely on. These tests exercise the handler, the obligation it
 * produces, the expense-reporting tripwire, and the authoring-time gate (on both add and revise).
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent, fundingLookup, ledgerBeforeEvent, fundingLookupExcludingEvent } from "./addEvent";
import { updateEvent } from "./updateEvent";
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

describe("OneTimeSpendEvent — authoring refuses an unaffordable spend", () => {
  it("refuses a spend whose named source cannot possibly cover it", () => {
    const base = baseWith(1_000_00); // $1k liquid, spend wants $30k
    const result = addEvent(emptyLedger, base, spend({ amountCents: 30_000_00 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/exceeds what the eligible funding sources/);
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

  it("names an eligible unselected account in the refusal: funding-configuration", () => {
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
    const result = addEvent(
      emptyLedger,
      base,
      spend({ amountCents: 3_000_000, fundingSourceIds: ["savings"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toMatch(/brokerage \(\$50,000 available\)/);
    }
  });

  it("becomes possible once enough is selected — a card added atop cash covers the rest", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [savings(2_000_00)], // $2k
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

    // Cash alone ($2k) cannot cover a $6k spend — refused.
    const cashOnly = addEvent(withCard, base, spend({ amountCents: 6_000_00, fundingSourceIds: ["savings"] }));
    expect(cashOnly.ok).toBe(false);

    // Cash plus the card's headroom ($2k + $10k) covers it — accepted.
    const withCredit = addEvent(
      withCard,
      base,
      spend({ amountCents: 6_000_00, fundingSourceIds: ["savings", "visa"] }),
    );
    expect(withCredit.ok).toBe(true);
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
  it("the second is priced against what the first left, in event-sequence order", () => {
    const base = baseWith(5_000_000); // $50k
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 3, amountCents: 4_000_000, fundingSourceIds: ["savings"] }),
    );
    // $50k − $40k first leaves only $10k — the second's $20k ask is refused, not blocked later.
    const second = addEvent(
      ledger,
      base,
      spend({ id: "spend2", month: 3, amountCents: 2_000_000, fundingSourceIds: ["savings"] }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.conflict).toMatch(/\$10,000 available/);
  });

  it("sequential spends draining the same cash: a second within what's left succeeds, a third over it is refused", () => {
    const base = baseWith(1_000_000); // $10k
    let ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 3, amountCents: 400_000, fundingSourceIds: ["savings"] }),
    );
    // $10k − $4k = $6k left — a $6k second spend exactly fits.
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "spend2", month: 3, amountCents: 600_000, fundingSourceIds: ["savings"] }),
    );
    expect(ledger.events).toHaveLength(2);

    // Nothing is left — a third spend of any positive amount is refused.
    const third = addEvent(
      ledger,
      base,
      spend({ id: "spend3", month: 3, amountCents: 1, fundingSourceIds: ["savings"] }),
    );
    expect(third.ok).toBe(false);
  });
});

// Regression: `fundingLookup` (the picker's pool and the authoring gate) must show the REMAINING
// projected balance once a prior explicit draw has consumed a source — not the account's original
// balance. Month 0 is the specific case that was broken: it was treated as a pre-existing month
// (reading the untouched opening snapshot) rather than the first PROCESSED month, so a second
// month-0 spend never saw the first's draw. Covered at both month 0 and a later month, and with
// two spends sharing one month, so the fix is pinned at the READ side (`sourcesAt`/`availabilityAt`)
// rather than only at the simulator, which the sibling-events test above already covers.
describe("OneTimeSpendEvent — funding-source availability reflects prior spends", () => {
  it("month 0: a second spend sees the source drained by the first, not its original balance", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 0, amountCents: 1_000_000, fundingSourceIds: ["savings"] }),
    );
    const funding = fundingLookup(ledger, base, nullJurisdiction);

    const pool = funding.sourcesAt(0, "expense");
    expect(pool.find((s) => s.id === "savings")?.balanceCents).toBe(0);

    const gate = funding.availabilityAt("expense", ["savings"], 100, 0);
    expect(gate.availableCents).toBe(0);
    expect(gate.shortfallCents).toBe(100);
  });

  it("a later month: a second spend sees the source drained by an earlier same-month spend", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 5, amountCents: 1_000_000, fundingSourceIds: ["savings"] }),
    );
    const funding = fundingLookup(ledger, base, nullJurisdiction);

    const pool = funding.sourcesAt(5, "expense");
    expect(pool.find((s) => s.id === "savings")?.balanceCents).toBe(0);

    const gate = funding.availabilityAt("expense", ["savings"], 100, 5);
    expect(gate.availableCents).toBe(0);
    expect(gate.shortfallCents).toBe(100);
  });

  it("partial consumption: the pool shows exactly what a prior same-month spend left", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 0, amountCents: 400_000, fundingSourceIds: ["savings"] }),
    );
    const funding = fundingLookup(ledger, base, nullJurisdiction);

    expect(funding.sourcesAt(0, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      600_000,
    );
    const gate = funding.availabilityAt("expense", ["savings"], 600_000, 0);
    expect(gate.shortfallCents).toBe(0);
    expect(gate.availableCents).toBe(600_000);
  });

  it("a household with no month-0 draw is unaffected — the pool still reads the plain opening balance", () => {
    const base = baseWith(1_000_000); // $10k, no prior events
    const funding = fundingLookup(emptyLedger, base, nullJurisdiction);
    expect(funding.sourcesAt(0, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      1_000_000,
    );
  });

  it("does not carry a LATER month's draw backward onto an earlier month's pool", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 5, amountCents: 1_000_000, fundingSourceIds: ["savings"] }),
    );
    const funding = fundingLookup(ledger, base, nullJurisdiction);
    // A candidate priced at month 0 — before the month-5 draw — must still see the full balance.
    expect(funding.sourcesAt(0, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      1_000_000,
    );
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

describe("OneTimeSpendEvent — investment-funded spend is NOT grossed up for federal income tax", () => {
  it("draws exactly the spend amount from an appreciated source, no gross-up, and taxes the gain the following April", () => {
    const jur = bracketedCapitalGains(0, 0.3); // taxes every dollar of gain at 30%, no threshold
    const base: LedgerBaseConfig = {
      horizonMonths: 16,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [liquidAcct("brokerage", dollarsToCents(100_000), 0.12)],
    };
    const SPEND = dollarsToCents(20_000);
    // Six months of growth first, so the account holds embedded gain (basis < balance) by
    // the time the spend draws from it.
    const ledger = addWithBase(emptyLedger, base, spend({ month: 6, amountCents: SPEND, fundingSourceIds: ["brokerage"] }));
    const series = buildProjection(interpretLedger(ledger, base), base, jur);

    // Exactly $20k was sold — no gross-up, even though the sale realizes a taxable gain. The
    // account's END-of-month balance also reflects this month's growth, so read the actual
    // draw off the gain + returned-principal bands rather than the raw balance delta.
    const at = series.months[6];

    // The gain is recorded as capital-gains income immediately...
    const gainBand = at.flows!.incomeSources.find((s) => s.sourceId === `onetimespend:brokerage`);
    expect(gainBand?.category).toBe("capitalGains");
    expect(gainBand!.cashInflowCents).toBeGreaterThan(0);
    const drawdownBand = at.flows!.incomeSources.find((s) => s.category === "savingsDrawdown");
    // Gain + returned principal conserves to exactly the amount spent — no gross-up inflated it,
    // and nothing else was sold beside it, because the month withholds nothing against the sale.
    expect((gainBand?.cashInflowCents ?? 0) + (drawdownBand?.cashInflowCents ?? 0)).toBe(SPEND);

    // ...and nothing is charged for it until the following April. No payroll system sees a
    // brokerage sale, so no month of the year it falls in withholds a cent against it — including
    // the month it was realized in, and including December.
    const duringTheYear = series.months.slice(0, 12).map((m) => m.flows!.taxCents);
    for (const tax of duringTheYear) expect(tax).toBe(0);

    const april = series.months[15].flows!;
    // Exactly the naive 30% of the gain — NO gross-up anywhere, and no recursion: the year is
    // closed before anything is sold to pay it, so the April draw that funds the bill is 2027
    // income and cannot enlarge the 2026 bill it is settling.
    expect(april.taxCents).toBe(Math.round(gainBand!.cashInflowCents * 0.3));
    expect(april.taxCents).toBeGreaterThan(0);
  });
});

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
      // `cash` covers the spend with a little room, no gain; `nest` funds decumulation alone.
      // The room is for the year's estimated tax instalments, which `cash` pays as the liquid
      // buffer: the $150k decumulation really does realize ~$25k of gain on `nest`, over this
      // jurisdiction's $15k threshold, so the year owes tax and paces it monthly. Sizing `cash`
      // at exactly the spend made the fixture depend on those instalments being missed.
      initialAccounts: [
        liquidAcct("cash", DOWN + dollarsToCents(5_000), 0),
        liquidAcct("nest", 20_000_000, 0.1),
      ],
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

    const gate = fundingLookup(emptyLedger, base, jur).availabilityAt("expense", ["cash"], DOWN, 23);
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
    // And the month really did decumulate on top of the candidate — the drain the gate had to
    // keep off it. The tax that draw's gain causes belongs to this year and settles next April,
    // so it is not this month's charge to read.
    expect(at.accountBalancesCents.nest).toBeLessThan(series.months[22].accountBalancesCents.nest);
  });

  it("predicts a NONZERO shortfall that matches exactly what authoring refuses it for", () => {
    // Same decumulation-month seam as above, but `cash` is short of the spend on its own — the
    // gate must predict precisely the gap the authoring-time refusal reports, not merely agree
    // when the answer happens to be zero. Authoring now refuses this outright rather than
    // accepting it and letting the projection block later — gate == sim still holds, just
    // enforced one step earlier.
    const ASK = dollarsToCents(60_000);
    const CASH = dollarsToCents(45_000);
    // A threshold above the gain the month-23 decumulation realizes (~$17.7k), so the year owes
    // nothing and `cash` reaches month 23 whole. With a lower one the household spends the year
    // paying instalments of a correctly-estimated bill out of the very buffer this measures, and
    // the assertion below would be reading the tax estimate rather than the gate.
    const jur = bracketedCapitalGains(dollarsToCents(25_000), 0.4);
    const base: LedgerBaseConfig = {
      horizonMonths: 24,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: [liquidAcct("cash", CASH, 0), liquidAcct("nest", 20_000_000, 0.1)],
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
    const buy = spend({ month: 23, amountCents: ASK, fundingSourceIds: ["cash"] });

    const gate = fundingLookup(emptyLedger, base, jur).availabilityAt("expense", ["cash"], ASK, 23);
    expect(gate.shortfallCents).toBe(ASK - CASH);
    expect(gate.shortfallCents).toBeGreaterThan(0);

    const refused = addEvent(emptyLedger, base, buy, jur);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // The refusal names precisely the gate's own predicted available amount — the same figure,
    // never a second calculation.
    expect(refused.conflict).toContain(`$${(CASH / 100).toLocaleString("en-US")}`);
  });
});

// Regression: revising an existing spend must not count ITS OWN prior draw as already-spent
// money it is then asked to also cover. `updateEvent` prices the revision against the ledger
// WITHOUT the event being revised — the same "so far" ledger a brand-new candidate is priced
// against on `addEvent` — rather than the ledger the whole-ledger replay revalidates, which
// still carries the revision sitting in this event's own slot.
describe("OneTimeSpendEvent — revising does not count its own draw against itself", () => {
  it("saving an existing spend unchanged sees its own full amount as available", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 0, amountCents: 1_000_000, fundingSourceIds: ["savings"] }),
    );
    const result = updateEvent(
      ledger,
      "spend1",
      spend({ id: "spend1", month: 0, amountCents: 1_000_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(result.ok).toBe(true);
  });

  it("raising the amount past what's actually available (no other spend to draw from) is refused", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "spend1", month: 0, amountCents: 1_000_000, fundingSourceIds: ["savings"] }),
    );
    const result = updateEvent(
      ledger,
      "spend1",
      spend({ id: "spend1", month: 0, amountCents: 1_100_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(result.ok).toBe(false);
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

  it("revising a spend that already uses its full source doesn't lock itself out — the $10k/$10k case", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    // samplePlan's "savings" opens at $20k; draw all of it in one spend.
    const id = p.spendOnce({
      month: 0,
      label: "Full draw",
      amountCents: dollarsToCents(20_000),
      fundingSourceIds: ["savings"],
    });
    // Saving unchanged must not see the spend's own $20k draw as already spent, leaving $0.
    expect(() =>
      p.reviseTransaction(id, { type: "spendOnce", label: "Full draw (unchanged)" }),
    ).not.toThrow();
    // Raising it past what the source actually holds is still refused.
    expect(() =>
      p.reviseTransaction(id, { type: "spendOnce", amountCents: dollarsToCents(20_001) }),
    ).toThrow();
  });
});

// Regression: editing a same-month spend must price availability at ITS OWN sequence position —
// every EARLIER event (any month, or an earlier same-month sibling) counts against it, the event
// itself never counts against itself, and a LATER same-month sibling (authored after it, not yet
// "executed" from its point of view) must not shrink what it sees either. `ledgerBeforeEvent`
// (read by both `updateEvent`'s revise gate and `Projection.funding(excludeEventId)`) is the one
// seam this is pinned at, generalizing the month-0-only self-exclusion this file used to test
// into any position, any month.
describe("OneTimeSpendEvent — editing prices availability at the event's own sequence position", () => {
  // A=$4,000, B=$3,000, C=$2,000, all month 0, in that authored order, out of $10,000 cash.
  function threeSpendsSameMonth(base: LedgerBaseConfig): Ledger {
    let ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "A", month: 0, amountCents: 400_000, fundingSourceIds: ["savings"] }),
    );
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "B", month: 0, amountCents: 300_000, fundingSourceIds: ["savings"] }),
    );
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "C", month: 0, amountCents: 200_000, fundingSourceIds: ["savings"] }),
    );
    return ledger;
  }

  it("editing A (first): the full $10,000 is available — nothing precedes it", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const funding = fundingLookup(ledgerBeforeEvent(ledger, "A"), base, nullJurisdiction);
    expect(funding.sourcesAt(0, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      1_000_000,
    );
  });

  it("editing B (middle): $6,000 is available — A already spent, C hasn't executed from B's position", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const funding = fundingLookup(ledgerBeforeEvent(ledger, "B"), base, nullJurisdiction);
    expect(funding.sourcesAt(0, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      600_000,
    );
  });

  it("editing C (last): $3,000 is available — both A and B already executed", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const funding = fundingLookup(ledgerBeforeEvent(ledger, "C"), base, nullJurisdiction);
    expect(funding.sourcesAt(0, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      300_000,
    );
  });

  it("saving B unchanged succeeds — its own $3,000 draw never counts against itself", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const result = updateEvent(
      ledger,
      "B",
      spend({ id: "B", month: 0, amountCents: 300_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(result.ok).toBe(true);
  });

  it("raising B to $5,000 succeeds — $6,000 is available at B's own position", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const result = updateEvent(
      ledger,
      "B",
      spend({ id: "B", month: 0, amountCents: 500_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(result.ok).toBe(true);
  });

  it("a later sibling's own amount never changes what an earlier edit sees, even after it is revised", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const before = fundingLookup(ledgerBeforeEvent(ledger, "B"), base, nullJurisdiction)
      .sourcesAt(0, "expense")
      .find((s) => s.id === "savings")?.balanceCents;

    // C, authored after B, is revised down — still validly funded at C's own position ($3,000
    // available there), so the revision succeeds.
    const revisedC = updateEvent(
      ledger,
      "C",
      spend({ id: "C", month: 0, amountCents: 50_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(revisedC.ok).toBe(true);
    if (!revisedC.ok) return;

    const after = fundingLookup(ledgerBeforeEvent(revisedC.ledger, "B"), base, nullJurisdiction)
      .sourcesAt(0, "expense")
      .find((s) => s.id === "savings")?.balanceCents;
    expect(after).toBe(before);
  });

  it("raising A can save even though it leaves C unfundable — that becomes a normal simulation block, not a revise refusal", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    // A: $4,000 → $7,000. Nothing precedes A, so its own gate sees the full $10,000 and passes,
    // even though $10,000 − $7,000(A) − $3,000(B) leaves nothing for C's $2,000.
    const result = updateEvent(
      ledger,
      "A",
      spend({ id: "A", month: 0, amountCents: 700_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const series = buildProjection(interpretLedger(result.ledger, base), base, nullJurisdiction);
    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.sourceEventId).toBe("C");
  });
});

// Regression: moving an existing spend to a DIFFERENT month must price availability at its NEW
// month, against whoever would actually execute before it there — never against who preceded it
// at its OLD month. `ledgerBeforeEvent`'s `at` override (month, unchanged sequence number) is
// what both `updateEvent`'s revise gate and `fundingLookupExcludingEvent` (the picker's read) key
// off; this is the load-bearing case that would fail with a same-position-only exclusion.
describe("OneTimeSpendEvent — moving a spend to a different month reprices at its NEW position", () => {
  // A=$4,000, B=$3,000, C=$2,000, all month 0, in that authored order, out of $10,000 cash.
  function threeSpendsSameMonth(base: LedgerBaseConfig): Ledger {
    let ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "A", month: 0, amountCents: 400_000, fundingSourceIds: ["savings"] }),
    );
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "B", month: 0, amountCents: 300_000, fundingSourceIds: ["savings"] }),
    );
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "C", month: 0, amountCents: 200_000, fundingSourceIds: ["savings"] }),
    );
    return ledger;
  }

  it("moving B to month 1: sees $4,000 — A AND C (both month 0, now before it) count, not just A", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const funding = fundingLookupExcludingEvent(ledger, base, nullJurisdiction, "B");
    // $10,000 − $4,000(A) − $2,000(C) = $4,000 — never $6,000, the OLD-position figure.
    expect(funding.sourcesAt(1, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      400_000,
    );
    expect(funding.availabilityAt("expense", ["savings"], 400_000, 1).shortfallCents).toBe(0);
    expect(funding.availabilityAt("expense", ["savings"], 500_000, 1).shortfallCents).toBe(100_000);
  });

  it("saving B moved to month 1 at $4,000 succeeds; at $5,000 (over what's available there) is refused", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const fits = updateEvent(
      ledger,
      "B",
      spend({ id: "B", month: 1, amountCents: 400_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(fits.ok).toBe(true);

    const tooMuch = updateEvent(
      ledger,
      "B",
      spend({ id: "B", month: 1, amountCents: 500_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(tooMuch.ok).toBe(false);
  });

  it("moving B earlier than A and C (still same month as neither): sees the full $10,000", () => {
    // A different fixture — A, B, C all authored at month 5 this time, so B has somewhere
    // earlier to move TO that still isn't a negative month.
    const base = baseWith(1_000_000); // $10k
    let ledger = addWithBase(
      emptyLedger,
      base,
      spend({ id: "A", month: 5, amountCents: 400_000, fundingSourceIds: ["savings"] }),
    );
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "B", month: 5, amountCents: 300_000, fundingSourceIds: ["savings"] }),
    );
    ledger = addWithBase(
      ledger,
      base,
      spend({ id: "C", month: 5, amountCents: 200_000, fundingSourceIds: ["savings"] }),
    );

    const funding = fundingLookupExcludingEvent(ledger, base, nullJurisdiction, "B");
    expect(funding.sourcesAt(1, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      1_000_000,
    );

    const moved = updateEvent(
      ledger,
      "B",
      spend({ id: "B", month: 1, amountCents: 1_000_000, fundingSourceIds: ["savings"] }),
      base,
      nullJurisdiction,
    );
    expect(moved.ok).toBe(true);
  });

  it("the picker reprices live as the draft's month changes, off ONE lookup handle — no re-fetch needed", () => {
    const base = baseWith(1_000_000); // $10k
    const ledger = threeSpendsSameMonth(base);
    const funding = fundingLookupExcludingEvent(ledger, base, nullJurisdiction, "B");
    // Still at month 0 (B's original position): A already spent, C has not — $6,000.
    expect(funding.sourcesAt(0, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      600_000,
    );
    // Dragged to month 1: both A and C now precede it — $4,000.
    expect(funding.sourcesAt(1, "expense").find((s) => s.id === "savings")?.balanceCents).toBe(
      400_000,
    );
  });
});
