/**
 * The home screen's net-worth graph.
 *
 * Hand-drawn SVG rather than a charting library because every mark on it is load-bearing and
 * the design specifies each one: a filled area under a 2.5px leaf line, four grid rules labelled
 * in mono, a "today" rule at the left edge, a dashed "stop working" rule at the solved age, and a
 * ringed marker per life event so the reader can see which change bent the curve. A library
 * would fight all five.
 *
 * The viewBox is a fixed 1000×320 with `preserveAspectRatio="none"`, so the plot stretches to its
 * container and only the strokes need re-thinking at width — which is why the axis labels live in
 * HTML beneath the SVG rather than inside it, where non-uniform scaling would distort the type.
 */

import type { Cents, ProjectionSeries } from "@finley/engine";
import { abbreviateDollars } from "../../homeView";
import type { LifeChangeRow } from "../../homeView";

const WIDTH = 1000;
const HEIGHT = 320;
const GRID_STEPS = 4;

export interface NetWorthPlotProps {
  readonly series: ProjectionSeries;
  /** Months from now to the solved stop-working age; `null` when the plan reaches none. */
  readonly retirementMonth: number | null;
  /** The plan's own span, so the axis reaches life expectancy even when the run stopped early. */
  readonly horizonMonths: number;
  readonly lifeChanges: readonly LifeChangeRow[];
  /** The primary's age now, for the age axis beneath the plot. */
  readonly currentAge: number;
  /**
   * The authored plan, drawn dashed behind the main line — present only while previewing a
   * hypothesis, so the reader can see what the hypothesis moved. Both lines share one scale, so
   * the comparison is read off the geometry rather than off two axes.
   */
  readonly baseline?: ProjectionSeries;
}

interface Scale {
  readonly x: (month: number) => number;
  readonly y: (cents: Cents) => number;
  readonly min: number;
  readonly max: number;
}

/**
 * The value axis always includes zero and pads the top by 6%, so the line never touches the
 * frame. A plan that goes negative gets 12% of headroom below — debt should be legible as depth,
 * not clipped against the axis.
 */
function scaleFor(values: readonly Cents[], horizonMonths: number): Scale {
  let min = 0;
  let max = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max === min) max = min + 1;
  max *= 1.06;
  if (min < 0) min *= 1.12;
  const span = Math.max(1, horizonMonths);
  return {
    x: (month) => (month / span) * WIDTH,
    y: (cents) => HEIGHT - ((cents - min) / (max - min)) * HEIGHT,
    min,
    max,
  };
}

export function NetWorthPlot({
  series,
  retirementMonth,
  horizonMonths,
  lifeChanges,
  currentAge,
  baseline,
}: NetWorthPlotProps) {
  // Real (inflation-adjusted) net worth: the home screen speaks in today's dollars, because a
  // figure 40 years out is only meaningful against money the reader can price today.
  const points = series.months
    .map((m) => ({ month: m.month, cents: m.netWorthRealCents }))
    .filter((p): p is { month: number; cents: Cents } => p.cents !== null);

  if (points.length === 0) return null;

  const baselinePoints = (baseline?.months ?? [])
    .map((m) => ({ month: m.month, cents: m.netWorthRealCents }))
    .filter((p): p is { month: number; cents: Cents } => p.cents !== null);

  // One scale over BOTH series: a baseline drawn to its own extent would make a change that
  // lowered net worth look like one that raised it.
  const scale = scaleFor(
    [...points, ...baselinePoints].map((p) => p.cents),
    horizonMonths,
  );

  const pathOf = (ps: readonly { month: number; cents: Cents }[]) =>
    ps
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"}${scale.x(p.month).toFixed(1)} ${scale.y(p.cents).toFixed(1)}`,
      )
      .join(" ");
  const line = pathOf(points);
  const zeroY = scale.y(0).toFixed(1);
  const area = `${line} L${scale.x(points[points.length - 1]!.month).toFixed(1)} ${zeroY} L0 ${zeroY} Z`;

  const grid = Array.from({ length: GRID_STEPS + 1 }, (_, i) => {
    const value = scale.min + (scale.max - scale.min) * (i / GRID_STEPS);
    const y = scale.y(value);
    return { y, label: abbreviateDollars(value) };
  });

  // Markers ride the curve: the nearest simulated month to the event, so a dot always sits ON the
  // line rather than floating beside it when the series is truncated by a block.
  const markers = lifeChanges.flatMap((change) => {
    const point = points.reduce((best, p) =>
      Math.abs(p.month - change.month) < Math.abs(best.month - change.month) ? p : best,
    );
    if (Math.abs(point.month - change.month) > 12) return [];
    return [{ id: change.id, x: scale.x(point.month), y: scale.y(point.cents), color: change.color }];
  });

  const stopPct = retirementMonth === null ? null : (retirementMonth / horizonMonths) * 100;

  // One tick per decade of the reader's life — the axis is about their age, not the calendar.
  const ticks: { label: string; pct: number }[] = [];
  for (let month = 0; month <= horizonMonths; month += 120) {
    ticks.push({ label: `Age ${currentAge + month / 12}`, pct: (month / horizonMonths) * 100 });
  }

  return (
    <div>
      <div className="relative pt-2">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="block h-[340px] w-full overflow-visible"
          role="img"
          aria-label="Net worth over time, in today's dollars"
        >
          <defs>
            <linearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--leaf-500)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--leaf-500)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {grid.map((g) => (
            <g key={g.label + g.y}>
              <line x1="0" y1={g.y} x2={WIDTH} y2={g.y} stroke="var(--border-subtle)" strokeWidth="1" />
              <text x="4" y={g.y - 5} fill="var(--ink-400)" fontSize="11" fontFamily="var(--font-mono)">
                {g.label}
              </text>
            </g>
          ))}

          <path d={area} fill="url(#netWorthFill)" />
          {baselinePoints.length > 0 && (
            <path
              d={pathOf(baselinePoints)}
              fill="none"
              stroke="var(--ink-400)"
              strokeWidth="1.6"
              strokeDasharray="5 5"
              opacity="0.75"
            />
          )}
          <path d={line} fill="none" stroke="var(--leaf-700)" strokeWidth="2.5" strokeLinejoin="round" />

          <line x1="0.5" y1="0" x2="0.5" y2={HEIGHT} stroke="var(--ink-200)" strokeWidth="1.5" />
          {retirementMonth !== null && (
            <line
              x1={scale.x(retirementMonth)}
              y1="0"
              x2={scale.x(retirementMonth)}
              y2={HEIGHT}
              stroke="var(--leaf-700)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
          )}

          {markers.map((m) => (
            <circle
              key={m.id}
              cx={m.x}
              cy={m.y}
              r="4.5"
              fill="var(--surface-card)"
              stroke={m.color}
              strokeWidth="2.5"
            />
          ))}
        </svg>

        <span className="absolute top-0.5 left-0 bg-surface-card px-1.5 text-[11px] font-semibold tracking-[var(--tracking-caps)] text-ink-400 uppercase">
          Today
        </span>
        {stopPct !== null && (
          <span
            className="absolute top-0.5 -translate-x-1/2 bg-surface-card px-1.5 text-[11px] font-semibold tracking-[var(--tracking-caps)] text-leaf-700 uppercase"
            style={{ left: `${stopPct}%` }}
          >
            Stop working
          </span>
        )}
      </div>

      <div className="mt-1.5 flex justify-between border-t border-border-subtle pt-2.5 pb-3">
        {ticks.map((t) => (
          <span key={t.label} className="font-mono text-[12px] text-ink-400">
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
