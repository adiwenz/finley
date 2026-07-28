/**
 * @vitest-environment node
 *
 * Render coverage for the net-worth breakdown chart via the server renderer (this repo's
 * jsdom is unavailable). Recharts needs a real width, so the SVG does not lay out here;
 * these pin the wiring around it — heading, summary, hidden band mirror, and the view
 * toggle appearing only when there is more than one view to offer.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectionSeries } from "@finley/engine";
import { NetWorthBreakdownChart, tooltipTotals } from "./netWorthBreakdownChart";
import { buildNetWorthBreakdown, type BreakdownMeta, type BreakdownBand } from "./netWorthBreakdown";

interface MonthSpec {
  readonly accounts?: Readonly<Record<string, number>>;
  readonly properties?: Readonly<Record<string, number>>;
  readonly liabilities?: Readonly<Record<string, number>>;
}

function series(months: readonly MonthSpec[]): ProjectionSeries {
  return {
    months: months.map((m, month) => ({
      month,
      netWorthNominalCents: 0,
      netWorthRealCents: 0,
      accountBalancesCents: m.accounts ?? {},
      // Inert here: the breakdown charts balances, never the embedded gain.
      accountBasisCents: {},
      liabilityBalancesCents: m.liabilities ?? {},
      liabilityPaymentRecords: {},
      propertyValuesCents: m.properties ?? {},
      isInsolvent: false,
    })),
  };
}

const META: BreakdownMeta = {
  accounts: [
    { id: "savings", label: "Cash savings" },
    { id: "goal-emg", label: "Emergency fund" },
  ],
  liabilityLabels: { "mortgage-1": "Mortgage" },
};

describe("NetWorthBreakdownChart", () => {
  it("renders the heading, summary, and the stacked account bands", () => {
    const data = buildNetWorthBreakdown(
      series([{ accounts: { savings: 100000, "goal-emg": 50000 } }]),
      META,
    );
    const html = renderToStaticMarkup(<NetWorthBreakdownChart data={data} />);
    expect(html).toContain("Net worth breakdown");
    expect(html).toContain("net worth"); // summary line
    // Hidden band mirror carries the labels currently stacked.
    expect(html).toContain("Cash savings");
    expect(html).toContain("Emergency fund");
  });

  it("offers no view toggle when there is only the accounts view", () => {
    const data = buildNetWorthBreakdown(series([{ accounts: { savings: 100000 } }]), META);
    const html = renderToStaticMarkup(<NetWorthBreakdownChart data={data} />);
    // Accounts-only plan → single view → no segmented control.
    expect(html).not.toContain('aria-label="Breakdown view"');
  });

  it("offers the Accounts/Assets/Net worth toggle once there is property and debt", () => {
    const data = buildNetWorthBreakdown(
      series([
        {
          accounts: { savings: 100000 },
          properties: { "home-1": 400000 },
          liabilities: { "mortgage-1": 300000 },
        },
      ]),
      META,
    );
    const html = renderToStaticMarkup(<NetWorthBreakdownChart data={data} />);
    expect(html).toContain('aria-label="Breakdown view"');
    expect(html).toContain("Accounts");
    expect(html).toContain("Assets");
    expect(html).toContain("Net worth");
    // Defaults to Accounts: only account bands are stacked, and its button is pressed.
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Cash savings");
    expect(html).not.toContain("Mortgage"); // liability band hidden in the default Accounts view
  });
});

describe("tooltipTotals", () => {
  const bands: readonly BreakdownBand[] = [
    { id: "savings", label: "Cash savings", kind: "account" },
    { id: "home-1", label: "Home", kind: "property" },
    { id: "loan-student", label: "Student loan", kind: "liability" },
  ];

  it("splits assets from liabilities and nets them (liabilities arrive signed negative)", () => {
    const totals = tooltipTotals(
      [
        { dataKey: "savings", value: 100000 },
        { dataKey: "home-1", value: 40000 },
        { dataKey: "loan-student", value: -30000 }, // networth view negates the owed balance
      ],
      bands,
    );
    expect(totals.assetsCents).toBe(140000);
    expect(totals.liabilitiesCents).toBe(-30000);
    expect(totals.netWorthCents).toBe(110000);
    expect(totals.hasLiabilities).toBe(true);
  });

  it("reports no liabilities when only asset bands are in view", () => {
    const totals = tooltipTotals(
      [
        { dataKey: "savings", value: 100000 },
        { dataKey: "home-1", value: 40000 },
      ],
      bands,
    );
    expect(totals.assetsCents).toBe(140000);
    expect(totals.liabilitiesCents).toBe(0);
    expect(totals.netWorthCents).toBe(140000);
    expect(totals.hasLiabilities).toBe(false);
  });
});
