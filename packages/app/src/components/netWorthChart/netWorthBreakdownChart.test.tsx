/**
 * @vitest-environment node
 *
 * Render coverage for the net-worth breakdown chart via the server renderer (this repo's
 * jsdom is unavailable). Recharts needs a real width so the SVG itself does not lay out
 * here; these pin the wiring around it — the heading, the summary, the hidden band mirror,
 * and the view toggle appearing only when there is more than one view to offer.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectionSeries } from "@finley/engine";
import { NetWorthBreakdownChart } from "./netWorthBreakdownChart";
import { buildNetWorthBreakdown, type BreakdownMeta } from "./netWorthBreakdown";

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
    // Defaults to the Accounts view: only account bands are stacked, and its button is pressed.
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Cash savings");
    expect(html).not.toContain("Mortgage"); // liability band hidden in the default Accounts view
  });
});
