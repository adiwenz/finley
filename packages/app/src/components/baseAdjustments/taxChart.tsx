import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDollars, monthLabel } from "../../format";
import { TODAY_X, axisPointLabel, fromAxisX, toAxisX } from "../monthAxis";
import { describeTaxes, type TaxSourceBand, type TaxChartData } from "./taxesByMonth";

/**
 * Monthly tax-paid chart — below the income and budget charts, sharing their x-axis,
 * click-to-select gesture, and selection marker.
 *
 * STACKS BY INCOME SOURCE, like the income chart: the engine splits tax down to the job or
 * account draw that bore it, coloured by that source's provenance category — a "money
 * leaving" rust family, distinct from income blues and budget greens. Attribution is
 * required of every jurisdiction and enforced to reconcile; a zero-tax plan draws flat zero.
 *
 * The summary and data mirror render outside Recharts (jsdom gives no real width).
 */

// Single-band fallback colour, plus a rust "money leaving" family set apart from the
// income bands. As on the income chart, siblings in the SAME category step through their
// family's shades so two jobs read as distinct bands, not one block.
const TAX_COLOR = "#8c3b3b";
// Wages: one step per job, dark → light. Benefit: a single steady warm tone. Draws
// (capital-gains / ordinary / tax-exempt / any drawdown): a second, earthier family.
const WAGE_TONES = ["#8c3b3b", "#a85a4a", "#c17a5f", "#d5a084"];
const BENEFIT_TONE = "#9c6b4a";
const DRAW_TONES = ["#7a4a3a", "#b8794f", "#9c8459", "#c6a878"];
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e";

/**
 * A colour per tax band, stepping shades within a category so sibling jobs and draws stay
 * distinct — the analog of the income chart's `colorsForBands`. Wages walk the rust
 * family, the benefit is one tone, everything else walks the earth family. Input order is
 * stacking order, so shades progress cleanly up the stack.
 */
function colorsForBands(sources: readonly TaxSourceBand[]): Map<string, string> {
  const colors = new Map<string, string>();
  let wage = 0;
  let draw = 0;
  for (const s of sources) {
    if (s.category === "wages") colors.set(s.id, WAGE_TONES[wage++ % WAGE_TONES.length]!);
    else if (s.category === "governmentRetirementBenefit") colors.set(s.id, BENEFIT_TONE);
    else colors.set(s.id, DRAW_TONES[draw++ % DRAW_TONES.length]!);
  }
  return colors;
}

export interface TaxChartProps {
  readonly data: TaxChartData;
  /** The month the editor is pointed at — marked with a vertical rule. */
  readonly selectedMonth: number;
  /** Called with the clicked month, so the panel can move the editor there. */
  readonly onSelectMonth: (month: number) => void;
}

export function TaxChart({ data, selectedMonth, onSelectMonth }: TaxChartProps) {
  const summary = describeTaxes(data);
  // Stacked whenever the plan pays tax (attribution is always reported); a zero-tax plan
  // has no sources, so the row carries the lone `taxCents`.
  const stacked = data.hasSourceBreakdown && data.sources.length > 0;
  // Geometry depends only on `data`, stable while scrubbing — memoized so moving
  // `selectedMonth` doesn't rebuild the colour map or remap every row.
  const colors = useMemo(() => colorsForBands(data.sources), [data.sources]);
  // On the shared months-from-now axis; a flow chart, so the today slot stays empty (no tax is
  // paid at "now") and the bands start at end-of-month-0, aligned with the charts above.
  const rows = useMemo(
    () =>
      data.rows.map((r) => {
        const x = toAxisX(r.month);
        return stacked ? { month: x, ...r.centsBySource } : { month: x, taxCents: r.taxCents };
      }),
    [data.rows, stacked],
  );
  const lastX = toAxisX(data.rows[data.rows.length - 1]?.month ?? 0);

  return (
    <div
      role="img"
      aria-label={
        summary
          ? `Monthly tax paid. ${summary}`
          : "Monthly tax paid — this plan pays no income tax over the horizon."
      }
    >
      <p className="hint" data-testid="tax-summary">
        {summary ?? "No income tax is paid over the horizon."}
      </p>
      {/* Hidden data mirror for tests / screen readers: the first row's tax (total plus
          any per-source split) and the stacked band labels. */}
      <output data-testid="tax-first-row" hidden>
        {JSON.stringify(data.rows[0] ?? {})}
      </output>
      <output data-testid="tax-bands" hidden>
        {JSON.stringify(data.sources.map((s) => s.label))}
      </output>

      <ResponsiveContainer width="100%" height={180}>
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
          <Tooltip
            formatter={(value, name) => [formatDollars(Number(value)), name]}
            labelFormatter={(label) => axisPointLabel(Number(label), monthLabel)}
            contentStyle={{ fontSize: 12 }}
          />
          {stacked && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <ReferenceLine x={toAxisX(selectedMonth)} stroke={MARKER} strokeWidth={2} />
          {stacked ? (
            data.sources.map((band) => (
              <Area
                key={band.id}
                type="monotone"
                dataKey={band.id}
                name={band.label}
                stackId="tax"
                stroke={colors.get(band.id)}
                fill={colors.get(band.id)}
                fillOpacity={0.6}
                isAnimationActive={false}
              />
            ))
          ) : (
            <Area
              type="monotone"
              dataKey="taxCents"
              name="Tax"
              stroke={TAX_COLOR}
              fill={TAX_COLOR}
              fillOpacity={0.6}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
