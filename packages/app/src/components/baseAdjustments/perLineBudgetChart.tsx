import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDollars } from "../../format";
import { describeStarvation, type PerLineBudgetData } from "./perLineBudget";

/**
 * Per-line monthly budget chart (§Q27, "Base + Adjustments", issue #71, AC2). Draws
 * each standing budget line's *actually funded* amount per month as a stacked area, so
 * the total is the funded budget and each band is a line. In a shortfall month the
 * §15 waterfall starves the lowest-priority lines first, so their bands visibly pinch
 * to zero — and the starved span is shaded amber with a plain-language summary above
 * the chart (which doubles as the figure's accessible description).
 *
 * The chart is also the **month picker**: clicking a point selects that month, marked
 * with a vertical rule, and the editor below re-resolves every budget row to it. That
 * is the whole "adjustment" gesture — pick a point, change a number, say how long.
 * Selection is a controlled prop so the panel owns the month; the keyboard path to the
 * same state lives beside the editor heading (Recharts clicks are pointer-only).
 *
 * The summary and a hidden per-line data mirror are rendered independently of Recharts
 * so the behaviour is assertable without depending on SVG layout (Recharts needs a
 * real width, absent in jsdom).
 */

// Category-tiered palette (needs → wants → savings), on the ledger ink/amber system.
const TIER_COLORS = ["#1f3a2e", "#3f7d5f", "#b5761f", "#c99a3f", "#8a8570"];
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const STARVE = "#b5761f";
const MARKER = "#1f3a2e";

export interface PerLineBudgetChartProps {
  readonly data: PerLineBudgetData;
  /** The month the editor is pointed at — marked with a vertical rule. */
  readonly selectedMonth: number;
  /** Called with the clicked month, so the panel can move the editor there. */
  readonly onSelectMonth: (month: number) => void;
}

export function PerLineBudgetChart({
  data,
  selectedMonth,
  onSelectMonth,
}: PerLineBudgetChartProps) {
  const summary = describeStarvation(data);
  const rows = data.rows.map((r) => ({ month: r.month, ...r.fundedByLine }));

  // Contiguous starved spans → one shaded ReferenceArea each (visually marks where the
  // waterfall could not fund the whole budget).
  const starvedSpans: Array<{ from: number; to: number }> = [];
  for (const month of data.starvedMonths) {
    const last = starvedSpans[starvedSpans.length - 1];
    if (last && month === last.to + 1) last.to = month;
    else starvedSpans.push({ from: month, to: month });
  }

  return (
    <div
      role="img"
      aria-label={
        summary
          ? `Monthly budget by line. ${summary}`
          : "Monthly budget by line — every line fully funded throughout."
      }
    >
      <p className={summary ? "alert alert-amber" : "hint"} data-testid="perline-summary">
        {summary ?? "Every budget line is fully funded across the horizon."}
      </p>
      {/* Hidden data mirror for tests / screen readers: first row's funded per line. */}
      <output data-testid="perline-first-row" hidden>
        {JSON.stringify(data.rows[0]?.fundedByLine ?? {})}
      </output>

      <ResponsiveContainer width="100%" height={260}>
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
          {starvedSpans.map((span) => (
            <ReferenceArea
              key={`starve-${span.from}`}
              x1={span.from}
              x2={span.to}
              fill={STARVE}
              fillOpacity={0.12}
            />
          ))}
          <ReferenceLine x={selectedMonth} stroke={MARKER} strokeWidth={2} ifOverflow="extendDomain" />
          {data.lines.map((line, i) => (
            <Area
              key={line.id}
              type="monotone"
              dataKey={line.id}
              name={line.label}
              stackId="budget"
              stroke={TIER_COLORS[i % TIER_COLORS.length]}
              fill={TIER_COLORS[i % TIER_COLORS.length]}
              fillOpacity={0.6}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
