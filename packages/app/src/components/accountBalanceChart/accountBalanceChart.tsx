/**
 * A single account's balance-over-time line, small enough to sit inline in the account's own
 * editing row rather than opening a separate reporting surface. Draws on the same
 * months-from-now axis as every other projection chart ({@link import("../monthAxis")}), so
 * hovering it and the net-worth chart above reads as one instant.
 */

import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDollars, monthLabel, yearOf } from "../../format";
import { TODAY_X, axisPointLabel, axisYearTickLabel, yearTickXs } from "../monthAxis";
import { NotSimulatedHatch, useHatchId } from "../netWorthChart/notSimulatedHatch";
import type { AccountBalanceData } from "./accountBalanceSeries";

const INK = "#1f3a2e";
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
const STOPPED = "#9b2c2c";

function BalanceTooltip({
  active,
  payload,
  label,
  ownerLabel,
}: {
  active?: boolean;
  payload?: readonly { value?: number | null }[];
  label?: string | number;
  ownerLabel?: string | null;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const cents = Number(payload[0]?.value) || 0;
  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        padding: "6px 8px",
        fontSize: 12,
        color: "var(--color-text)",
        minWidth: 140,
      }}
    >
      <div style={{ fontWeight: 600 }}>{axisPointLabel(Number(label) || 0, monthLabel)}</div>
      {ownerLabel && <div style={{ color: AXIS }}>{ownerLabel}</div>}
      <div style={{ fontVariantNumeric: "tabular-nums" }}>{formatDollars(cents)}</div>
    </div>
  );
}

export interface AccountBalanceChartProps {
  readonly label: string;
  /** Whose account this is — shown in the tooltip only when the household has more than one member. */
  readonly ownerLabel?: string | null;
  readonly data: AccountBalanceData;
}

export function AccountBalanceChart({ label, ownerLabel, data }: AccountBalanceChartProps) {
  const hatchId = useHatchId("acct");
  const last = data.points[data.points.length - 1];
  const summary = last ? `${formatDollars(last.balanceCents)} projected` : "No balance to project yet.";

  return (
    <div role="img" aria-label={`${label} projected balance over time. ${summary}`}>
      {/* Hidden data mirror for tests / screen readers — the opening ("Today") point every
          projection stock chart is required to seed with, asserted without SVG layout. */}
      <output data-testid="account-balance-first-point" hidden>
        {JSON.stringify(data.points[0] ?? {})}
      </output>
      <ResponsiveContainer width="100%" height={120}>
        <ComposedChart data={[...data.points]} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <NotSimulatedHatch id={hatchId} stroke={STOPPED} />
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="x"
            type="number"
            domain={[TODAY_X, data.xMax]}
            allowDataOverflow
            ticks={yearTickXs(data.xMax)}
            tickFormatter={(x: number) => axisYearTickLabel(x, yearOf)}
            tick={{ fill: AXIS, fontSize: 10 }}
            stroke={GRID}
            height={20}
          />
          <YAxis
            width={56}
            tickFormatter={formatDollars}
            tick={{ fill: AXIS, fontSize: 10 }}
            stroke={GRID}
          />
          <Tooltip content={<BalanceTooltip ownerLabel={ownerLabel} />} />
          {data.stopped !== null && (
            <ReferenceArea
              x1={data.stopped.fromX}
              x2={data.stopped.toX}
              fill={`url(#${hatchId})`}
              stroke="none"
            />
          )}
          <Line
            type="monotone"
            dataKey="balanceCents"
            name={label}
            stroke={INK}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
