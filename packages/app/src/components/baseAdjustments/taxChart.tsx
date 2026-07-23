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
import { describeTaxes, type TaxChartData } from "./taxesByMonth";

/**
 * Monthly tax-paid chart — stacked below the income and per-line budget charts (issue
 * #71 lineage), sharing the same x-axis, the same click-to-select gesture, and the same
 * selection marker. Read together with the two above it, it shows the wedge between gross
 * income and gross spending that the tax seam takes out each month.
 *
 * A single band, in a "money leaving" rust tone distinct from the income blues and the
 * budget greens — only the TOTAL monthly tax is available (the jurisdiction owns the
 * per-category combination), so there is nothing honest to stack. As with the sibling
 * charts, the summary and a hidden data mirror render independently of Recharts so the
 * behaviour is assertable without SVG layout (Recharts needs a real width, absent in
 * jsdom).
 */

const TAX_COLOR = "#8c3b3b";
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e";

export interface TaxChartProps {
  readonly data: TaxChartData;
  /** The month the editor is pointed at — marked with a vertical rule. */
  readonly selectedMonth: number;
  /** Called with the clicked month, so the panel can move the editor there. */
  readonly onSelectMonth: (month: number) => void;
}

export function TaxChart({ data, selectedMonth, onSelectMonth }: TaxChartProps) {
  const summary = describeTaxes(data);
  const rows = data.rows.map((r) => ({ month: r.month, taxCents: r.taxCents }));
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
      {/* Hidden data mirror for tests / screen readers: first row's tax. */}
      <output data-testid="tax-first-row" hidden>
        {JSON.stringify(data.rows[0] ?? {})}
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
            formatter={(value) => [formatDollars(Number(value)), "Tax"]}
            labelFormatter={(label) => `Month ${label}`}
            contentStyle={{ fontSize: 12 }}
          />
          <ReferenceLine x={selectedMonth} stroke={MARKER} strokeWidth={2} />
          <Area
            type="monotone"
            dataKey="taxCents"
            name="Tax"
            stroke={TAX_COLOR}
            fill={TAX_COLOR}
            fillOpacity={0.6}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
