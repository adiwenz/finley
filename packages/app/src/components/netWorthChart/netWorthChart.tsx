import type { ProjectionSeries } from "@finley/engine";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDollars, monthLabel, yearOf } from "../../format";
import { TODAY_X, axisPointLabel, axisYearTickLabel, toAxisX } from "../monthAxis";
import { buildNetWorthChartData, type RunsOutMarker } from "./netWorthChartData";

const INK = "#1f3a2e"; // ledger ink green (nominal)
const AMBER = "#b5761f"; // real (today's dollars)
const RED = "#9b2c2c"; // the shortfall-adjusted endpoint — a counterfactual, not a series
const AXIS = "#6b6552";
const GRID = "#e3dcc6";

/**
 * The tooltip. Two jobs beyond formatting: it never shows the counterfactual endpoint as if it
 * were a reported net worth, and on the insolvent month it states the assumption that produced
 * it — that the unfunded obligations were met with additional debt. Presenting the shortfall as
 * credit-card debt would be a lie in the other direction: the cards are at their limits
 * precisely because they could NOT absorb it.
 */
function NetWorthTooltip({
  active,
  payload,
  label,
  runsOut,
}: {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; value?: number | null }[];
  label?: string | number;
  runsOut: RunsOutMarker | null;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const x = Number(label) || 0;
  const at = (key: string) => payload.find((p) => p.dataKey === key)?.value ?? null;
  const nominal = at("nominalCents");
  const real = at("realCents");
  const isRunsOut = runsOut !== null && x === runsOut.x;

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        padding: "8px 10px",
        fontSize: 12,
        color: "var(--color-text)",
        minWidth: 180,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{axisPointLabel(x, monthLabel)}</div>
      {nominal !== null && <Row label="Nominal" cents={Number(nominal)} />}
      {real !== null && <Row label="Real (today's dollars)" cents={Number(real)} />}
      {isRunsOut && (
        <>
          <Row
            label="Shortfall-adjusted net worth"
            cents={runsOut.debtFundedNetWorthCents}
            color={RED}
            strong
          />
          <div style={{ marginTop: 6, color: AXIS, maxWidth: 250 }}>
            Savings and credit are exhausted, so net worth is no longer reported from here. The
            dashed figure assumes the unfunded obligations were paid with additional debt — an
            illustration of where this month would have landed, not a projected balance.
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  label,
  cents,
  color,
  strong,
}: {
  label: string;
  cents: number;
  color?: string;
  strong?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        color,
        fontWeight: strong ? 600 : 400,
      }}
    >
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDollars(cents)}</span>
    </div>
  );
}

/** `retirementMonth`: the solved Mode-1 retirement age as a month offset. */
export function NetWorthChart({
  series,
  retirementMonth,
}: {
  series: ProjectionSeries;
  retirementMonth?: number | null;
}) {
  // Every decision about where the curve ends, where the marker goes and what the dashed drop
  // represents lives in `buildNetWorthChartData`, which is unit-tested; this component only
  // draws what it is handed. See {@link import("../monthAxis")} for the shared x-axis.
  const { points, runsOut, xMax, yearTicks } = buildNetWorthChartData(series);

  return (
    <div
      role="img"
      aria-label="Projected net worth over time (nominal and real)"
    >
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart
          data={[...points]}
          margin={{ top: 16, right: 16, bottom: 8, left: 16 }}
        >
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="x"
            type="number"
            domain={[TODAY_X, xMax]}
            allowDataOverflow
            ticks={[...yearTicks]}
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
          <ReferenceLine y={0} stroke="#c9bfa5" />
          {retirementMonth != null && (
            <ReferenceLine
              x={toAxisX(retirementMonth)}
              stroke={AMBER}
              strokeDasharray="4 4"
              label={{ value: "Retire", position: "top", fill: AMBER, fontSize: 11 }}
            />
          )}
          <Tooltip content={<NetWorthTooltip runsOut={runsOut} />} />
          <Area
            type="monotone"
            dataKey="nominalCents"
            name="Nominal"
            stroke={INK}
            strokeWidth={2}
            fill={INK}
            fillOpacity={0.12}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="realCents"
            name="Real (today's dollars)"
            stroke={AMBER}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {/* The counterfactual segment. Dashed and separately coloured so it cannot be mistaken
              for a projected balance, and `connectNulls` joins its only two non-null points —
              there is no third, so nothing continues past the failure. */}
          {runsOut !== null && (
            <Line
              type="linear"
              dataKey="debtFundedNetWorthCents"
              name="Shortfall-adjusted net worth"
              stroke={RED}
              strokeWidth={2}
              strokeDasharray="5 4"
              connectNulls
              dot={false}
              legendType="none"
              isAnimationActive={false}
            />
          )}
          {runsOut !== null && (
            <ReferenceDot
              x={runsOut.x}
              y={runsOut.debtFundedNetWorthCents}
              r={4}
              fill={RED}
              stroke="none"
              label={{ value: "runs out", position: "right", fill: AXIS, fontSize: 11 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
