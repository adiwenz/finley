import { useMemo, useState, type CSSProperties } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  DefaultTooltipContent,
  Legend,
  Line,
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
import type { CashFlowChartData, CashFlowMode, CashFlowView } from "./cashFlowChartData";
import { buildCashFlowChartModel, NET_KEY, SPENDING_NEED_KEY } from "./cashFlowChartModel";

/**
 * The monthly cash-flow chart above the budget chart, sharing its x-axis, click-to-select
 * gesture and marker. THREE VIEWS of one month, chosen with a radio group:
 *
 *  • **Coming in** — every dollar the household receives: each job, each benefit, a tax refund.
 *  • **Going out** — every dollar it pays: income tax, FICA, a settled balance, every budget
 *    line, every debt payment.
 *  • **Net** — the difference, as one signed line. No bands: the whole point of the net view is
 *    that it is a single number, positive where the month saved and negative where it drew.
 *
 * The views exist so that nothing is ever netted per SOURCE. Both stacks are positive by
 * construction, so there is no clamp and no pro-rata haircut anywhere in this chart — see
 * {@link import("./cashFlowChartData")} for why that mattered.
 *
 * Pure preparation — band collapse, colours, row mapping, formatting — lives in {@link
 * buildCashFlowChartModel}; this component owns only the local view/mode state, the click
 * gesture and the Recharts JSX. The summary and data mirrors render outside Recharts (jsdom
 * gives no real width).
 */

const SPENDING_NEED_COLOR = "#9c5b39"; // the dashed "is it enough" line
const NET_COLOR = "#2f5d7c"; // the net view's single signed series
const ZERO_COLOR = "#8a8570"; // the net view's break-even rule
const BROKE_COLOR = "#b23a2e"; // the "plan runs out" marker
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const MARKER = "#1f3a2e"; // the selected-month rule

/**
 * The radio group's options, in the order money moves: what arrives, what leaves, what's left.
 * Labels are plain English rather than "inflows"/"outflows" — the type says that; the person
 * reading the chart wants the sentence.
 */
const VIEW_CHOICES: readonly (readonly [CashFlowView, string])[] = [
  ["inflows", "Coming in"],
  ["outflows", "Going out"],
  ["net", "Net"],
];

/** Every owner cut, plus the combined household the chart opens on. */
const COMBINED = "__combined__";

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

/**
 * The stock rows, minus the bands paying nothing this month. Every band is present in every row
 * — zero-filled so a once-a-year band still draws — which would otherwise make Advanced hover as
 * nine lines of which one carries money. The spending need always stays: hidden at $0 it would
 * read as "not shown" rather than "nothing to cover".
 */
export function CashFlowTooltipContent(props: TooltipContentProps<ValueType, NameType>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const paying = payload.filter(
    (e) => e.dataKey === SPENDING_NEED_KEY || e.dataKey === NET_KEY || Number(e.value) !== 0,
  );
  return (
    <DefaultTooltipContent
      {...props}
      payload={paying}
      contentStyle={{ fontSize: 12 }}
      formatter={(value, name) => [formatDollars(Number(value)), name]}
      labelFormatter={(label) => axisPointLabel(Number(label), monthLabel)}
    />
  );
}

