/**
 * **Where the down payment actually comes from, and what taking it out costs.**
 *
 * Selected sources drain in order, each taken to zero before the next is touched and each getting
 * its own outflow. Liquidating an appreciated source realizes a taxable gain, which surfaces in
 * the flow view as capital gains beside the principal's drawdown. Explicit draws resolve BEFORE
 * the automatic waterfall, so a purchase sells its own sources first and decumulation sizes
 * against what is left; two purchases in one month resolve in event sequence, each seeing what
 * its predecessor left rather than the pre-funding balance.
 *
 * Whether the purchase is authorable in the first place is
 * `events.homePurchase.downPaymentGate.test.ts`; the event's own lifecycle is
 * `events.homePurchase.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger } from "./ledger";
import { addEvent } from "./addEvent";
import { interpretLedger } from "./interpret";
import { buildProjection } from "../projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledgerBase";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import type { PersonId } from "../job/job";
import { SYNTHETIC_CARD_ID } from "../liability/liability";
import {
  DOWN,
  FINANCED,
  PRICE,
  addFinanced,
  addWithBase,
  baseWithAccounts,
  flatCapitalGains,
  liquidAcct,
  purchase,
} from "./events.homePurchase.testUtils";

// Sources drain in order, each taken to zero before the next is touched; each gets its own outflow.


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
    expect(at.liabilityBalancesCents["house1-mortgage"]).toBe(FINANCED);
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
