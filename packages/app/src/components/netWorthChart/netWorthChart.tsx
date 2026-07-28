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
  const data: Point[] = series.months.map((m) => ({
    month: m.month,
    nominalCents: m.netWorthNominalCents,
    realCents: m.netWorthRealCents,
  }));

  // Where the curve ends: the last month with a non-null value — the "money runs out" point
  // for a failed plan, the horizon for a surviving one.
  const horizonMonth = series.months[series.months.length - 1]?.month ?? 0;
  const insolvent = series.months.some((m) => m.isInsolvent);
  let lastMeaningfulMonth = horizonMonth;
  let terminalCents: number | null = null;
  for (let i = series.months.length - 1; i >= 0; i--) {
    const m = series.months[i];
    if (m.netWorthNominalCents !== null) {
      lastMeaningfulMonth = m.month;
      terminalCents = m.netWorthNominalCents;
      break;
    }
  }
  // Zoom the x-axis just past where the curve ends, so an early failure is legible instead
  // of a spike against decades of empty chart. The 2-year floor keeps a very early failure
  // roomy.
  const xMaxMonth = Math.min(
    horizonMonth,
    Math.max(24, Math.ceil((lastMeaningfulMonth + 6) / 12) * 12),
  );

  // Ticks pinned to whole-year boundaries (multiples of 12). Recharts' auto-placement
  // lands them on fractional-year months that round to the same label (two "yr 1"s).
  // Spacing shows every year when zoomed in, every 5th/10th across a full horizon.
  const spanYears = Math.max(1, xMaxMonth / 12);
  const stepYears = spanYears <= 6 ? 1 : spanYears <= 15 ? 2 : spanYears <= 35 ? 5 : 10;
  const yearTicks: number[] = [];
  for (let m = 0; m <= xMaxMonth; m += stepYears * 12) yearTicks.push(m);

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
            domain={[0, xMaxMonth]}
            allowDataOverflow
            ticks={yearTicks}
            tickFormatter={(month: number) => `yr ${yearOf(month)}`}
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
              x={retirementMonth}
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
            labelFormatter={(label) => `Month ${label} · ${monthLabel(Number(label))}`}
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
              x={lastMeaningfulMonth}
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
