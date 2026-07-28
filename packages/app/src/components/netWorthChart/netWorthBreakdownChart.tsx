/**
 * Net-worth breakdown chart — the stacked companion to the total-only {@link
 * import("./netWorthChart").NetWorthChart}, drawing one Area per component of {@link
 * NetWorthBreakdownData} in one of three user-picked views:
 *
 *  - **Accounts** — the asset accounts only.
 *  - **Assets** — accounts + property values (offered only when the plan owns property).
 *  - **Net worth** — assets stacked above zero, liabilities below, so the signed total is
 *    the nominal net worth the sibling chart draws (offered only when property or debt
 *    makes it differ from Assets).
 *
 * As in the other charts, the summary line and hidden data mirror render independently of
 * Recharts so behaviour is assertable without SVG layout (Recharts needs a real width,
 * absent in jsdom).
 */

import { useMemo, useState } from "react";
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
import { TODAY_X, axisPointLabel, toAxisX } from "../monthAxis";
import type { BreakdownBand, NetWorthBreakdownData } from "./netWorthBreakdown";

const AXIS = "#6b6552";
const GRID = "#e3dcc6";
// Accounts: a green family, dark → light, one step per account so siblings read apart.
const ACCOUNT_TONES = ["#1f3a2e", "#2f5d47", "#3f7d5f", "#5a9c7a", "#7fb89a", "#a7d0bb"];
// Property: a single warm gold, set apart from the account greens.
const PROPERTY_TONES = ["#b5761f", "#cf9a4a"];
// Liabilities: a rust "money owed" family, matching the tax chart's money-leaving rust.
const LIABILITY_TONES = ["#8c3b3b", "#a85a4a", "#c17a5f"];

type Mode = "accounts" | "assets" | "networth";

const MODE_LABELS: Readonly<Record<Mode, string>> = {
  accounts: "Accounts",
  assets: "Assets",
  networth: "Net worth",
};

/** Whole dollars, grouped — for the summary line (the chart axis uses `formatDollars`). */
function dollars(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
}

/** A colour per band, stepping shades within each kind. */
function colorsForBands(bands: readonly BreakdownBand[]): Map<string, string> {
  const colors = new Map<string, string>();
  let account = 0;
  let property = 0;
  let liability = 0;
  for (const b of bands) {
    if (b.kind === "account") colors.set(b.id, ACCOUNT_TONES[account++ % ACCOUNT_TONES.length]!);
    else if (b.kind === "property")
      colors.set(b.id, PROPERTY_TONES[property++ % PROPERTY_TONES.length]!);
    else colors.set(b.id, LIABILITY_TONES[liability++ % LIABILITY_TONES.length]!);
  }
  return colors;
}

/** The bands a given view shows, in stacking order. */
function bandsForMode(bands: readonly BreakdownBand[], mode: Mode): BreakdownBand[] {
  if (mode === "accounts") return bands.filter((b) => b.kind === "account");
  if (mode === "assets") return bands.filter((b) => b.kind !== "liability");
  return [...bands]; // networth: everything, liabilities signed negative below
}

/** One entry Recharts hands a tooltip: a band's id and its (possibly signed) value. */
interface TooltipEntry {
  readonly dataKey?: unknown;
  readonly value?: number | null;
}

/**
 * A month's tooltip entries summed into balance-sheet totals. Liability values arrive
 * already signed (negative in the net-worth view), so net worth is a plain sum and
 * `liabilitiesCents` is ≤ 0 when debt is shown.
 */
export function tooltipTotals(
  entries: readonly TooltipEntry[],
  bands: readonly BreakdownBand[],
): {
  readonly assetsCents: number;
  readonly liabilitiesCents: number;
  readonly netWorthCents: number;
  readonly hasLiabilities: boolean;
} {
  const kindById = new Map(bands.map((b) => [b.id, b.kind]));
  let assetsCents = 0;
  let liabilitiesCents = 0;
  let hasLiabilities = false;
  for (const entry of entries) {
    const value = Number(entry.value) || 0;
    if (kindById.get(String(entry.dataKey)) === "liability") {
      liabilitiesCents += value;
      hasLiabilities = true;
    } else {
      assetsCents += value;
    }
  }
  return { assetsCents, liabilitiesCents, netWorthCents: assetsCents + liabilitiesCents, hasLiabilities };
}

/** One label/value line in the tooltip. */
function TooltipLine({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontWeight: strong ? 600 : 400 }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDollars(cents)}</span>
    </div>
  );
}

/**
 * The breakdown tooltip: each visible band, then a totals block. When debt is in view it
 * splits into Assets / Liabilities / Net worth; otherwise a single Total (assets alone).
 */
