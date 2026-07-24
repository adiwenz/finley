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
 * Monthly tax-paid chart — stacked below the income and per-line budget charts (issue
 * #71 lineage), sharing the same x-axis, the same click-to-select gesture, and the same
 * selection marker. Read together with the two above it, it shows the wedge between gross
 * income and gross spending that the tax seam takes out each month.
 *
 * It STACKS BY INCOME SOURCE (issue #110 follow-up), matching the income chart: the engine
 * splits the tax down to the job / account draw that bore it, so each band names its source
 * and is coloured by that source's provenance category — a "money leaving" rust family,
 * distinct from the income blues and the budget greens, with one tone per category so a
 * household's jobs read as sibling shades. When the jurisdiction declines the breakdown (a
 * null jurisdiction) the chart falls back to a single total band, as before. As with the
 * sibling charts, the summary and a hidden data mirror render independently of Recharts so
 * the behaviour is assertable without SVG layout (Recharts needs a real width, absent in
 * jsdom).
 */

// The single-band fallback colour, and a rust family (one tone per provenance category)
// for the stacked view — all read as "tax / money leaving", set apart from the income
// bands. Sources in the same category share a tone; the fallback rotates for anything else.
const TAX_COLOR = "#8c3b3b";
const TAX_CATEGORY_COLORS: Readonly<Record<string, string>> = {
  wages: "#8c3b3b",
  governmentRetirementBenefit: "#a85a4a",
  ordinaryIncome: "#7a4a3a",
  capitalGains: "#b8794f",
  taxExempt: "#6f5a4a",
  savingsDrawdown: "#9c6b4a",
};
const TAX_FALLBACK_COLORS = ["#8c3b3b", "#a85a4a", "#b8794f", "#7a4a3a", "#6f5a4a"];
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e";

/** A colour per tax band: the category's rust tone, or a rotating fallback. */
function colorForSource(band: TaxSourceBand, index: number): string {
  return TAX_CATEGORY_COLORS[band.category] ?? TAX_FALLBACK_COLORS[index % TAX_FALLBACK_COLORS.length]!;
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
  // Stacked view when the jurisdiction reported a per-source breakdown; otherwise a single
  // total band (the fallback). Each row carries either the per-source cents (keyed by
  // source id) or the lone `taxCents`.
  const stacked = data.hasSourceBreakdown && data.sources.length > 0;
  const rows = data.rows.map((r) =>
    stacked ? { month: r.month, ...r.centsBySource } : { month: r.month, taxCents: r.taxCents },
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
            data.sources.map((band, i) => (
              <Area
                key={band.id}
                type="monotone"
                dataKey={band.id}
                name={band.label}
                stackId="tax"
                stroke={colorForSource(band, i)}
                fill={colorForSource(band, i)}
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
