import { describe, it, expect } from "vitest";
import type { ProjectionSeries } from "@finley/engine";
import { buildNetWorthBreakdown, type BreakdownMeta } from "./netWorthBreakdown";

/**
 * A hand-built projection: one month per spec, only the balance maps moving. Mirrors the
 * engine's own minimal-series test helper so these pin exactly the breakdown logic (band
 * selection, ordering, sign, insolvency truncation) with no simulator in the loop.
 */
interface MonthSpec {
  readonly accounts?: Readonly<Record<string, number>>;
  readonly properties?: Readonly<Record<string, number>>;
  readonly liabilities?: Readonly<Record<string, number>>;
  readonly isInsolvent?: boolean;
}

function series(months: readonly MonthSpec[]): ProjectionSeries {
  return {
    months: months.map((m, month) => ({
      month,
      netWorthNominalCents: 0,
      netWorthRealCents: 0,
      accountBalancesCents: m.accounts ?? {},
      liabilityBalancesCents: m.liabilities ?? {},
      liabilityPaymentRecords: {},
      propertyValuesCents: m.properties ?? {},
      isInsolvent: m.isInsolvent ?? false,
    })),
  };
}

// Standing accounts in plan order, mirroring what planAccountDescriptors returns.
const META: BreakdownMeta = {
  accounts: [
    { id: "savings", label: "Cash savings" },
    { id: "retirement", label: "Retirement account" },
    { id: "brokerage", label: "Brokerage" },
    { id: "goal-emg", label: "Emergency fund" },
  ],
};

describe("buildNetWorthBreakdown", () => {
  it("keeps only accounts that ever hold money, labelled and in meta order", () => {
    const data = buildNetWorthBreakdown(
      series([
        { accounts: { savings: 1000, "goal-emg": 0, retirement: 0, brokerage: 0 } },
        { accounts: { savings: 1200, "goal-emg": 500, retirement: 0, brokerage: 0 } },
      ]),
      META,
    );
    // savings and the goal fund carry money; retirement and brokerage never do → dropped.
    expect(data.bands.map((b) => b.label)).toEqual(["Cash savings", "Emergency fund"]);
    expect(data.bands.every((b) => b.kind === "account")).toBe(true);
    expect(data.hasProperties).toBe(false);
    expect(data.hasLiabilities).toBe(false);
  });

  it("orders accounts by the meta, then any series-only account id after them", () => {
    const data = buildNetWorthBreakdown(
      series([{ accounts: { brokerage: 10, savings: 10, "goal-late": 10 } }]),
      META,
    );
    // brokerage before savings would be wrong: meta order is savings…brokerage; the
    // unknown "goal-late" (not in meta) sorts last.
    expect(data.bands.map((b) => b.id)).toEqual(["savings", "brokerage", "goal-late"]);
  });

  it("adds property and liability bands, and reports the flags that gate the views", () => {
    const meta: BreakdownMeta = {
      ...META,
      liabilityLabels: { "mortgage-1": "Mortgage" },
    };
    const data = buildNetWorthBreakdown(
      series([
        {
          accounts: { savings: 5000 },
          properties: { "home-1": 40000 },
          liabilities: { "mortgage-1": 30000 },
        },
      ]),
      meta,
    );
    expect(data.hasProperties).toBe(true);
    expect(data.hasLiabilities).toBe(true);
    const byKind = (k: string) => data.bands.filter((b) => b.kind === k).map((b) => b.label);
    expect(byKind("account")).toEqual(["Cash savings"]);
    expect(byKind("property")).toEqual(["Home"]); // humanized from "home-1" (no property label given)
    expect(byKind("liability")).toEqual(["Mortgage"]); // from liabilityLabels
    // Bands stack accounts → property → liability.
    expect(data.bands.map((b) => b.kind)).toEqual(["account", "property", "liability"]);
  });

  it("computes terminal net worth as assets minus liabilities", () => {
    const meta: BreakdownMeta = { ...META, liabilityLabels: { "mortgage-1": "Mortgage" } };
    const data = buildNetWorthBreakdown(
      series([
        { accounts: { savings: 5000 }, properties: { "home-1": 40000 }, liabilities: { "mortgage-1": 30000 } },
        { accounts: { savings: 6000 }, properties: { "home-1": 41000 }, liabilities: { "mortgage-1": 29000 } },
      ]),
      meta,
    );
    // Last month: 6000 + 41000 − 29000 = 18000.
    expect(data.terminalNetWorthCents).toBe(18000);
  });

  it("reports the peak net worth over the charted period, not just the terminal", () => {
    // Accumulate to 300, then decumulate to 50 — the peak is the headline, the terminal isn't.
    const data = buildNetWorthBreakdown(
      series([{ accounts: { savings: 100 } }, { accounts: { savings: 300 } }, { accounts: { savings: 50 } }]),
      META,
    );
    expect(data.peakNetWorthCents).toBe(300);
    expect(data.terminalNetWorthCents).toBe(50);
  });

  it("ends the rows at the first insolvent month, like the total net-worth chart", () => {
    const data = buildNetWorthBreakdown(
      series([
        { accounts: { savings: 100 } },
        { accounts: { savings: 50 } },
        { accounts: { savings: 0 }, isInsolvent: true },
        { accounts: { savings: 0 }, isInsolvent: true },
      ]),
      META,
    );
    expect(data.rows.map((r) => r.month)).toEqual([0, 1]); // insolvent months 2,3 dropped
  });

  it("stops at the first draw on an unnamed liability (the synthetic last-resort card)", () => {
    // The synthetic card carries no label, so a month that draws on it ends the self-funded
    // period: rows stop before it and it never becomes a debt band or dents net worth.
    const data = buildNetWorthBreakdown(
      series([
        { accounts: { savings: 100 } },
        { accounts: { savings: 60 } },
        { accounts: { savings: 0 }, liabilities: { "synthetic-credit-card": 500 } },
        { accounts: { savings: 0 }, liabilities: { "synthetic-credit-card": 900 } },
      ]),
      META, // no liabilityLabels → the card id is unnamed
    );
    expect(data.rows.map((r) => r.month)).toEqual([0, 1]); // stops before the first card draw
    expect(data.hasLiabilities).toBe(false);
    expect(data.bands.every((b) => b.kind === "account")).toBe(true);
    expect(data.terminalNetWorthCents).toBe(60); // last self-funded month, no phantom debt
  });

  it("returns no bands and null terminal net worth for an empty series", () => {
    const data = buildNetWorthBreakdown(series([]), META);
    expect(data.bands).toEqual([]);
    expect(data.terminalNetWorthCents).toBeNull();
    expect(data.peakNetWorthCents).toBeNull();
  });
});
