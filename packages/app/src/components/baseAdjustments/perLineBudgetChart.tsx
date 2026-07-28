import { useMemo } from "react";
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
import { describeInsolvency, type ChartBand, type PerLineBudgetData } from "./perLineBudget";

/**
 * Monthly spending chart ("Base + Adjustments"). Each engine spending item is a stacked
 * area — spending **as authored**, with span, dated overrides, and price growth applied — so
 * every band is one thing the money goes to and the total is what the month costs. Bands are
 * coloured by kind ({@link BAND_PALETTE}): budget, other obligations carried, debt service.
 *
 * A tight month does NOT pinch the low-priority bands. The simulator never skips spending: an
 * uncovered obligation is charged against the liquid account and cascades onto credit, so a
 * short band would depict money the household did in fact spend. A shortfall instead produces
 * the terminal case — savings and credit both exhausted — which the amber {@link ReferenceArea}
 * shades from the first insolvent month, with a plain-language summary above the chart that
 * doubles as the figure's accessible description. Which spending to give up once a plan stops
 * working is the user's decision, not this chart's.
 *
 * Also the **month picker**: clicking a point selects that month, marked with a vertical rule,
 * and the editor below re-resolves every budget row to it — the whole "adjustment" gesture.
 * Selection is a controlled prop so the panel owns the month; the keyboard path lives beside
 * the editor heading, since Recharts clicks are pointer-only.
 *
 * Hovering reads out every band *and their total* ({@link BudgetTooltip}): the stack's height
 * is the question usually asked, and a default tooltip leaves the reader adding bands by eye.
 *
 * The summary and a hidden per-line data mirror render independently of Recharts so behaviour
 * is assertable without SVG layout (Recharts needs a real width, absent in jsdom).
 */

// Category-tiered palette (needs → wants → savings), on the ledger ink/amber system.
const TIER_COLORS = ["#1f3a2e", "#3f7d5f", "#b5761f", "#c99a3f", "#8a8570"];
// Spending the budget doesn't author (health, a child's cost, an expense event) — muted
// slate: carried, not chosen line by line.
const OTHER_COLORS = ["#5c6b73", "#7d8f96", "#95a3a8"];
// Debt service — rust, set apart from the budget's greens and ambers: money owed, not
// chosen. Matches the income graph's spending-need line.
const DEBT_COLORS = ["#9c5b39", "#b23a2e", "#7d4a30"];
const BAND_PALETTE: Record<ChartBand["kind"], readonly string[]> = {
  line: TIER_COLORS,
  other: OTHER_COLORS,
  debt: DEBT_COLORS,
};
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const INSOLVENT = "#b5761f";
const MARKER = "#1f3a2e";

/**
 * A band's colour from its kind's family ({@link BAND_PALETTE}). Each family is indexed
 * within itself, so a new debt never re-colours the budget beneath it.
 */
function colorOf(band: ChartBand, index: number, bands: readonly ChartBand[]): string {
  const nth = bands.slice(0, index).filter((b) => b.kind === band.kind).length;
  const palette = BAND_PALETTE[band.kind];
  return palette[nth % palette.length]!;
}

/** One series' entry in a Recharts tooltip payload — the slice of it this chart reads. */
export interface BudgetTooltipEntry {
  readonly name?: string | number;
  readonly value?: string | number;
  readonly color?: string;
}

export interface BudgetTooltipProps {
  readonly active?: boolean;
  readonly payload?: readonly BudgetTooltipEntry[];
  readonly label?: string | number;
}

/**
 * Hover readout for a stacked month: every line's amount, then their **total** — the number
 * the reader is after, which a default tooltip leaves them adding up by eye. Summing the
 * payload rather than re-deriving from the data keeps the total exactly the height drawn,
 * whatever bands the tooltip is showing.
 */
export function BudgetTooltip({ active, payload, label }: BudgetTooltipProps) {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  const total = payload.reduce((sum, entry) => sum + Number(entry.value ?? 0), 0);
  return (
    <div
      style={{
        background: "#fffdf7",
        border: `1px solid ${GRID}`,
        padding: "8px 10px",
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>Month {label}</p>
      {payload.map((entry, i) => (
        <p key={`${entry.name}-${i}`} style={{ margin: 0, color: entry.color }}>
          {entry.name} : {formatDollars(Number(entry.value ?? 0))}
        </p>
      ))}
      <p
        style={{
          margin: "4px 0 0",
          paddingTop: 4,
          borderTop: `1px solid ${GRID}`,
          fontWeight: 600,
          color: MARKER,
        }}
      >
        Total : {formatDollars(total)}
      </p>
    </div>
  );
}

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
  const summary = describeInsolvency(data);
  // Recharts wants one flat object per point, keyed per band: a full pass over the horizon
  // (660+ months) building an object each. Worth memoizing — the rows change only when the
  // projection does, not when the selection marker moves or an edit restages.
  const rows = useMemo(
    () => data.rows.map((r) => ({ month: r.month, ...r.centsByLine })),
    [data.rows],
  );
  // Pin the axis to the horizon (life expectancy): left to itself the domain stretches past
  // the last month to fit the selection rule and open-ended insolvency band, drawing empty
  // years the plan never reaches.
  const lastMonth = data.rows[data.rows.length - 1]?.month ?? 0;

  return (
    <div
      role="img"
      aria-label={
        summary
          ? `Monthly budget by line. ${summary}`
          : "Monthly budget by line — the plan finances this budget throughout."
      }
    >
      <p className={summary ? "alert alert-amber" : "hint"} data-testid="perline-summary">
        {summary ?? "This budget is financed across the whole horizon."}
      </p>
      {/* Hidden data mirror for tests / screen readers: first row's amount per line. */}
      <output data-testid="perline-first-row" hidden>
        {JSON.stringify(data.rows[0]?.centsByLine ?? {})}
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
          <Tooltip content={<BudgetTooltip />} />
          {data.insolventFromMonth !== null && (
            <ReferenceArea
              x1={data.insolventFromMonth}
              x2={lastMonth}
              fill={INSOLVENT}
              fillOpacity={0.12}
              label={{
                value: "unfunded — savings & credit exhausted",
                position: "insideTop",
                fill: INSOLVENT,
                fontSize: 11,
              }}
            />
          )}
          <ReferenceLine x={selectedMonth} stroke={MARKER} strokeWidth={2} />
          {data.lines.map((band, i) => {
            const color = colorOf(band, i, data.lines);
            return (
              <Area
                key={band.id}
                type="monotone"
                dataKey={band.id}
                name={band.label}
                stackId="budget"
                stroke={color}
                fill={color}
                fillOpacity={0.6}
                isAnimationActive={false}
              />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
