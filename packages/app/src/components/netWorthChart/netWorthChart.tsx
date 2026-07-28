import type { ProjectionSeries } from "@finley/engine";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDollars, monthLabel, yearOf } from "../../format";
import { TODAY_X, axisPointLabel, axisYearTickLabel, toAxisX, yearTickXs } from "../monthAxis";

const INK = "#1f3a2e"; // ledger ink green (nominal)
const AMBER = "#b5761f"; // real (today's dollars)
const AXIS = "#6b6552";
const GRID = "#e3dcc6";

type Point = {
  month: number;
  // Null from the first insolvent month on. Recharts breaks the line at the null, so the
  // curves END at insolvency rather than flatlining as if stable.
  nominalCents: number | null;
  realCents: number | null;
};

/** `retirementMonth`: the solved Mode-1 retirement age as a month offset. */
export function NetWorthChart({
  series,
  retirementMonth,
}: {
  series: ProjectionSeries;
  retirementMonth?: number | null;
}) {
  // The shared months-from-now axis: `opening` (today) at TODAY_X, each processed month at
  // `toAxisX(m.month)`. See {@link import("../monthAxis")} for why the shift exists and why
  // every projection chart draws on it.
  const data: Point[] = [
    {
      month: TODAY_X,
      nominalCents: series.opening.netWorthNominalCents,
      realCents: series.opening.netWorthRealCents,
    },
    ...series.months.map((m) => ({
      month: toAxisX(m.month),
      nominalCents: m.netWorthNominalCents,
      realCents: m.netWorthRealCents,
    })),
  ];

  // Where the curve ends: the last point with a non-null value — the "money runs out" point
  // for a failed plan, the horizon for a surviving one. These are AXIS positions, not model
  // months; only `data` is indexed from here on.
  const horizonX = data[data.length - 1]?.month ?? TODAY_X;
  const insolvent = series.months.some((m) => m.isInsolvent);
  let lastMeaningfulX = horizonX;
  let terminalCents: number | null = null;
  for (let i = data.length - 1; i >= 0; i--) {
    const p = data[i];
    if (p.nominalCents !== null) {
      lastMeaningfulX = p.month;
      terminalCents = p.nominalCents;
      break;
    }
  }
  // Zoom the x-axis just past where the curve ends, so an early failure is legible instead
  // of a spike against decades of empty chart. The 2-year floor keeps a very early failure
  // roomy.
  const xMax = Math.min(horizonX, Math.max(24, Math.ceil((lastMeaningfulX + 6) / 12) * 12));
  const yearTicks = yearTickXs(xMax);

  return (
    <div
      role="img"
      aria-label="Projected net worth over time (nominal and real)"
    >
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart
          data={data}
          margin={{ top: 16, right: 16, bottom: 8, left: 16 }}
        >
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="month"
            type="number"
            domain={[TODAY_X, xMax]}
            allowDataOverflow
            ticks={yearTicks}
            tickFormatter={(x: number) => axisYearTickLabel(x, yearOf)}
            tick={{ fill: AXIS, fontSize: 11 }}
            stroke={GRID}
          />
          <YAxis
            width={72}
            tickFormatter={formatDollars}
            tick={{ fill: AXIS, fontSize: 11 }}
            stroke={GRID}
          />
          <ReferenceLine y={0} stroke="#c9bfa5" />
          {retirementMonth != null && (
            <ReferenceLine
              x={toAxisX(retirementMonth)}
              stroke={AMBER}
              strokeDasharray="4 4"
              label={{ value: "Retire", position: "top", fill: AMBER, fontSize: 11 }}
            />
          )}
          <Tooltip
            formatter={(value, name) => [
              value == null ? "—" : formatDollars(Number(value)),
              name,
            ]}
            labelFormatter={(label) => axisPointLabel(Number(label), monthLabel)}
            contentStyle={{ fontSize: 12 }}
          />
          <Area
            type="monotone"
            dataKey="nominalCents"
            name="Nominal"
            stroke={INK}
            strokeWidth={2}
            fill={INK}
            fillOpacity={0.12}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="realCents"
            name="Real (today's dollars)"
            stroke={AMBER}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {insolvent && terminalCents !== null && (
            <ReferenceDot
              x={lastMeaningfulX}
              y={terminalCents}
              r={4}
              fill={INK}
              stroke="none"
              label={{ value: "runs out", position: "right", fill: AXIS, fontSize: 11 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
