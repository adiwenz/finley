/**
 * Projection blocking: when an explicitly-funded obligation's named sources cannot cover it, the
 * simulator stops rather than fabricating the asset. The seam is `simulateHousehold`'s public
 * output — `status`, `simulatedThroughMonth`, `blockedAtMonth`, `blockingObligation`, and the
 * truncated `months`.
 *
 * The invariant these tests pin: the engine stays truthful. A blocked home purchase originates no
 * property and no mortgage, drains no account, and mints no net worth; the blocked month is the
 * last one emitted, its balances a genuine end-of-month figure.
 */

import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import type { HouseholdSimInput, SimOwnedSeries, SimPerson, SimProperty } from "./simulate.types";
import { assetAcquisitionObligation } from "./financialObligation";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../simAccount";
import { AmortizingLoan, RevolvingCard } from "../liability";
import { dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction";
import { monthlyExpense } from "./simulate.testSupport";

const PERSON: SimPerson = { id: "p1", name: "Alice" };

const DOWN = 8_000_000; // $80k down payment
const PRICE = 40_000_000; // $400k home
const FINANCED = PRICE - DOWN; // $320k mortgage
const BLOCK_MONTH = 3;

/** A liquid cash account; basis == balance ⇒ a draw books no gain and no tax. */
function savings(openingCents: number): SimAccount {
  return new SimAccount({
    id: "savings",
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

/** The property half of a financed home purchase caused by event `buy1`. */
const house: SimProperty = {
  id: "house1",
  ownerId: "p1",
  startMonth: BLOCK_MONTH,
  endMonth: null,
  openingValueCents: PRICE,
  appreciationAnnualRate: 0,
  causedByEventId: "buy1",
  mortgageLiabilityId: "mtg1",
};

/** The financing mortgage originating at the purchase month. */
function mortgage(): AmortizingLoan {
  return new AmortizingLoan({
    id: "mtg1",
    ownerId: "p1",
    kind: "mortgage",
    openingBalanceCents: FINANCED,
    startMonth: BLOCK_MONTH,
    apr: 0,
    termMonths: 360,
  });
}

/** The down-payment draw for event `buy1`, drained from `savings` at the purchase month. */
function downPayment(amountCents: number) {
  return assetAcquisitionObligation({
    id: "downpayment:buy1",
    sourceId: "downpayment",
    sourceEventId: "buy1",
    month: BLOCK_MONTH,
    amountCents,
    orderedAccountIds: ["savings"],
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

describe("projection blocking — an unfundable purchase", () => {
  it("blocks at the purchase month when the source cannot cover the draw", () => {
    // $50k savings cannot cover an $80k down payment: a $30k shortfall blocks the month.
    const series = run({
      accounts: [savings(5_000_000)],
      properties: [house],
      liabilities: [mortgage()],
      fundingDraws: [downPayment(DOWN)],
    });

    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(BLOCK_MONTH);
    // The blocked month is emitted; nothing after it is.
    expect(series.simulatedThroughMonth).toBe(BLOCK_MONTH);
    expect(series.months).toHaveLength(BLOCK_MONTH + 1);
    expect(series.months[BLOCK_MONTH].month).toBe(BLOCK_MONTH);
  });

  it("originates no property, mortgage, or drained cash — no fictional equity", () => {
    const series = run({
      accounts: [savings(5_000_000)],
      properties: [house],
      liabilities: [mortgage()],
      fundingDraws: [downPayment(DOWN)],
    });

    const blocked = series.months[BLOCK_MONTH];
    // The property never appears — the original bug minted its equity out of the funding gap.
    expect(blocked.propertyValuesCents.house1 ?? 0).toBe(0);
    // The mortgage never originates: no phantom $320k asset offset.
    expect(blocked.liabilityBalancesCents.mtg1 ?? 0).toBe(0);
    // The household keeps every cent it could not spend.
    expect(blocked.accountBalancesCents.savings).toBe(5_000_000);
    // Genuine end-of-month net worth — exactly the retained cash, not inflated by the house.
    expect(blocked.netWorthNominalCents).toBe(5_000_000);
  });

  it("reports the funding shortfall on the blocking obligation", () => {
    const series = run({
      accounts: [savings(5_000_000)],
      properties: [house],
      liabilities: [mortgage()],
      fundingDraws: [downPayment(DOWN)],
    });

    const block = series.blockingObligation;
    expect(block).toBeDefined();
    expect(block?.sourceEventId).toBe("buy1");
    expect(block?.month).toBe(BLOCK_MONTH);
    expect(block?.requiredCents).toBe(DOWN);
    expect(block?.availableCents).toBe(5_000_000);
    expect(block?.shortfallCents).toBe(DOWN - 5_000_000);
    // The presentation marker sits the shortfall below the genuine $50k net worth: $50k − $30k.
    expect(block?.markerNetWorthCents).toBe(5_000_000 - (DOWN - 5_000_000));
  });

  it("reports blocked even when the same month has also exhausted its credit", () => {
    // Block strictly precedes insolvency: the draw is pre-flighted before the cascade runs, so a
    // month that both strands a purchase AND exhausts every card is BLOCKED, not merely insolvent.
    // A $60k/mo spend on $50k savings and a $5k card exhausts both within the first month.
    const expense: SimOwnedSeries = {
      series: monthlyExpense(dollarsToCents(60_000)),
      ownerId: "p1",
      label: "Living",
      obligationSource: { kind: "budgetLine", id: "living", category: "needs", editable: true },
    };
    const series = run({
      accounts: [savings(5_000_000)],
      properties: [house],
      liabilities: [
        mortgage(),
        new RevolvingCard({ id: "visa", ownerId: "p1", openingBalanceCents: 0, apr: 0.22, creditLimitCents: 500_000 }),
      ],
      expenseSeries: [expense],
      fundingDraws: [downPayment(DOWN)],
    });

    // A no-income household on a small card is insolvent by the blocked month...
    expect(series.months[BLOCK_MONTH].isInsolvent).toBe(true);
    // ...yet the projection's terminal state is the block, not the insolvency.
    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(BLOCK_MONTH);
    expect(series.months).toHaveLength(BLOCK_MONTH + 1);
  });

  it("leaves insolvency untouched: an unblocked insolvent plan still runs to the horizon", () => {
    // No funding draw, so nothing blocks. A plan that outspends its cash and credit goes insolvent
    // and keeps simulating with net worth nulled — the existing behavior, distinct from blocked.
    const expense: SimOwnedSeries = {
      series: monthlyExpense(dollarsToCents(6_000)),
      ownerId: "p1",
      label: "Living",
      obligationSource: { kind: "budgetLine", id: "living", category: "needs", editable: true },
    };
    const series = run({
      accounts: [savings(1_000_000)],
      liabilities: [
        new RevolvingCard({ id: "visa", ownerId: "p1", openingBalanceCents: 0, apr: 0.22, creditLimitCents: 500_000 }),
      ],
      expenseSeries: [expense],
    });

    expect(series.status).toBe("ran-to-horizon");
    expect(series.blockedAtMonth).toBeUndefined();
    expect(series.months).toHaveLength(12);
    const insolventMonth = series.months.find((m) => m.isInsolvent);
    expect(insolventMonth).toBeDefined();
    // Net worth is nulled from insolvency on, not truncated.
    expect(insolventMonth?.netWorthNominalCents).toBeNull();
  });

  it("suppresses a LATER same-month purchase too, whose draw the block skipped", () => {
    // Two purchases in the same month. The first ($80k down on $50k savings) blocks, which stops
    // funding resolution — so the second's $30k down payment is never withdrawn either, even though
    // it would have been affordable on its own. Its house and mortgage must not originate: their
    // funding did not happen. Suppressing only the BLOCKING event left this pair minting a $500k
    // property and a $470k loan against cash that never moved.
    const secondHouse: SimProperty = {
      id: "house2",
      ownerId: "p1",
      startMonth: BLOCK_MONTH,
      endMonth: null,
      openingValueCents: 50_000_000,
      appreciationAnnualRate: 0,
      causedByEventId: "buy2",
      mortgageLiabilityId: "mtg2",
    };
    const secondMortgage = new AmortizingLoan({
      id: "mtg2",
      ownerId: "p1",
      kind: "mortgage",
      openingBalanceCents: 47_000_000,
      startMonth: BLOCK_MONTH,
      apr: 0,
      termMonths: 360,
    });
    const secondDownPayment = assetAcquisitionObligation({
      id: "downpayment:buy2",
      sourceId: "downpayment2",
      sourceEventId: "buy2",
      month: BLOCK_MONTH,
      amountCents: 3_000_000,
      orderedAccountIds: ["savings"],
    });

    const series = run({
      accounts: [savings(5_000_000)],
      properties: [house, secondHouse],
      liabilities: [mortgage(), secondMortgage],
      fundingDraws: [downPayment(DOWN), secondDownPayment],
    });

    expect(series.status).toBe("blocked");
    const blocked = series.months[BLOCK_MONTH];
    // Neither down payment was withdrawn: every cent is retained.
    expect(blocked.accountBalancesCents.savings).toBe(5_000_000);
    // Neither property was created.
    expect(blocked.propertyValuesCents.house1 ?? 0).toBe(0);
    expect(blocked.propertyValuesCents.house2 ?? 0).toBe(0);
    // Neither mortgage was originated.
    expect(blocked.liabilityBalancesCents.mtg1 ?? 0).toBe(0);
    expect(blocked.liabilityBalancesCents.mtg2 ?? 0).toBe(0);
    // No fictional equity from either purchase — just the retained cash.
    expect(blocked.netWorthNominalCents).toBe(5_000_000);
    // Reporting is unchanged: the block is the FIRST purchase and its shortfall, not the second's.
    expect(series.blockingObligation?.sourceEventId).toBe("buy1");
    expect(series.blockingObligation?.requiredCents).toBe(DOWN);
    expect(series.blockingObligation?.shortfallCents).toBe(DOWN - 5_000_000);
    // Both events are reported omitted — the blocker first, then the draw it skipped.
    expect(series.omittedSourceEventIds).toEqual(["buy1", "buy2"]);
  });

  it("keeps an EARLIER same-month purchase, whose draw resolved before the block", () => {
    // Order matters the other way too: a draw that resolved BEFORE the block really did spend its
    // money, so its house and mortgage stand. $50k savings funds buy2's $10k down payment, then
    // buy1's $80k blocks — suppression must not over-reach onto the purchase that completed.
    const firstHouse: SimProperty = {
      id: "house2",
      ownerId: "p1",
      startMonth: BLOCK_MONTH,
      endMonth: null,
      openingValueCents: 5_000_000,
      appreciationAnnualRate: 0,
      causedByEventId: "buy2",
      mortgageLiabilityId: "mtg2",
    };
    const firstMortgage = new AmortizingLoan({
      id: "mtg2",
      ownerId: "p1",
      kind: "mortgage",
      openingBalanceCents: 4_000_000,
      startMonth: BLOCK_MONTH,
      apr: 0,
      termMonths: 360,
    });
    const firstDownPayment = assetAcquisitionObligation({
      id: "downpayment:buy2",
      sourceId: "downpayment2",
      sourceEventId: "buy2",
      month: BLOCK_MONTH,
      amountCents: 1_000_000,
      orderedAccountIds: ["savings"],
    });

    const series = run({
      accounts: [savings(5_000_000)],
      properties: [firstHouse, house],
      liabilities: [firstMortgage, mortgage()],
      // buy2 resolves first, buy1 second.
      fundingDraws: [firstDownPayment, downPayment(DOWN)],
    });

    expect(series.status).toBe("blocked");
    const blocked = series.months[BLOCK_MONTH];
    // buy2's draw applied: $50k − $10k.
    expect(blocked.accountBalancesCents.savings).toBe(4_000_000);
    // ...and its artifacts stand.
    expect(blocked.propertyValuesCents.house2).toBe(5_000_000);
    expect(blocked.liabilityBalancesCents.mtg2).toBe(4_000_000);
    // buy1's do not.
    expect(blocked.propertyValuesCents.house1 ?? 0).toBe(0);
    expect(blocked.liabilityBalancesCents.mtg1 ?? 0).toBe(0);
    // Only the blocking event is omitted; the completed purchase is not.
    expect(series.omittedSourceEventIds).toEqual(["buy1"]);
    expect(series.blockingObligation?.sourceEventId).toBe("buy1");
    // The block prices against the balance buy2's draw left behind: $80k − $40k.
    expect(series.blockingObligation?.availableCents).toBe(4_000_000);
  });

  it("does not throw and runs to the horizon when the purchase is funded", () => {
    // $100k savings covers the $80k down payment: the purchase executes and the plan runs on.
    const series = run({
      accounts: [savings(10_000_000)],
      properties: [house],
      liabilities: [mortgage()],
      fundingDraws: [downPayment(DOWN)],
    });

    expect(series.status).toBe("ran-to-horizon");
    expect(series.blockedAtMonth).toBeUndefined();
    expect(series.simulatedThroughMonth).toBe(11);
    expect(series.months).toHaveLength(12);
    // Net worth is conserved: −$80k cash, +$400k property, −$320k mortgage.
    const m = series.months[BLOCK_MONTH];
    expect(m.accountBalancesCents.savings).toBe(10_000_000 - DOWN);
    expect(m.propertyValuesCents.house1).toBe(PRICE);
    expect(m.liabilityBalancesCents.mtg1).toBe(FINANCED);
    expect(m.netWorthNominalCents).toBe(10_000_000);
  });
});
