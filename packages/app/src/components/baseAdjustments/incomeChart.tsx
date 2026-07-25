import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDollars } from "../../format";
import {
  describeIncomeGap,
  incomeBandsForMode,
  type IncomeChartData,
  type IncomeMode,
  type IncomeSourceBand,
} from "./incomeByCategory";

/**
 * Monthly income chart — the income-side companion to the per-line budget chart
 * (issue #71). Income is not a budget line (§6/§17), so it gets its own graph stacked
 * directly above the budget, sharing the same x-axis, the same click-to-select gesture,
 * and the same selection marker: two views of one timeline.
 *
 * Two views of the income itself (issue #99 follow-up), switched by the Advanced toggle:
 *   - **Simple** (default) — three ideas: wages (per job), Social Security, and one
 *     "Living off savings" band that folds in every asset-sale draw and the cash
 *     drawdown. A dashed spending-need line says whether it's enough, and a "broke"
 *     marker names the month the plan runs out.
 *   - **Advanced** — every source as its own band (which job, which account draining,
 *     the benefit, the cash drawdown), for the reader who wants the full breakdown.
 *     The gain-vs-principal split of the drawdown lands later via issue #122.
 *
 * As with the budget chart, the summary and hidden data mirrors render independently of
 * Recharts so the behaviour is assertable without SVG layout (Recharts needs a real
 * width, absent in jsdom).
 */

// Wages: a cool blue family, one step per job. Cooler than the budget's earth tones, so
// the two charts read as different quantities.
const WAGE_COLORS = ["#2f5d7c", "#4a8db5", "#7fb3ce", "#a8cbdd"];
// The government benefit — a single steady steel blue, distinct from the wage steps.
const SOCIAL_SECURITY_COLOR = "#6b93b8";
// Living off savings is NOT income — a muted earth family (tan first), one step per draw,
// set apart from the cool income bands above it (issue #99).
const DRAW_COLORS = ["#c6b784", "#b08968", "#9c8459", "#d8c79a"];
const SPENDING_NEED_COLOR = "#9c5b39"; // the dashed "is it enough" line
const BROKE_COLOR = "#b23a2e"; // the "plan runs out" marker
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e"; // the selected-month rule

/** The recharts dataKey of the spending-need line — namespaced so it can't clash with a source id. */
const SPENDING_NEED_KEY = "__spendingNeed";

/** A colour per band id: wages step through the blue family, draws through the earth family. */
function colorsForBands(sources: readonly IncomeSourceBand[]): Map<string, string> {
  const colors = new Map<string, string>();
  let wage = 0;
  let draw = 0;
  for (const s of sources) {
    if (s.category === "wages") colors.set(s.id, WAGE_COLORS[wage++ % WAGE_COLORS.length]!);
    else if (s.category === "governmentRetirementBenefit") colors.set(s.id, SOCIAL_SECURITY_COLOR);
    else colors.set(s.id, DRAW_COLORS[draw++ % DRAW_COLORS.length]!);
  }
  return colors;
}

/** "69¾" — the household's age at `month`, to the nearest quarter-year, for the broke marker. */
const QUARTERS = ["", "¼", "½", "¾"] as const;
function formatBrokeAge(currentAge: number, month: number): string {
  const wholeYears = Math.floor(month / 12);
  const quarter = Math.round((month - wholeYears * 12) / 3); // 0..4
  const age = currentAge + wholeYears + (quarter === 4 ? 1 : 0);
  return `${age}${quarter === 4 ? "" : QUARTERS[quarter]}`;
}

export interface IncomeChartProps {
  readonly data: IncomeChartData;
  /** The household's age at month 0 — turns the broke marker's month into an age. */
  readonly currentAge: number;
  /** The month the editor is pointed at — marked with a vertical rule. */
  readonly selectedMonth: number;
  /** Called with the clicked month, so the panel can move the editor there. */
  readonly onSelectMonth: (month: number) => void;
}

export function IncomeChart({ data, currentAge, selectedMonth, onSelectMonth }: IncomeChartProps) {
  const [mode, setMode] = useState<IncomeMode>("simple");
  const summary = describeIncomeGap(data);
  const view = incomeBandsForMode(data, mode);
  const colors = colorsForBands(view.sources);
  const rows = view.rows.map((r) => ({
    month: r.month,
    [SPENDING_NEED_KEY]: r.spendingNeedCents,
    ...r.centsBySource,
  }));
  const lastMonth = view.rows[view.rows.length - 1]?.month ?? 0;
  const brokeMonth = data.firstInsolventMonth;

  return (
    <div
      role="img"
      aria-label={
        summary
          ? `Monthly income by source. ${summary}`
          : "Monthly income by source — income continues across the whole horizon."
      }
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        {/* Informational, not a warning: a retirement income gap is expected, and the
            plan-is-broken case is the broke marker + the budget chart's amber band below. */}
        <p className="hint" data-testid="income-summary">
          {summary ?? "Income continues across the whole horizon."}
        </p>
        {/* Simple is the default; Advanced reveals every source separately (issue #99). */}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, whiteSpace: "nowrap" }}>
          <input
            type="checkbox"
            checked={mode === "advanced"}
            onChange={(e) => setMode(e.target.checked ? "advanced" : "simple")}
          />
          Advanced view
        </label>
      </div>

      {/* Hidden data mirrors for tests / screen readers: the active view's first-row
          income per band, and the band labels currently shown. */}
      <output data-testid="income-first-row" hidden>
        {JSON.stringify(view.rows[0]?.centsBySource ?? {})}
      </output>
      <output data-testid="income-bands" hidden>
        {JSON.stringify(view.sources.map((s) => s.label))}
      </output>
      {/* What that income has to cover in the first flowed month — expenses plus
          scheduled liability payments (the loan on the timeline is part of the need). */}
      <output data-testid="income-first-spending-need" hidden>
        {view.rows[0]?.spendingNeedCents ?? 0}
      </output>

      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart
          data={rows}
          margin={{ top: 16, right: 16, bottom: 8, left: 16 }}
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
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine x={selectedMonth} stroke={MARKER} strokeWidth={2} />
          {brokeMonth !== null && (
            <ReferenceLine
              x={brokeMonth}
              stroke={BROKE_COLOR}
              strokeWidth={1.5}
              strokeDasharray="2 4"
              label={{
                value: `broke · ${formatBrokeAge(currentAge, brokeMonth)}`,
                position: "top",
                fill: BROKE_COLOR,
                fontSize: 11,
              }}
            />
          )}
          {view.sources.map((source) => (
            <Area
              key={source.id}
              type="monotone"
              dataKey={source.id}
              name={source.label}
              stackId="income"
              stroke={colors.get(source.id)}
              fill={colors.get(source.id)}
              fillOpacity={0.6}
              isAnimationActive={false}
            />
          ))}
          <Line
            type="monotone"
            dataKey={SPENDING_NEED_KEY}
            name="Spending need"
            stroke={SPENDING_NEED_COLOR}
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
