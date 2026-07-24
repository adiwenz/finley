import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDollars } from "../../format";
import { describeIncomeGap, type IncomeChartData } from "./incomeByCategory";

/**
 * Monthly income chart — the income-side companion to the per-line budget chart
 * (issue #71). Income is not a budget line (§6/§17), so it gets its own graph stacked
 * directly above the budget, sharing the same x-axis, the same click-to-select gesture,
 * and the same selection marker: two views of one timeline.
 *
 * Reading the two together is the point. The budget keeps rising with prices while
 * income steps down at the last paycheck and only partly recovers when the government
 * benefit starts — the gap between those two shapes is the plan's whole problem.
 *
 * As with the budget chart, the summary and a hidden data mirror render independently
 * of Recharts so the behaviour is assertable without SVG layout (Recharts needs a real
 * width, absent in jsdom).
 */

// Cooler than the budget's earth tones, so the two charts read as different quantities.
const SOURCE_COLORS = ["#2f5d7c", "#4a8db5", "#7fb3ce", "#a8cbdd", "#3f7d5f"];
// The savings drawdown is not income — a muted, distinct tone sets it apart from the
// real source bands above it (issue #99).
const SAVINGS_DRAWDOWN_COLOR = "#b08968";
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e";

const colorFor = (category: string, index: number): string =>
  category === "savingsDrawdown"
    ? SAVINGS_DRAWDOWN_COLOR
    : SOURCE_COLORS[index % SOURCE_COLORS.length];

export interface IncomeChartProps {
  readonly data: IncomeChartData;
  /** The month the editor is pointed at — marked with a vertical rule. */
  readonly selectedMonth: number;
  /** Called with the clicked month, so the panel can move the editor there. */
  readonly onSelectMonth: (month: number) => void;
}

export function IncomeChart({ data, selectedMonth, onSelectMonth }: IncomeChartProps) {
  const summary = describeIncomeGap(data);
  const rows = data.rows.map((r) => ({ month: r.month, ...r.centsBySource }));
  const lastMonth = data.rows[data.rows.length - 1]?.month ?? 0;

  return (
    <div
      role="img"
      aria-label={
        summary
          ? `Monthly income by source. ${summary}`
          : "Monthly income by source — income continues across the whole horizon."
      }
    >
      {/* Informational, not a warning: a retirement income gap is expected, and the
          plan-is-broken case is the budget chart's amber band below. */}
      <p className="hint" data-testid="income-summary">
        {summary ?? "Income continues across the whole horizon."}
      </p>
      {/* Hidden data mirror for tests / screen readers: first row's income per source. */}
      <output data-testid="income-first-row" hidden>
        {JSON.stringify(data.rows[0]?.centsBySource ?? {})}
      </output>

      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart
          data={rows}
          margin={{ top: 12, right: 16, bottom: 8, left: 16 }}
          style={{ cursor: "pointer" }}
          onClick={(state: { activeLabel?: string | number } | null) => {
            const label = Number(state?.activeLabel);
            if (Number.isFinite(label)) onSelectMonth(label);
          }}
        >
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="month"
            type="number"
            domain={[0, lastMonth]}
            allowDataOverflow
            tickFormatter={(month: number) => `yr ${Math.floor(month / 12) + 1}`}
            tick={{ fill: AXIS, fontSize: 11 }}
            stroke={GRID}
          />
          <YAxis
            width={72}
            tickFormatter={formatDollars}
            tick={{ fill: AXIS, fontSize: 11 }}
            stroke={GRID}
          />
          <Tooltip
            formatter={(value, name) => [formatDollars(Number(value)), name]}
            labelFormatter={(label) => `Month ${label}`}
            contentStyle={{ fontSize: 12 }}
          />
          <ReferenceLine x={selectedMonth} stroke={MARKER} strokeWidth={2} />
          {data.sources.map((source, i) => (
            <Area
              key={source.id}
              type="monotone"
              dataKey={source.id}
              name={source.label}
              stackId="income"
              stroke={colorFor(source.category, i)}
              fill={colorFor(source.category, i)}
              fillOpacity={0.6}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
