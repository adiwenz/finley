import { useMemo, useState } from "react";
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
  type IncomeBasis,
  type IncomeChartData,
  type IncomeMode,
  type IncomeSourceBand,
} from "./incomeByCategory";

/**
 * Monthly cash-flows-vs.-spending chart above the budget chart, sharing its x-axis,
 * click-to-select gesture and marker. Stacks every cash source — wages, benefit, interest,
 * asset and savings draws — broader than "income". Simple (default) folds every draw into
 * one "Living off savings" band; Advanced splits each source out.
 *
 * Bands are take-home by default (after the source's own tax and pre-tax deferral); gross
 * would show money that never reaches the checking account, overstating headroom.
 *
 * The summary and data mirrors render outside Recharts (jsdom gives no real width).
 */

// Wages: one blue step per job, cooler than the budget chart's earth tones so the two charts
// read as different quantities.
const WAGE_COLORS = ["#2f5d7c", "#4a8db5", "#7fb3ce", "#a8cbdd"];
// The government benefit: one teal step per CLAIMANT, so "whose benefit starts when" is
// readable off the chart. Out of the blue family: the old steel blue (#6b93b8) sat ΔE 4.0 from
// the second job's wage band (dataviz palette checker), near-indistinguishable from a paycheck.
// These two steps separate at ΔE 17.9 normal / 17.8 CVD — past the ≥15 / ≥8 floors — while
// staying inside the chart's muted register.
const BENEFIT_COLORS = ["#2f6b66", "#5aa39a"];
// Living off savings is NOT income — a muted earth family, set apart from the cool income
// bands above it.
const DRAW_COLORS = ["#c6b784", "#b08968", "#9c8459", "#d8c79a"];
const SPENDING_NEED_COLOR = "#9c5b39"; // the dashed "is it enough" line
const BROKE_COLOR = "#b23a2e"; // the "plan runs out" marker
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e"; // the selected-month rule

/** Namespaced so the dataKey can't clash with a source id. */
const SPENDING_NEED_KEY = "__spendingNeed";

/**
 * The engine reports a signed per-source net cash flow
 * ({@link import("@finley/engine").ProjectionIncomeSource.netCashFlowCents}) — negative when a
 * source's tax + deferral exceed its cash inflow — but a negative segment renders below the
 * axis and distorts the stack. This is the ONLY place the clamp lives; the engine and the
 * chart's data model keep the honest signed figures. No-op on the gross basis.
 */
function clampBandsForStack(centsBySource: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, cents] of Object.entries(centsBySource)) out[id] = Math.max(0, cents);
  return out;
}

/**
 * Each family is walked in band order, which is stable across the Simple/Advanced toggle — so a
 * person's benefit keeps its colour when the view changes.
 */
function colorsForBands(sources: readonly IncomeSourceBand[]): Map<string, string> {
  const colors = new Map<string, string>();
  let wage = 0;
  let benefit = 0;
  let draw = 0;
  for (const s of sources) {
    if (s.category === "wages") colors.set(s.id, WAGE_COLORS[wage++ % WAGE_COLORS.length]!);
    else if (s.category === "governmentRetirementBenefit") {
      colors.set(s.id, BENEFIT_COLORS[benefit++ % BENEFIT_COLORS.length]!);
    } else colors.set(s.id, DRAW_COLORS[draw++ % DRAW_COLORS.length]!);
  }
  return colors;
}

/** The household's age at `month`, to the nearest quarter-year: "69¾". */
const QUARTERS = ["", "¼", "½", "¾"] as const;
function formatBrokeAge(currentAge: number, month: number): string {
  const wholeYears = Math.floor(month / 12);
  const quarter = Math.round((month - wholeYears * 12) / 3); // 0..4
  const age = currentAge + wholeYears + (quarter === 4 ? 1 : 0);
  return `${age}${quarter === 4 ? "" : QUARTERS[quarter]}`;
}

export interface IncomeChartProps {
  readonly data: IncomeChartData;
  /** The household's age at month 0, which turns the broke marker's month into an age. */
  readonly currentAge: number;
  /** The month the editor is pointed at, marked with a vertical rule. */
  readonly selectedMonth: number;
  /**
   * Names bands whose label is a kind of income rather than an earner — two people's benefits
   * are otherwise one legend entry repeated. Only consulted when both are on the chart.
   */
  readonly personNames: ReadonlyMap<string, string>;
  readonly onSelectMonth: (month: number) => void;
}

export function IncomeChart({
  data,
  currentAge,
  selectedMonth,
  personNames,
  onSelectMonth,
}: IncomeChartProps) {
  const [mode, setMode] = useState<IncomeMode>("simple");
  const [basis, setBasis] = useState<IncomeBasis>("takeHome");
  const summary = describeIncomeGap(data);
  // None of this depends on `selectedMonth`, so scrubbing the selection — a frequent re-render
  // — doesn't recompute the band collapse or remap every month row.
  const view = useMemo(
    () => incomeBandsForMode(data, mode, basis, personNames),
    [data, mode, basis, personNames],
  );
  const colors = useMemo(() => colorsForBands(view.sources), [view]);
  const rows = useMemo(
    () =>
      view.rows.map((r) => ({
        month: r.month,
        [SPENDING_NEED_KEY]: r.spendingNeedCents,
        ...clampBandsForStack(r.centsBySource),
      })),
    [view],
  );
  const lastMonth = view.rows[view.rows.length - 1]?.month ?? 0;
  const brokeMonth = data.firstInsolventMonth;

  return (
    <div
      role="img"
      aria-label={
        summary
          ? `Monthly cash flows vs. spending. ${summary}`
          : "Monthly cash flows vs. spending — cash flow continues across the whole horizon."
      }
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        {/* Informational, not a warning: a retirement income gap is expected. The
            plan-is-broken case is the broke marker plus the budget chart's amber band. */}
        <p className="hint" data-testid="income-summary">
          {summary ?? "Cash flow continues across the whole horizon."}
        </p>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
          {/* Gross reads raw earning power. */}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, whiteSpace: "nowrap" }}>
            <input
              type="checkbox"
              checked={basis === "gross"}
              onChange={(e) => setBasis(e.target.checked ? "gross" : "takeHome")}
            />
            Show gross cash flows
          </label>
          {/* Advanced splits every source into its own band. */}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, whiteSpace: "nowrap" }}>
            <input
              type="checkbox"
              checked={mode === "advanced"}
              onChange={(e) => setMode(e.target.checked ? "advanced" : "simple")}
            />
            Advanced view
          </label>
        </div>
      </div>

      {/* Hidden data mirrors for tests / screen readers. */}
      <output data-testid="income-first-row" hidden>
        {JSON.stringify(view.rows[0]?.centsBySource ?? {})}
      </output>
      <output data-testid="income-bands" hidden>
        {JSON.stringify(view.sources.map((s) => s.label))}
      </output>
      {/* The spending need is expenses plus scheduled liability payments — a loan on the
          timeline is part of what income has to cover. */}
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
              // Not a surface-coloured separator hairline: Recharts keys the legend swatch and
              // tooltip entry to `stroke`, so a surface stroke erases both. The full-opacity
              // stroke over the 0.6 fill gives each band its darker edge.
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
