import { describe, it, expect } from "vitest";
import type { ProjectionSeries } from "@finley/engine";
import { buildAccountBalanceData } from "./accountBalanceSeries";

interface MonthSpec {
  readonly accounts?: Readonly<Record<string, number>>;
  readonly isInsolvent?: boolean;
}

function mkMonth(m: MonthSpec, month: number) {
  return {
    month,
    netWorthNominalCents: 0,
    netWorthRealCents: 0,
    accountBalancesCents: m.accounts ?? {},
    accountBasisCents: {},
    liabilityBalancesCents: {},
    liabilityPaymentRecords: {},
    propertyValuesCents: {},
    isInsolvent: m.isInsolvent ?? false,
    uncoveredCents: m.isInsolvent ? 1 : 0,
  };
}

function series(opening: MonthSpec, months: readonly MonthSpec[]): ProjectionSeries {
  const built = months.map(mkMonth);
  return {
    opening: mkMonth(opening, 0),
    months: built,
    status: "ran-to-horizon",
    simulatedThroughMonth: built.length - 1,
    obligationOutcomes: {},
  };
}

describe("buildAccountBalanceData", () => {
  it("seeds the first point with today's opening balance, then one point per month", () => {
    const data = buildAccountBalanceData(
      series({ accounts: { savings: 100000 } }, [
        { accounts: { savings: 101000 } },
        { accounts: { savings: 102000 } },
      ]),
      "savings",
    );
    expect(data.points).toEqual([
      { x: 0, balanceCents: 100000 },
      { x: 1, balanceCents: 101000 },
      { x: 2, balanceCents: 102000 },
    ]);
  });

  it("defaults to zero for a month with no entry for this account", () => {
    const data = buildAccountBalanceData(
      series({}, [{ accounts: { brokerage: 5000 } }]),
      "savings",
    );
    expect(data.points).toEqual([
      { x: 0, balanceCents: 0 },
      { x: 1, balanceCents: 0 },
    ]);
  });

  it("stops at the first insolvent month, like the other stock charts", () => {
    const data = buildAccountBalanceData(
      series({ accounts: { savings: 100000 } }, [
        { accounts: { savings: 90000 } },
        { accounts: { savings: 0 }, isInsolvent: true },
        { accounts: { savings: -50000 } },
      ]),
      "savings",
    );
    expect(data.points).toEqual([
      { x: 0, balanceCents: 100000 },
      { x: 1, balanceCents: 90000 },
    ]);
  });

  it("extends the axis to the plan's own horizon even when the series is shorter", () => {
    const data = buildAccountBalanceData(
      series({ accounts: { savings: 100000 } }, [{ accounts: { savings: 100000 } }]),
      "savings",
      36, // 3-year horizon
    );
    expect(data.xMax).toBe(36); // toAxisX(35) === 36
  });
});
