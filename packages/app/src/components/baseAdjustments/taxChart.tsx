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
import { formatDollars } from "../../format";
import { describeTaxes, type TaxSourceBand, type TaxChartData } from "./taxesByMonth";

/**
 * Monthly tax-paid chart — stacked below the income and per-line budget charts,
 * sharing the same x-axis, the same click-to-select gesture, and the same
 * selection marker. Read together with the two above it, it shows the wedge between gross
 * income and gross spending that the tax seam takes out each month.
 *
 * It STACKS BY INCOME SOURCE, matching the income chart: the engine
 * splits the tax down to the job / account draw that bore it, so each band names its source
 * and is coloured by that source's provenance category — a "money leaving" rust family,
 * distinct from the income blues and the budget greens, with one tone per category so a
 * household's jobs read as sibling shades. Attribution is required of every jurisdiction and
 * enforced to reconcile, so a plan that pays tax always stacks per source; a zero-tax plan
 * has no bands (a flat-zero line). As with the
 * sibling charts, the summary and a hidden data mirror render independently of Recharts so
 * the behaviour is assertable without SVG layout (Recharts needs a real width, absent in
 * jsdom).
 */

// The single-band fallback colour, plus a rust "money leaving" family set apart from the
// income bands. Like the income chart, sibling sources in the SAME category STEP through
// their family's shades (one per job, one per draw) so two jobs read as distinct bands
// rather than one indistinguishable block. The government benefit is a single steady tone.
const TAX_COLOR = "#8c3b3b";
// Wages: one step per job, dark → light. Benefit: a single warm tone. Draws
// (capital-gains / ordinary / tax-exempt / any drawdown): a second, earthier family.
const WAGE_TONES = ["#8c3b3b", "#a85a4a", "#c17a5f", "#d5a084"];
const BENEFIT_TONE = "#9c6b4a";
const DRAW_TONES = ["#7a4a3a", "#b8794f", "#9c8459", "#c6a878"];
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e";

/**
 * A colour per tax band, stepping shades within a category so sibling jobs (and sibling
 * draws) are visually distinct — the analog of the income chart's `colorsForBands`. Wages
 * walk the rust family, the benefit is a single tone, everything else walks the earth
 * family; the order matches the bands' stacking order so shades progress cleanly up the
 * stack.
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
  // Stacked per-source view whenever the plan pays tax (attribution is always reported); a
  // zero-tax plan has no sources, so the row carries the lone `taxCents` (a flat zero line).
  const stacked = data.hasSourceBreakdown && data.sources.length > 0;
  // Chart geometry depends only on `data` (stable while scrubbing) — memoize it so moving
  // the selected month, which re-renders this component via `selectedMonth`, doesn't
  // rebuild the colour map or remap every month row.
  const colors = useMemo(() => colorsForBands(data.sources), [data.sources]);
  const rows = useMemo(
    () =>
      data.rows.map((r) =>
        stacked ? { month: r.month, ...r.centsBySource } : { month: r.month, taxCents: r.taxCents },
      ),
    [data.rows, stacked],
  );
  const lastMonth = data.rows[data.rows.length - 1]?.month ?? 0;

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
      {/* Hidden data mirror for tests / screen readers: first row's tax (total + any
          per-source split) and the band labels currently stacked. */}
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
          {stacked && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <ReferenceLine x={selectedMonth} stroke={MARKER} strokeWidth={2} />
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
