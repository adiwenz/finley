import { useMemo, type CSSProperties } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  DefaultTooltipContent,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { formatDollars, monthLabel, yearOf } from "../../format";
import { TODAY_X, axisPointLabel, axisYearTickLabel, fromAxisX, toAxisX, yearTickXs } from "../monthAxis";
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
// Payroll tax (FICA) is a wholly separate LEVY from income tax, so every FICA band — no
// matter which job or category it rides — walks its own cool "slate" family, set apart from
// the warm income-tax rust/earth families above. One step per FICA-charging source.
const FICA_TONES = ["#3b5c78", "#4f7590", "#6c93a8", "#93b6c4"];
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e";

/**
 * A colour per tax band, stepping shades within a family so sibling bands stay distinct —
 * the analog of the income chart's `colorsForBands`. A PAYROLL-tax band always walks the
 * cool FICA family regardless of its category, so FICA reads as one visually distinct levy
 * across every job; an INCOME-tax band walks the warm family its category picks (wages,
 * benefit, or the earthier "draws" catch-all). Input order is stacking order, so shades
 * progress cleanly up the stack.
 */
function colorsForBands(sources: readonly TaxSourceBand[]): Map<string, string> {
  const colors = new Map<string, string>();
  let wage = 0;
  let draw = 0;
  let fica = 0;
  for (const s of sources) {
    if (s.kind === "payrollTax") colors.set(s.id, FICA_TONES[fica++ % FICA_TONES.length]!);
    else if (s.category === "wages") colors.set(s.id, WAGE_TONES[wage++ % WAGE_TONES.length]!);
    else if (s.category === "governmentRetirementBenefit") colors.set(s.id, BENEFIT_TONE);
    else colors.set(s.id, DRAW_TONES[draw++ % DRAW_TONES.length]!);
  }
  return colors;
}

// Matches recharts' own DefaultTooltipContent box (`defaultDefaultTooltipContentProps`) so
// swapping in a custom content renderer for the total row is invisible when there's nothing
// to total.
const TOOLTIP_BOX_STYLE: CSSProperties = {
  margin: 0,
  padding: 10,
  backgroundColor: "#fff",
  border: "1px solid #ccc",
  whiteSpace: "nowrap",
  fontSize: 12,
};

/**
 * The stock per-band rows (via recharts' own `DefaultTooltipContent`, stripped of its box so
 * ours wraps both it and the total), plus a bolded Total row summing every band shown for
 * this month — the reason `describeTaxes`' "peaking around $X/mo" figure and this hover
 * figure should always agree. Only drawn stacked (>1 band); the single-band case would just
 * repeat the one line above it.
 */
function TaxTooltipContent(props: TooltipContentProps<ValueType, NameType>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);
  return (
    <div style={TOOLTIP_BOX_STYLE}>
      <DefaultTooltipContent
        {...props}
        contentStyle={{ margin: 0, padding: 0, border: "none", backgroundColor: "transparent" }}
        formatter={(value, name) => [formatDollars(Number(value)), name]}
        labelFormatter={(l) => axisPointLabel(Number(l), monthLabel)}
      />
      {payload.length > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            marginTop: 4,
            paddingTop: 4,
            borderTop: "1px solid #ccc",
            fontWeight: 600,
          }}
        >
          <span>Total</span>
          <span>{formatDollars(total)}</span>
        </div>
      )}
    </div>
  );
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
  //
  // Every band gets an EXPLICIT 0 in a month it didn't charge, rather than an absent key: a
  // December reconciliation's own bands appear in that one month and nowhere else. Recharts'
  // stacked-area geometry silently stops drawing a stack made entirely of such all-or-nothing
  // series if some points omit the key outright; a real (zeroed) value at every point keeps
  // every series continuous and the stack rendering.
  const rows = useMemo(
    () =>
      data.rows.map((r) => {
        const x = toAxisX(r.month);
        if (!stacked) return { month: x, taxCents: r.taxCents };
        const zeroed: Record<string, number> = {};
        for (const band of data.sources) zeroed[band.id] = r.centsBySource[band.id] ?? 0;
        return { month: x, ...zeroed };
      }),
    [data.rows, data.sources, stacked],
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
            ticks={yearTickXs(lastX)}
            tickFormatter={(x: number) => axisYearTickLabel(x, yearOf)}
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
            content={TaxTooltipContent}
            // Recharts positions the tooltip and legend as sibling absolutely-positioned
            // wrappers in DOM (not paint) order, so the legend — added after in this
            // markup — otherwise paints OVER a tooltip hovering above it. A tooltip that's
            // readable everywhere except behind its own legend is worse than none, so pin
            // it above every other chart layer explicitly.
            wrapperStyle={{ zIndex: 10 }}
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
