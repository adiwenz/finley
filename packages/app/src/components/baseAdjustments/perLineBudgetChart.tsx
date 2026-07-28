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
import { formatDollars, monthLabel } from "../../format";
import { TODAY_X, axisPointLabel, fromAxisX, toAxisX } from "../monthAxis";
import { describeInsolvency, type ChartBand, type PerLineBudgetData } from "./perLineBudget";

/**
 * Monthly spending chart: each engine spending item a stacked area, coloured by kind
 * ({@link BAND_PALETTE}).
 *
 * Bands are never pinched short in a tight month — the simulator never skips spending, so a
 * short band would misreport money actually spent. A shortfall shows as the terminal case,
 * savings and credit exhausted: shaded amber from the first insolvent month, with a summary
 * that doubles as the figure's accessible description.
 *
 * Month selection is a controlled prop, so the panel owns the month, and the
 * keyboard path lives beside the editor heading since Recharts clicks are pointer-only. The
 * summary and the hidden data mirror render outside Recharts, which needs a real width, absent
 * in jsdom.
 */

// Category-tiered palette (needs → wants → savings), on the ledger ink/amber system.
const TIER_COLORS = ["#1f3a2e", "#3f7d5f", "#b5761f", "#c99a3f", "#8a8570"];
// Spending the budget doesn't author (health, a child's cost, an expense event) — muted slate.
const OTHER_COLORS = ["#5c6b73", "#7d8f96", "#95a3a8"];
// Debt service — rust, set apart from the budget's greens and ambers, and matching the income
// graph's spending-need line.
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

/** Each family is indexed within itself, so a new debt never re-colours the budget beneath it. */
function colorOf(band: ChartBand, index: number, bands: readonly ChartBand[]): string {
  const nth = bands.slice(0, index).filter((b) => b.kind === band.kind).length;
  const palette = BAND_PALETTE[band.kind];
  return palette[nth % palette.length]!;
}

/** The slice of a Recharts tooltip payload entry this chart reads. */
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
 * Hover readout for a stacked month: every line's amount, then their total — the number a
 * default tooltip leaves the reader adding up by eye. Summing the payload rather than
 * re-deriving from the data keeps the total exactly the height drawn, whatever bands the
 * tooltip is showing.
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
      <p style={{ margin: 0, fontWeight: 600 }}>{axisPointLabel(Number(label) || 0, monthLabel)}</p>
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
  /** Called with the clicked month, so the panel can move the editor. */
  readonly onSelectMonth: (month: number) => void;
}

export function PerLineBudgetChart({
  data,
  selectedMonth,
  onSelectMonth,
}: PerLineBudgetChartProps) {
  const summary = describeInsolvency(data);
  // Recharts wants one flat object per point, keyed per band: a full pass over the horizon
  // (660+ months). Memoized because rows change only when the projection does, not when the
  // selection marker moves or an edit restages.
  // On the shared months-from-now axis; a flow chart, so the today slot stays empty (nothing
  // is spent at "now") and the bands start at end-of-month-0, aligned with the charts above.
  const rows = useMemo(
    () => data.rows.map((r) => ({ month: toAxisX(r.month), ...r.centsByLine })),
    [data.rows],
  );
  // Pin the axis to the horizon: left to itself the domain stretches past the last month to
  // fit the selection rule and open-ended insolvency band, drawing years the plan never reaches.
  const lastX = toAxisX(data.rows[data.rows.length - 1]?.month ?? 0);

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
      {/* Data mirror for tests / screen readers: first row's amount per line. */}
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
            if (Number.isFinite(label)) onSelectMonth(fromAxisX(label));
          }}
        >
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="month"
            type="number"
            domain={[TODAY_X, lastX]}
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
              x1={toAxisX(data.insolventFromMonth)}
              x2={lastX}
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
          <ReferenceLine x={toAxisX(selectedMonth)} stroke={MARKER} strokeWidth={2} />
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
