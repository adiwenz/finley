import { useMemo, useState, type CSSProperties } from "react";
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
import { formatDollars, monthLabel, yearOf } from "../../format";
import { TODAY_X, axisPointLabel, axisYearTickLabel, fromAxisX, toAxisX, yearTickXs } from "../monthAxis";
import type { IncomeBasis, IncomeChartData, IncomeMode } from "./incomeChartData";
import { buildIncomeChartModel } from "./incomeChartModel";

/**
 * Monthly cash-flows-vs.-spending chart above the budget chart, sharing its x-axis,
 * click-to-select gesture and marker. Stacks every cash source — wages, benefit, interest,
 * asset and savings draws — broader than "income". Simple (default) folds every draw into
 * one "Living off savings" band; Advanced splits each source out.
 *
 * Bands are take-home by default (after the source's own tax and pre-tax deferral); gross
 * would show money that never reaches the checking account, overstating headroom.
 *
 * Pure preparation — band collapse, colours, row mapping, formatting — lives in {@link
 * buildIncomeChartModel}; this component owns only the local mode/basis state, the click
 * gesture and the Recharts JSX. The summary and data mirrors render outside Recharts (jsdom
 * gives no real width).
 */

const SPENDING_NEED_COLOR = "#9c5b39"; // the dashed "is it enough" line
const BROKE_COLOR = "#b23a2e"; // the "plan runs out" marker
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e"; // the selected-month rule

/**
 * Off-screen but in the accessibility tree — the standard clip-rect idiom, not `display:none`
 * (which would drop it from a screen reader too). Carries the nonvisual data table Recharts'
 * SVG can't be.
 */
/**
 * Off-screen for sight, present for a screen reader — and it must go on a WRAPPER, never on the
 * thing being hidden, when that thing is a `<table>`.
 *
 * A table sizes to its content: `width`/`height` are minimums it ignores, and neither `overflow`
 * nor the legacy `clip` keeps it from laying out at full size. The a11y table below runs to a row
 * group per interesting moment in a lifetime projection, so hidden-on-the-table left a tall
 * absolutely-positioned element on the page and the document scrolled thousands of pixels past
 * the last thing anyone could see. A `<div>` honours all three properties, and the table inside
 * keeps its own display and its semantics intact.
 */
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

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
  // None of this depends on `selectedMonth`, so scrubbing the selection — a frequent re-render
  // — doesn't recompute the band collapse or remap every month row.
  const model = useMemo(
    () => buildIncomeChartModel(data, { mode, basis, personNames, currentAge }),
    [data, mode, basis, personNames, currentAge],
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        {/* Informational, not a warning: a retirement income gap is expected. The
            plan-is-broken case is the broke marker plus the budget chart's amber band. */}
        <p className="hint" data-testid="income-summary">
          {model.gapSummary ?? "Cash flow continues across the whole horizon."}
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
          {/* Two chart presentations, not a feature that's on or off: a radio group states the
              choice explicitly and keeps one active mode visible, where a lone "Advanced"
              checkbox left "Simple" unnamed. Native radios carry the keyboard and a11y
              semantics; `mode` stays the single union, never a boolean per option. */}
          <fieldset
            style={{ display: "inline-flex", alignItems: "center", gap: 10, margin: 0, padding: 0, border: 0, fontSize: 12 }}
          >
            <legend style={{ padding: 0, marginRight: 4, float: "left" }}>Chart detail:</legend>
            {(["simple", "advanced"] as const).map((m) => (
              <label key={m} style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                <input
                  type="radio"
                  name="income-mode"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {m === "simple" ? "Simple" : "Advanced"}
              </label>
            ))}
          </fieldset>
        </div>
      </div>

      {/* The chart as a nonvisual table: not one unlabeled starting snapshot, but a row per
          moment worth reading — the projection's start, a band beginning/ending/changing, a
          spending-need change, the first savings withdrawal, insolvency — each headed by when
          and why. The visual chart below is marked role="img" with a one-line label, so a
          screen reader gets the gist from the image and the detail here. */}
      <div style={VISUALLY_HIDDEN}>
        <table data-testid="income-a11y-table">
          <caption>{model.accessibleSummary}</caption>
          {model.accessibleMoments.map((moment, i) => (
            <tbody key={i}>
              <tr>
                <th scope="rowgroup" colSpan={2}>
                  {moment.label} — {moment.reason}
                </th>
              </tr>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Monthly amount</th>
              </tr>
              {moment.sources.map((row, j) => (
                <tr key={`${row.label}-${j}`}>
                  <th scope="row">{row.label}</th>
                  <td>{row.amount}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Total cash available</th>
                <td>{moment.totalCashFlow}</td>
              </tr>
              <tr>
                <th scope="row">Spending need</th>
                <td>{moment.spendingNeed}</td>
              </tr>
            </tbody>
          ))}
        </table>
      </div>

      {/* Test-only mirrors, `hidden` so they stay out of the accessibility tree (the table
          above is the screen-reader representation); jsdom reads their textContent regardless.
          The first two rows are both mirrored because month 0 is an ORIGINATION month: a loan
          authored at Year 0 is not serviced until month 1, so only the second row shows what
          servicing it costs. */}
      <output data-testid="income-first-row" hidden>
        {JSON.stringify(model.bands.reduce<Record<string, number>>((acc, b) => {
          const cents = model.rows[0]?.[b.id];
          if (cents !== undefined) acc[b.id] = cents;
          return acc;
        }, {}))}
      </output>
      <output data-testid="income-bands" hidden>
        {JSON.stringify(model.bands.map((b) => b.label))}
      </output>
      <output data-testid="income-first-spending-need" hidden>
        {model.rows[0]?.[model.spendingNeedKey] ?? 0}
      </output>
      <output data-testid="income-second-spending-need" hidden>
        {model.rows[1]?.[model.spendingNeedKey] ?? 0}
      </output>

      <div role="img" aria-label={model.accessibleSummary}>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart
          data={model.rows as Record<string, number>[]}
          margin={{ top: 16, right: 16, bottom: 8, left: 16 }}
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
            domain={[TODAY_X, model.lastX]}
            allowDataOverflow
            ticks={yearTickXs(model.lastX)}
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
            formatter={(value, name) => [formatDollars(Number(value)), name]}
            labelFormatter={(label) => axisPointLabel(Number(label), monthLabel)}
            contentStyle={{ fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine x={toAxisX(selectedMonth)} stroke={MARKER} strokeWidth={2} />
          {model.brokeMonth !== null && (
            <ReferenceLine
              x={toAxisX(model.brokeMonth)}
              stroke={BROKE_COLOR}
              strokeWidth={1.5}
              strokeDasharray="2 4"
              label={{
                value: `broke · ${model.brokeAgeLabel}`,
                position: "top",
                fill: BROKE_COLOR,
                fontSize: 11,
              }}
            />
          )}
          {model.bands.map((band) => (
            <Area
              key={band.id}
              type="monotone"
              dataKey={band.id}
              name={band.label}
              stackId="income"
              // Not a surface-coloured separator hairline: Recharts keys the legend swatch and
              // tooltip entry to `stroke`, so a surface stroke erases both. The full-opacity
              // stroke over the 0.6 fill gives each band its darker edge.
              stroke={band.color}
              fill={band.color}
              fillOpacity={0.6}
              isAnimationActive={false}
            />
          ))}
          <Line
            type="monotone"
            dataKey={model.spendingNeedKey}
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
    </div>
  );
}
