import { describe, it, expect } from "vitest";
import { SYNTHETIC_CARD_ID, type ProjectionSeries } from "@finley/engine";
import { buildNetWorthBreakdown, type BreakdownMeta } from "./netWorthBreakdown";

/**
 * A hand-built projection: one month per spec, only the balance maps moving, so these pin
 * the breakdown logic alone (band selection, ordering, sign, insolvency truncation) with
 * no simulator in the loop.
 */
interface MonthSpec {
  readonly accounts?: Readonly<Record<string, number>>;
  readonly properties?: Readonly<Record<string, number>>;
  readonly liabilities?: Readonly<Record<string, number>>;
  readonly isInsolvent?: boolean;
}

function mkMonth(m: MonthSpec, month: number) {
  return {
    month,
    netWorthNominalCents: 0,
    netWorthRealCents: 0,
    accountBalancesCents: m.accounts ?? {},
    // Inert here: the breakdown charts balances, never the embedded gain.
    accountBasisCents: {},
    liabilityBalancesCents: m.liabilities ?? {},
    liabilityPaymentRecords: {},
    propertyValuesCents: m.properties ?? {},
    isInsolvent: m.isInsolvent ?? false,
    uncoveredCents: m.isInsolvent ? 1 : 0,
  };
}

function series(months: readonly MonthSpec[]): ProjectionSeries {
  const built = months.map(mkMonth);
  return {
    opening: mkMonth({}, 0),
    months: built,
    status: "ran-to-horizon",
    simulatedThroughMonth: built.length - 1,
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
    // Accumulate to 300, then decumulate to 50 — the peak is the headline, not the terminal.
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

  it("charts the synthetic last-resort card as a labelled debt, not a truncation point", () => {
    // The synthetic card is the engine's borrow-of-last-resort; labelled, it charts below
    // zero like any liability, so a plan living on borrowed money shows the debt piling up.
    const meta: BreakdownMeta = { ...META, liabilityLabels: { [SYNTHETIC_CARD_ID]: "Credit card" } };
    const data = buildNetWorthBreakdown(
      series([
        { accounts: { savings: 100 } },
        { accounts: { savings: 0 } },
        { accounts: { savings: 0 }, liabilities: { [SYNTHETIC_CARD_ID]: 500 } },
        { accounts: { savings: 0 }, liabilities: { [SYNTHETIC_CARD_ID]: 900 } },
      ]),
      meta,
    );
    expect(data.rows).toHaveLength(4); // charts through the borrowing, not truncated
    expect(data.hasLiabilities).toBe(true);
    const liabilityBand = data.bands.find((b) => b.kind === "liability");
    expect(liabilityBand).toEqual({ id: SYNTHETIC_CARD_ID, label: "Credit card", kind: "liability" });
    expect(data.terminalNetWorthCents).toBe(-900); // debt owed at the last charted month
  });

  it("renders an UNLABELLED real liability normally (a missing label never truncates)", () => {
    // A real debt with no entry in liabilityLabels still charts across all its months,
    // banded with a humanized fallback name.
    const data = buildNetWorthBreakdown(
      series([
        { accounts: { savings: 100 }, liabilities: { "mortgage-1": 800 } },
        { accounts: { savings: 200 }, liabilities: { "mortgage-1": 700 } },
        { accounts: { savings: 300 }, liabilities: { "mortgage-1": 600 } },
      ]),
      META, // deliberately no liabilityLabels for "mortgage-1"
    );
    expect(data.rows).toHaveLength(3); // not truncated
    expect(data.hasLiabilities).toBe(true);
    const liabilityBand = data.bands.find((b) => b.kind === "liability");
    expect(liabilityBand).toEqual({ id: "mortgage-1", label: "Mortgage", kind: "liability" });
    // Terminal net worth nets the real debt: 300 − 600 = −300.
    expect(data.terminalNetWorthCents).toBe(-300);
  });

  it("charts a real debt and the synthetic card together, truncating only at insolvency", () => {
    // Both chart below zero; the run ends at the first insolvent month, not where the
    // synthetic borrowing began.
    const meta: BreakdownMeta = {
      ...META,
      liabilityLabels: { "mortgage-1": "Mortgage", [SYNTHETIC_CARD_ID]: "Credit card" },
    };
    const data = buildNetWorthBreakdown(
      series([
        { accounts: { savings: 100 }, liabilities: { "mortgage-1": 500 } },
        { accounts: { savings: 0 }, liabilities: { "mortgage-1": 480, [SYNTHETIC_CARD_ID]: 200 } },
        { accounts: { savings: 0 }, liabilities: { "mortgage-1": 460, [SYNTHETIC_CARD_ID]: 900 } },
        { accounts: { savings: 0 }, isInsolvent: true },
      ]),
      meta,
    );
    expect(data.rows).toHaveLength(3); // stops at the insolvent month (3), not the synthetic draw (1)
    expect(data.bands.filter((b) => b.kind === "liability").map((b) => b.label)).toEqual([
      "Mortgage",
      "Credit card",
    ]);
  });

  it("carries the opening balances as their own row, separate from month 0", () => {
    // The chart's "today" column: what the household holds right now, before any flow. It is
    // NOT months[0] — that one has a month of compounding and spending already in it.
    const data = buildNetWorthBreakdown(
      {
        opening: mkMonth({ accounts: { savings: 1000 } }, 0),
        months: [mkMonth({ accounts: { savings: 1050 } }, 0)],
        status: "ran-to-horizon",
        simulatedThroughMonth: 0,
      },
      META,
    );
    expect(data.opening.centsById.savings).toBe(1000);
    expect(data.rows[0]?.centsById.savings).toBe(1050);
  });

  it("keeps a band that exists today but is gone by month 0", () => {
    // A Year-0 purchase can drain an account outright. Discovering bands from the processed
    // months alone would drop it as always-zero, leaving a hole in the today column.
    const data = buildNetWorthBreakdown(
      {
        opening: mkMonth({ accounts: { savings: 5000, brokerage: 0 } }, 0),
        months: [mkMonth({ accounts: { savings: 0, brokerage: 0 } }, 0)],
        status: "ran-to-horizon",
        simulatedThroughMonth: 0,
      },
      META,
    );
    expect(data.bands.map((b) => b.label)).toEqual(["Cash savings"]);
  });

  it("counts today when picking the peak, so a plan that only ever falls peaks now", () => {
    const data = buildNetWorthBreakdown(
      {
        opening: mkMonth({ accounts: { savings: 9000 } }, 0),
        months: [mkMonth({ accounts: { savings: 8000 } }, 0), mkMonth({ accounts: { savings: 7000 } }, 1)],
        status: "ran-to-horizon",
        simulatedThroughMonth: 1,
      },
      META,
    );
    expect(data.peakNetWorthCents).toBe(9000);
  });

  it("returns no bands and null terminal net worth for an empty series", () => {
    const data = buildNetWorthBreakdown(series([]), META);
    expect(data.bands).toEqual([]);
    expect(data.terminalNetWorthCents).toBeNull();
    expect(data.peakNetWorthCents).toBeNull();
  });
});