export interface CashFlowChartProps {
  readonly data: CashFlowChartData;
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

export function CashFlowChart({
  data,
  currentAge,
  selectedMonth,
  personNames,
  onSelectMonth,
}: CashFlowChartProps) {
  const [mode, setMode] = useState<CashFlowMode>("simple");
  const [view, setView] = useState<CashFlowView>("inflows");
  const [owner, setOwner] = useState<string>(COMBINED);

  // Everyone the household HAS, not everyone who happened to carry money. Deriving the list from
  // drawn bands meant a partner who joined with no job and no balances was never offered a cut of
  // their own, while a preset partner — who always arrives funded — always was: the same
  // partnership, registered or not depending on its bank balance. The roster answers for both the
  // same way, and an empty cut is itself the answer to "what does Blake bring?".
  //
  // The same list in every view, too: the cut offered under "Coming in" used to be whoever drew
  // an inflow band there, so a person the household could compare under "Net" vanished from the
  // toggle by switching view, which reads as the toggle losing them rather than as their income
  // being nil.
  const owners = useMemo(() => [...personNames.keys()], [personNames]);
  const ownerOptions = owners.length > 1 ? [COMBINED, ...owners] : [];
  const activeOwner = ownerOptions.includes(owner) ? owner : COMBINED;
  /** Whose cut is showing, or `null` in Combined — where it is the household's, not a person's. */
  const whose = activeOwner === COMBINED ? null : (personNames.get(activeOwner) ?? activeOwner);

  // None of this depends on `selectedMonth`, so scrubbing the selection — a frequent re-render
  // — doesn't recompute the band collapse or remap every month row.
  const model = useMemo(
    () =>
      buildCashFlowChartModel(data, {
        view,
        mode,
        personNames,
        currentAge,
        ...(activeOwner === COMBINED ? {} : { ownerId: activeOwner }),
      }),
    [data, view, mode, personNames, currentAge, activeOwner],
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        {/* Informational, not a warning: a retirement income gap is expected. The
            plan-is-broken case is the broke marker plus the budget chart's amber band. */}
        <p className="hint" data-testid="income-summary">
          {model.gapSummary ?? "Cash flow continues across the whole horizon."}
        </p>
        {/* Under the headline, not in place of it: the household's own statement stays the thing
            the reader is told first, and this adds what it could not say. */}
        {model.gapNote !== null && (
          <p className="hint subtle" data-testid="income-summary-note">
            {model.gapNote}
          </p>
        )}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
          {ownerOptions.length > 1 && (
            <div className="seg" role="group" aria-label="Whose cash flow">
              {ownerOptions.map((o) => (
                <button
                  key={o}
                  type="button"
                  className="seg-btn"
                  aria-pressed={o === activeOwner}
                  onClick={() => setOwner(o)}
                >
                  {o === COMBINED ? "Combined" : (personNames.get(o) ?? o)}
                </button>
              ))}
            </div>
          )}
          {/* Three views of one month, not three charts: the same axis, marker and click
              gesture, so toggling never moves the reader. */}
          <fieldset
            style={{ display: "inline-flex", alignItems: "center", gap: 10, margin: 0, padding: 0, border: 0, fontSize: 12 }}
          >
            <legend style={{ padding: 0, marginRight: 4, float: "left" }}>Show:</legend>
            {VIEW_CHOICES.map(([v, label]) => (
              <label key={v} style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                <input
                  type="radio"
                  name="cash-flow-view"
                  checked={view === v}
                  onChange={() => setView(v)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {/* Two chart presentations, not a feature that's on or off: a radio group states the
              choice explicitly and keeps one active mode visible, where a lone "Advanced"
              checkbox left "Simple" unnamed. Native radios carry the keyboard and a11y
              semantics; `mode` stays the single union, never a boolean per option. */}
          {/* The net view has no bands, so there is nothing for Simple/Advanced to collapse. */}
          <fieldset
            hidden={view === "net"}
            style={{ display: "inline-flex", alignItems: "center", gap: 10, margin: 0, padding: 0, border: 0, fontSize: 12 }}
          >
            <legend style={{ padding: 0, marginRight: 4, float: "left" }}>Chart detail:</legend>
            {(["simple", "advanced"] as const).map((m) => (
              <label key={m} style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                <input
                  type="radio"
                  name="cash-flow-mode"
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
                <th scope="row">
                  {model.view === "inflows"
                    ? "Total cash coming in"
                    : model.view === "outflows"
                      ? "Total cash going out"
                      : "Net cash flow"}
                </th>
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
      <output data-testid="income-first-net" hidden>
        {model.rows[0]?.[model.netKey] ?? 0}
      </output>
      <output data-testid="income-first-spending-need" hidden>
        {model.rows[0]?.[model.spendingNeedKey] ?? 0}
      </output>
      <output data-testid="income-second-spending-need" hidden>
        {model.rows[1]?.[model.spendingNeedKey] ?? 0}
      </output>

      {/* Said as its own clause, not as a possessive glued to a title: "Blake's Monthly cash
          coming in" was not a phrase, and the sentence after it already names them. */}
      <div
        role="img"
        aria-label={whose === null ? model.accessibleSummary : `${whose}'s share. ${model.accessibleSummary}`}
      >
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
            content={CashFlowTooltipContent}
            // Recharts positions the tooltip and legend as sibling absolutely-positioned
            // wrappers in DOM (not paint) order, so the legend — added after in this markup —
            // otherwise paints OVER a tooltip hovering above it.
            wrapperStyle={{ zIndex: 10 }}
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
              stackId="cash-flow"
              // Not a surface-coloured separator hairline: Recharts keys the legend swatch and
              // tooltip entry to `stroke`, so a surface stroke erases both. The full-opacity
              // stroke over the 0.6 fill gives each band its darker edge.
              stroke={band.color}
              fill={band.color}
              fillOpacity={0.6}
              isAnimationActive={false}
            />
          ))}
          {/* The net view: one signed series filled back to zero, so a surplus reads as area
              above the break-even rule and a shortfall as area below it. `baseValue={0}` rather
              than the axis minimum, which would fill a negative month from the bottom of the
              chart and make every shortfall look total. */}
          {model.view === "net" && (
            <>
              <ReferenceLine y={0} stroke={ZERO_COLOR} strokeWidth={1} />
              <Area
                type="monotone"
                dataKey={model.netKey}
                name="Net cash flow"
                baseValue={0}
                stroke={NET_COLOR}
                fill={NET_COLOR}
                fillOpacity={0.35}
                isAnimationActive={false}
              />
            </>
          )}
          {model.showsSpendingNeed && (
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
          )}
        </ComposedChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}
