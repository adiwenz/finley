import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNetWorthChartData } from "./netWorthChartData";
import { toAxisX } from "../monthAxis";

function series() {
  return {
    status: "ran-to-horizon",
    opening: { netWorthNominalCents: 10_000_000, netWorthRealCents: 10_000_000 },
    months: [
      { month: 0, netWorthNominalCents: 9_500_000, netWorthRealCents: 9_500_000 },
      { month: 1, netWorthNominalCents: 9_000_000, netWorthRealCents: 9_000_000 },
      {
        month: 2,
        netWorthNominalCents: null,
        netWorthRealCents: null,
        insolvencyReport: {
          uncoveredCents: 600_000,
          debtFundedNetWorthNominalCents: 8_200_000,
        },
      },
      { month: 3, netWorthNominalCents: null, netWorthRealCents: null },
    ],
  } as any;
}

describe("buildNetWorthChartData — insolvency presentation", () => {
  it("ends the solid curve at the last month whose net worth the engine reports", () => {
    const data = buildNetWorthChartData(series());
    expect(data.lastFundedX).toBe(toAxisX(1));
    expect(data.lastFundedNominalCents).toBe(9_000_000);
    for (const point of data.points) {
      if (point.x > data.lastFundedX) expect(point.nominalCents).toBeNull();
    }
  });

  it("passes the first insolvency report through as the runs-out marker", () => {
    expect(buildNetWorthChartData(series()).runsOut).toEqual({
      x: toAxisX(2),
      debtFundedNetWorthCents: 8_200_000,
      uncoveredCents: 600_000,
    });
  });

  it("draws exactly one dashed segment from the last funded point to the report endpoint", () => {
    const data = buildNetWorthChartData(series());
    const dashed = data.points.filter((point) => point.debtFundedNetWorthCents !== null);
    expect(dashed).toHaveLength(2);
    expect(dashed.map((point) => point.x)).toEqual([toAxisX(1), toAxisX(2)]);
    expect(dashed[0].debtFundedNetWorthCents).toBe(9_000_000);
    expect(dashed[1].debtFundedNetWorthCents).toBe(8_200_000);
  });

  it("draws no insolvency marker or dashed segment when the engine provides no report", () => {
    const healthy = series();
    healthy.months = healthy.months.slice(0, 2);
    const data = buildNetWorthChartData(healthy);
    expect(data.runsOut).toBeNull();
    expect(data.points.every((point) => point.debtFundedNetWorthCents === null)).toBe(true);
  });

  it("contains no financial cents arithmetic — the app only places engine-provided figures", () => {
    const source = readFileSync(new URL("./netWorthChartData.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const moneyOperand = String.raw`[\w.?]*[Cc]ents\b`;
    expect(code).not.toMatch(new RegExp(`${moneyOperand}\\s*[-+*/]`));
    expect(code).not.toMatch(new RegExp(`[-+*/]\\s*${moneyOperand}`));
  });
});