function BreakdownTooltip({
  active,
  payload,
  label,
  bands,
}: {
  active?: boolean;
  // Recharts' own payload shape (dataKey can be a function), kept loose; the exported
  // `tooltipTotals` is the strictly typed, unit-tested part.
  payload?: readonly { dataKey?: unknown; value?: number | null; name?: string; color?: string }[];
  label?: string | number;
  bands: readonly BreakdownBand[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const totals = tooltipTotals(payload, bands);
  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        padding: "8px 10px",
        fontSize: 12,
        color: "var(--color-text)",
        minWidth: 160,
      }}
    >
      {/* Same heading the total-net-worth chart uses, so hovering the two side by side reads
          as one instant: "Today" at the axis' today slot, "End of month k" after it. */}
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {axisPointLabel(Number(label) || 0, monthLabel)}
      </div>
      {/* Top band first, matching the visual stack read top-down. */}
      {[...payload].reverse().map((entry) => (
        <div
          key={String(entry.dataKey)}
          style={{ display: "flex", justifyContent: "space-between", gap: 16 }}
        >
          <span style={{ color: entry.color }}>{entry.name}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatDollars(Number(entry.value) || 0)}
          </span>
        </div>
      ))}
      <div style={{ borderTop: "1px solid var(--color-border)", marginTop: 6, paddingTop: 6 }}>
        {totals.hasLiabilities ? (
          <>
            <TooltipLine label="Assets" cents={totals.assetsCents} />
            <TooltipLine label="Liabilities" cents={totals.liabilitiesCents} />
            <TooltipLine label="Net worth" cents={totals.netWorthCents} strong />
          </>
        ) : (
          <TooltipLine label="Total" cents={totals.assetsCents} strong />
        )}
      </div>
    </div>
  );
}

export function NetWorthBreakdownChart({ data }: { data: NetWorthBreakdownData }) {
  // Only offer a view that shows something the previous one doesn't: Assets adds property,
  // Net worth adds debt (or property, when there's no debt but the total still differs).
  const modes: Mode[] = ["accounts"];
  if (data.hasProperties) modes.push("assets");
  if (data.hasProperties || data.hasLiabilities) modes.push("networth");

  const [mode, setMode] = useState<Mode>("accounts");
  const activeMode = modes.includes(mode) ? mode : "accounts";

  const colors = useMemo(() => colorsForBands(data.bands), [data.bands]);
  const visibleBands = bandsForMode(data.bands, activeMode);

  // One point per month on the shared months-from-now axis: each visible band's value keyed by
  // id, liabilities negated in the net-worth view so debt stacks below zero and the stack's
  // total is true net worth. This is a balance sheet, so `opening` gets a real column at the
  // axis' today slot — the balances you hold right now, before any flow.
  const rows = useMemo(() => {
    const pointFor = (centsById: Readonly<Record<string, number>>, x: number) => {
      const point: Record<string, number> = { month: x };
      for (const b of visibleBands) {
        const v = centsById[b.id] ?? 0;
        point[b.id] = activeMode === "networth" && b.kind === "liability" ? -v : v;
      }
      return point;
    };
    return [
      pointFor(data.opening.centsById, TODAY_X),
      ...data.rows.map((r) => pointFor(r.centsById, toAxisX(r.month))),
    ];
  }, [data.opening, data.rows, visibleBands, activeMode]);

  const lastX = toAxisX(data.rows[data.rows.length - 1]?.month ?? 0);
  const accountCount = data.bands.filter((b) => b.kind === "account").length;
  const peak = data.peakNetWorthCents;
  const summary =
    peak === null
      ? "No balances to break down yet."
      : `Peaks around ${dollars(peak)} net worth, across ${accountCount} account${
          accountCount === 1 ? "" : "s"
        }${data.hasProperties ? ", property" : ""}${data.hasLiabilities ? ", and debt" : ""}.`;

  return (
    <div role="img" aria-label={`Net-worth breakdown over time. ${summary}`}>
      <div className="row-between">
        <h3>Net worth breakdown</h3>
        {modes.length > 1 && (
          <div className="seg" role="group" aria-label="Breakdown view">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                className="seg-btn"
                aria-pressed={m === activeMode}
                onClick={() => setMode(m)}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="hint" data-testid="breakdown-summary">
        {summary}
      </p>
      {/* Hidden data mirror for tests / screen readers. */}
      <output data-testid="breakdown-bands" hidden>
        {JSON.stringify(visibleBands.map((b) => b.label))}
      </output>
      <output data-testid="breakdown-first-row" hidden>
        {JSON.stringify(rows[0] ?? {})}
      </output>

      {data.bands.length === 0 ? null : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={rows} margin={{ top: 12, right: 16, bottom: 8, left: 16 }}>
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
              content={(props) => (
                <BreakdownTooltip
                  active={props.active}
                  label={props.label}
                  payload={props.payload?.map((p) => ({
                    dataKey: p.dataKey,
                    value: Number(p.value) || 0,
                    name: p.name == null ? undefined : String(p.name),
                    color: p.color,
                  }))}
                  bands={visibleBands}
                />
              )}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {/* Zero rule matters once debt stacks below it. */}
            {activeMode === "networth" && data.hasLiabilities && (
              <ReferenceLine y={0} stroke={AXIS} />
            )}
            {visibleBands.map((band) => (
              <Area
                key={band.id}
                type="monotone"
                dataKey={band.id}
                name={band.label}
                // SEPARATE stacks so each accumulates from the zero line — assets upward,
                // liabilities (negative) downward — instead of debt stacking off the top
                // of the assets and drifting above zero.
                stackId={band.kind === "liability" ? "liabilities" : "assets"}
                stroke={colors.get(band.id)}
                fill={colors.get(band.id)}
                fillOpacity={0.6}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
