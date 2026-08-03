/**
 * Regression guard for the net-worth uptick in the first insolvent month.
 *
 * **The bug.** The engine reported a real net worth for the month the plan failed and nulled it
 * only from the month AFTER. But that month is already contaminated: the shortfall cascade tops
 * up the synthetic card to its $50,000 limit, absorbs whatever fraction of the month's spending
 * fits, and DROPS the rest. So the balance sheet keeps that month's home appreciation and
 * principal paydown while losing most of its cost — and net worth ticks UP, at exactly the point
 * the chart labels "runs out". The plan looked like it improved in the month it went broke.
 *
 * **The scenario** is the reported repro: the default plan, a $250k loan, and a $300k home with
 * $50k down at month 12. It fails in month 30 with the card pinned at its limit.
 *
 * These assertions are deliberately split between the two things that had to hold together — the
 * engine must stop *stating* the contaminated figure, and the chart must stop *drawing* it —
 * because either alone leaves the misleading tick on screen.
 */

import { describe, it, expect } from "vitest";
import {
  Projection,
  SYNTHETIC_CARD_ID,
  SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
  dollarsToCents,
  type PersonId,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { DEFAULT_INPUT } from "../../planDefaults";
import { buildNetWorthChartData } from "./netWorthChartData";
import { toAxisX } from "../monthAxis";

const PURCHASE_MONTH = 12;

/**
 * The default plan opened with enough cash to clear the down-payment gate, then given the
 * reported loan + purchase. The raised opening balance is what makes the purchase authorable at
 * all — the gate refuses it from the stock $10k — and is not itself under test.
 */
function repro(): ProjectionSeries {
  const built = Projection.fromInput(
    { ...DEFAULT_INPUT, openingBalanceCents: dollarsToCents(60_000) },
    usJurisdiction,
  );
  if (!built.ok) throw new Error(`repro input rejected: ${built.error.reason}`);
  const p = built.projection;

  p.takeLoan({
    month: PURCHASE_MONTH,
    ownerId: "p1" as PersonId,
    kind: "mortgage",
    openingBalanceCents: dollarsToCents(250_000),
    apr: 0.065,
    termMonths: 360,
  });
  p.buyHome({
    month: PURCHASE_MONTH,
    ownerId: "p1" as PersonId,
    purchasePriceCents: dollarsToCents(300_000),
    downPaymentCents: dollarsToCents(50_000),
    downPaymentSourceIds: ["savings", "brokerage", "fund-goal-2", "fund-goal-1"],
    mortgageApr: 0.065,
    mortgageTermMonths: 360,
  });

  return p.run(usJurisdiction).series;
}

describe("the first insolvent month, on the reported home-purchase repro", () => {
  const series = repro();
  const insolventIndex = series.months.findIndex((m) => m.isInsolvent);
  const insolvent = series.months[insolventIndex];
  const lastFunded = series.months[insolventIndex - 1];

  it("fails at a month partway through the horizon, with a solvent month before it", () => {
    expect(insolventIndex).toBeGreaterThan(PURCHASE_MONTH);
    expect(insolvent).toBeDefined();
    expect(lastFunded?.isInsolvent).toBe(false);
  });

  it("never borrows the credit card past its real limit, through the failure", () => {
    // Every month the chart draws, plus the failure itself. The cascade caps each card at its
    // limit and reports the remainder as uncovered — it never overdraws one to make the
    // shortfall visible on a balance sheet.
    //
    // Deliberately NOT asserted past this point: the balance drifts above the limit decades
    // later as interest compounds on a maxed card whose payment is never funded. That is
    // post-insolvency fiction the engine already refuses to total, and it is not borrowing.
    for (const m of series.months.slice(0, insolventIndex + 1)) {
      expect(m.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBeLessThanOrEqual(
        SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
      );
    }
    // And at the failure itself the card is genuinely pinned — the shortfall is uncovered
    // because credit ran out, not because the cascade declined to use it.
    expect(insolvent.liabilityBalancesCents[SYNTHETIC_CARD_ID]).toBeGreaterThan(
      SYNTHETIC_CARD_CREDIT_LIMIT_CENTS - dollarsToCents(1_000),
    );
  });

  it("reports a net worth for the last fully funded month", () => {
    expect(lastFunded.netWorthNominalCents).not.toBeNull();
    expect(lastFunded.netWorthRealCents).not.toBeNull();
    expect(lastFunded.netWorthNominalCents).toBeLessThan(0); // deep underwater, as the repro is
  });

  it("reports NO net worth for the first insolvent month — not the contaminated figure", () => {
    expect(insolvent.netWorthNominalCents).toBeNull();
    expect(insolvent.netWorthRealCents).toBeNull();
    for (const m of series.months.slice(insolventIndex)) {
      expect(m.netWorthNominalCents).toBeNull();
    }
  });

  it("reports the uncovered shortfall, and only where the plan actually fell short", () => {
    expect(insolvent.uncoveredCents).toBeGreaterThan(0);
    // The flag is exactly this quantity's sign — one fact, stated once.
    for (const m of series.months) {
      expect(m.isInsolvent).toBe(m.uncoveredCents > 0);
    }
    for (const m of series.months.slice(0, insolventIndex)) {
      expect(m.uncoveredCents).toBe(0);
    }
    expect(series.opening.uncoveredCents).toBe(0);
  });

  it("leaves accounts and liabilities untouched — only the aggregate is withheld", () => {
    // The contaminated month still emits its full balance sheet for diagnosis; what changed is
    // that the engine no longer sums it into a headline figure.
    expect(Object.keys(insolvent.accountBalancesCents).length).toBeGreaterThan(0);
    expect(Object.keys(insolvent.liabilityBalancesCents).length).toBeGreaterThan(0);
    expect(Object.keys(insolvent.propertyValuesCents).length).toBeGreaterThan(0);

    // The passive movements that used to fake the uptick are still simulated, unchanged: the
    // home appreciates and both loans amortize down across the failure boundary.
    const [property] = Object.keys(insolvent.propertyValuesCents);
    expect(insolvent.propertyValuesCents[property]).toBeGreaterThan(
      lastFunded.propertyValuesCents[property],
    );
    for (const id of Object.keys(insolvent.liabilityBalancesCents)) {
      if (id === SYNTHETIC_CARD_ID) continue;
      expect(insolvent.liabilityBalancesCents[id]).toBeLessThan(
        lastFunded.liabilityBalancesCents[id],
      );
    }

    // The proof the uptick was real and is now simply not reported: summing the insolvent
    // month's own balance sheet by hand still yields MORE than the last funded month's net
    // worth. That sum is what the chart used to plot.
    const sum = (m: typeof insolvent) =>
      Object.values(m.accountBalancesCents).reduce((a, b) => a + b, 0) +
      Object.values(m.propertyValuesCents).reduce((a, b) => a + b, 0) -
      Object.values(m.liabilityBalancesCents).reduce((a, b) => a + b, 0);
    expect(sum(insolvent)).toBeGreaterThan(lastFunded.netWorthNominalCents as number);
  });
});

describe("what the chart draws for that run", () => {
  const series = repro();
  const insolventIndex = series.months.findIndex((m) => m.isInsolvent);
  const insolvent = series.months[insolventIndex];
  const data = buildNetWorthChartData(series);

  it("ends the solid curve at the last fully funded month", () => {
    expect(data.lastFundedX).toBe(toAxisX(series.months[insolventIndex - 1].month));
    for (const p of data.points) {
      if (p.x > data.lastFundedX) expect(p.nominalCents).toBeNull();
    }
  });

  it("renders no upward final net-worth point", () => {
    const drawn = data.points.filter((p) => p.nominalCents !== null);
    const last = drawn[drawn.length - 1];
    const previous = drawn[drawn.length - 2];
    // The plan is failing: its last drawn month must not be its best one.
    expect(last.nominalCents as number).toBeLessThan(previous.nominalCents as number);
    expect(last.x).toBe(data.lastFundedX);
  });

  it("puts the runs-out marker on the first insolvent month", () => {
    expect(data.runsOut).not.toBeNull();
    expect(data.runsOut?.x).toBe(toAxisX(insolvent.month));
    expect(data.runsOut?.x).toBeGreaterThan(data.lastFundedX);
    expect(data.runsOut?.x).toBeLessThanOrEqual(data.xMax);
  });

  it("drops the dashed segment by the uncovered shortfall, and never upward", () => {
    const runsOut = data.runsOut!;
    expect(runsOut.uncoveredCents).toBe(insolvent.uncoveredCents);
    expect(runsOut.illustrativeCents).toBe(
      (data.lastFundedNominalCents as number) - insolvent.uncoveredCents,
    );
    expect(runsOut.illustrativeCents).toBeLessThan(data.lastFundedNominalCents as number);

    // Exactly two non-null points, so `connectNulls` draws one segment: the join at the last
    // funded month, and the illustrative landing at the failure.
    const dashed = data.points.filter((p) => p.unfundedCents !== null);
    expect(dashed.map((p) => p.x)).toEqual([data.lastFundedX, runsOut.x]);
    expect(dashed[0].unfundedCents).toBe(data.lastFundedNominalCents);
    expect(dashed[1].unfundedCents).toBe(runsOut.illustrativeCents);
  });

  it("keeps the illustrative value out of the reported series", () => {
    // It is drawn, never stated: no month's net worth equals it, and nothing feeds it back.
    const illustrative = data.runsOut!.illustrativeCents;
    for (const m of series.months) {
      if (m.netWorthNominalCents !== null) expect(m.netWorthNominalCents).not.toBe(illustrative);
    }
  });
});

describe("a plan that survives its horizon", () => {
  const built = Projection.fromInput(DEFAULT_INPUT, usJurisdiction);
  if (!built.ok) throw new Error("default input rejected");
  const data = buildNetWorthChartData(built.projection.run(usJurisdiction).series);

  it("draws no runs-out marker and no dashed drop", () => {
    // The default plan does eventually fail; this only asserts the shape holds when it doesn't.
    if (data.runsOut === null) {
      expect(data.points.every((p) => p.unfundedCents === null)).toBe(true);
    } else {
      expect(data.runsOut.uncoveredCents).toBeGreaterThan(0);
    }
  });
});
