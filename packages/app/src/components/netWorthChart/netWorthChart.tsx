import type { ProjectionSeries } from "@finley/engine";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDollars } from "../../format";

/**
 * Net-worth chart (issue #1 acceptance: render the engine's projection series).
 * Plots the nominal and real net-worth curves from the {@link ProjectionSeries}
 * contract with Recharts. Real charting/design polish is still Slice 11; this
 * proves the engine → app wire on the app's charting stack.
 */
const INK = "#1f3a2e"; // ledger ink green (nominal)
const AMBER = "#b5761f"; // real (today's dollars)
const AXIS = "#6b6552";
const GRID = "#e3dcc6";

type Point = {
  month: number;
  nominalCents: number;
  realCents: number;
};

export function NetWorthChart({ series }: { series: ProjectionSeries }) {
  const data: Point[] = series.months.map((m) => ({
    month: m.month,
    nominalCents: m.netWorthNominalCents,
    realCents: m.netWorthRealCents,
  }));

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
            domain={[0, "dataMax"]}
            tickFormatter={(month: number) => `yr ${Math.round(month / 12)}`}
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
          <Tooltip
            formatter={(value, name) => [
              formatDollars(Number(value)),
              name,
            ]}
            labelFormatter={(label) =>
              `Month ${label} (year ${Math.round(Number(label) / 12)})`
            }
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
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
