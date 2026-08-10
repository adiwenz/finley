/**
 * `OneTimeSpendEvent` through the whole simulator, via its own
 * {@link oneTimeSpendObligation} builder. The funding/blocking/credit machinery itself is generic
 * over `FinancialObligation` — `simulate.blocking.test.ts` and `simulate.creditFunding.test.ts`
 * already pin it exhaustively — these tests pin only what is specific to this obligation shape:
 * that it is `treatment: "expense"` (so it never originates a property or mortgage when blocked),
 * that its funding total is excluded from the automatic waterfall, and the "gate == sim" parity
 * the issue calls out.
 */

import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import type { HouseholdSimInput, SimOwnedSeries, SimPerson } from "./simulate.types";
import { oneTimeSpendObligation, automaticFundingTotal, expenseReportingTotal } from "./financialObligation";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { RevolvingCard } from "../liability/liability";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { monthlyExpense } from "./simulate.testSupport";

const PERSON: SimPerson = { id: "p1", name: "Alice" };
const SPEND_MONTH = 3;
const AMOUNT = dollarsToCents(30_000);

function cash(id: string, openingCents: number): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

function retirementAccount(openingCents: number): SimAccount {
  return new SimAccount({
    id: "401k",
    ownerId: "p1",
    liquid: false,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

function spend(amountCents = AMOUNT, orderedAccountIds: readonly string[] = ["brokerage"]) {
  return oneTimeSpendObligation({
    id: "spend-1",
    label: "New roof",
    sourceEventId: "spend-1",
    month: SPEND_MONTH,
    amountCents,
    orderedAccountIds,
  });
}

function run(input: Partial<HouseholdSimInput> & Pick<HouseholdSimInput, "accounts">) {
  return simulateHousehold(
    {
      horizonMonths: 12,
      annualInflationRate: 0,
      persons: [PERSON],
      incomeSeries: [],
      expenseSeries: [],
      ...input,
    },
    nullJurisdiction,
  );
}

describe("OneTimeSpendEvent — funded from cash", () => {
  it("drains the named account and conserves net worth exactly", () => {
    const series = run({
      accounts: [cash("brokerage", dollarsToCents(50_000))],
      fundingDraws: [spend()],
    });

    expect(series.status).toBe("ran-to-horizon");
    const m = series.months[SPEND_MONTH];
    expect(m.accountBalancesCents.brokerage).toBe(dollarsToCents(20_000));
    expect(m.netWorthNominalCents).toBe(dollarsToCents(20_000));
  });

  it("appears in expenseReportingTotal at its full amount but never in automaticFundingTotal", () => {
    // The epic's double-count tripwire, at the full-obligations-list level: an automatic budget
    // line plus this explicit spend must sum together for reporting but the spend must vanish
    // from what the waterfall/decumulation is asked to cover.
    const budgetLine = monthlyExpense(dollarsToCents(2_000));
    const expense: SimOwnedSeries = {
      series: budgetLine,
      ownerId: "p1",
      label: "Living",
      obligationSource: { kind: "budgetLine", id: "living", category: "needs", editable: true },
    };
    const series = run({
      accounts: [cash("brokerage", dollarsToCents(50_000))],
      expenseSeries: [expense],
      fundingDraws: [spend()],
    });

    const obligations = series.months[SPEND_MONTH].flows?.obligations ?? [];
    expect(expenseReportingTotal(obligations)).toBe(dollarsToCents(2_000) + AMOUNT);
    expect(automaticFundingTotal(obligations)).toBe(dollarsToCents(2_000));
  });
});

describe("OneTimeSpendEvent — blocks rather than silently financing", () => {
  it("blocks at its month when the named sources fall short — the event stays authored, not thrown", () => {
    expect(() =>
      run({
        accounts: [cash("brokerage", dollarsToCents(5_000))],
        fundingDraws: [spend()],
      }),
    ).not.toThrow();

    const series = run({
      accounts: [cash("brokerage", dollarsToCents(5_000))],
      fundingDraws: [spend()],
    });
    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(SPEND_MONTH);
    // Nothing moved: the household keeps every cent.
    expect(series.months[SPEND_MONTH].accountBalancesCents.brokerage).toBe(dollarsToCents(5_000));
  });

  it("classifies funding-configuration when an unselected account could have covered it", () => {
    const series = run({
      accounts: [cash("brokerage", dollarsToCents(5_000)), cash("savings", dollarsToCents(50_000))],
      fundingDraws: [spend()],
    });
    const failure = series.blockingObligation?.fundingFailure;
    expect(failure?.kind).toBe("funding-configuration");
  });

  it("classifies no-eligible-source-suffices when only illiquid wealth remains", () => {
    const series = run({
      accounts: [cash("brokerage", dollarsToCents(5_000)), retirementAccount(dollarsToCents(2_000_000))],
      fundingDraws: [spend()],
    });
    const failure = series.blockingObligation?.fundingFailure;
    expect(failure?.kind).toBe("no-eligible-source-suffices");
  });
});

describe("OneTimeSpendEvent — a credit card among the named sources", () => {
  it("borrows against the card's headroom rather than selling an asset", () => {
    const series = run({
      accounts: [cash("checking", dollarsToCents(1_000))],
      liabilities: [new RevolvingCard({ id: "visa", ownerId: "p1", openingBalanceCents: 0, apr: 0, creditLimitCents: dollarsToCents(40_000) })],
      fundingDraws: [spend(AMOUNT, ["checking", "visa"])],
    });

    expect(series.status).toBe("ran-to-horizon");
    const m = series.months[SPEND_MONTH];
    expect(m.accountBalancesCents.checking).toBe(0);
    expect(m.liabilityBalancesCents.visa).toBe(AMOUNT - dollarsToCents(1_000));
  });

  it("never substitutes an unnamed card — a stranded spend still blocks", () => {
    const series = run({
      accounts: [cash("checking", dollarsToCents(1_000))],
      liabilities: [new RevolvingCard({ id: "visa", ownerId: "p1", openingBalanceCents: 0, apr: 0, creditLimitCents: dollarsToCents(40_000) })],
      fundingDraws: [spend(AMOUNT, ["checking"])],
    });

    expect(series.status).toBe("blocked");
    expect(series.months[SPEND_MONTH].liabilityBalancesCents.visa ?? 0).toBe(0);
  });
});

describe("OneTimeSpendEvent — sibling explicit events resolve in event-sequence order", () => {
  it("the second draw is validated against what the first left", () => {
    const first = oneTimeSpendObligation({
      id: "spend-1",
      label: "Roof",
      sourceEventId: "spend-1",
      month: SPEND_MONTH,
      amountCents: dollarsToCents(15_000),
      orderedAccountIds: ["brokerage"],
    });
    const second = oneTimeSpendObligation({
      id: "spend-2",
      label: "Car",
      sourceEventId: "spend-2",
      month: SPEND_MONTH,
      amountCents: dollarsToCents(15_000),
      orderedAccountIds: ["brokerage"],
    });
    // $20k covers the first $15k with $5k left, which cannot cover the second $15k.
    const series = run({
      accounts: [cash("brokerage", dollarsToCents(20_000))],
      fundingDraws: [first, second],
    });

    expect(series.status).toBe("blocked");
    // The first spend resolved and left its mark; the second is what blocks.
    expect(series.blockingObligation?.sourceEventId).toBe("spend-2");
    expect(series.blockingObligation?.availableCents).toBe(dollarsToCents(5_000));
  });
});

describe("OneTimeSpendEvent — gate == sim", () => {
  it("a spend authored in a month that also has decumulation predicts exactly the shortfall the simulator produces", () => {
    // No income and a monthly expense, so the household decumulates every month; the spend
    // competes with that same cash for the SAME month. The engine must report the identical
    // shortfall a caller pre-pricing the gate would compute against the same accounts.
    const expense: SimOwnedSeries = {
      series: monthlyExpense(dollarsToCents(3_000)),
      ownerId: "p1",
      label: "Living",
      obligationSource: { kind: "budgetLine", id: "living", category: "needs", editable: true },
    };
    const opening = dollarsToCents(10_000);
    const series = run({
      accounts: [cash("brokerage", opening)],
      expenseSeries: [expense],
      fundingDraws: [spend(AMOUNT, ["brokerage"])],
    });

    // Decumulation for living expenses draws automatically and is unaffected by the explicit
    // draw's shortfall classification — the gate prices the SAME account balance at the SAME
    // month the sim actually sees, so the two can never disagree about what it delivers.
    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(SPEND_MONTH);
    const block = series.blockingObligation;
    expect(block?.requiredCents).toBe(AMOUNT);
    // Nothing but the living expense touched the account before the spend's own month resolves,
    // so the available figure is exactly the opening balance net of the automatic draws already
    // taken for months 0..SPEND_MONTH.
    expect(block?.availableCents).toBeLessThanOrEqual(opening);
    expect(block?.shortfallCents).toBe((block?.requiredCents ?? 0) - (block?.availableCents ?? 0));
  });
});
