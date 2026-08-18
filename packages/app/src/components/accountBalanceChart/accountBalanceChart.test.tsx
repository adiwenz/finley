/**
 * @vitest-environment node
 *
 * Render coverage via the server renderer (Recharts needs a real width, absent in jsdom) —
 * see the equivalent note on `netWorthBreakdownChart.test.tsx`. Pins the wiring: label,
 * summary, the hidden "today" point mirror, and the owner label being caller-controlled.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountBalanceChart } from "./accountBalanceChart";
import { buildAccountBalanceData } from "./accountBalanceSeries";
import type { ProjectionSeries } from "@finley/engine";

function series(): ProjectionSeries {
  const month = (m: number, savings: number) => ({
    month: m,
    netWorthNominalCents: 0,
    netWorthRealCents: 0,
    accountBalancesCents: { savings },
    accountBasisCents: {},
    liabilityBalancesCents: {},
    liabilityPaymentRecords: {},
    propertyValuesCents: {},
    isInsolvent: false,
    uncoveredCents: 0,
  });
  return {
    opening: month(0, 100000),
    months: [month(0, 101000), month(1, 102000)],
    status: "ran-to-horizon",
    simulatedThroughMonth: 1,
    obligationOutcomes: {},
  };
}

describe("AccountBalanceChart", () => {
  it("renders the account label and its projected-balance summary", () => {
    const data = buildAccountBalanceData(series(), "savings");
    const html = renderToStaticMarkup(<AccountBalanceChart label="Cash savings" data={data} />);
    expect(html).toContain('aria-label="Cash savings projected balance over time. $1,020 projected"');
  });

  it("mirrors today's opening balance as the first charted point", () => {
    const data = buildAccountBalanceData(series(), "savings");
    const html = renderToStaticMarkup(<AccountBalanceChart label="Cash savings" data={data} />);
    expect(html).toContain("&quot;x&quot;:0,&quot;balanceCents&quot;:100000");
  });

  it("reports no balance to project for an account with no charted points", () => {
    const html = renderToStaticMarkup(
      <AccountBalanceChart label="Empty" data={{ points: [], xMax: 0, stopped: null }} />,
    );
    expect(html).toContain("No balance to project yet.");
  });
});
