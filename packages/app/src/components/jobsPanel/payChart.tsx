/**
 * One job's pay on an age axis spanning the owner's whole life — birth to retirement — running
 * straight through "now".
 *
 * Both ends are lifetime landmarks — birth, and retirement (or the job's end, if it outlasts
 * that) — rather than the job's own extent, so every ordinary job on the panel is drawn against
 * the same span. An axis hugging each job auto-scales, which makes a four-year job and a
 * forty-year one look alike; a fixed lifetime makes the comparison honest by making it visual.
 * The price is a flat stretch before anyone works, and it is worth paying.
 *
 * The chart exists to make the month-0 seam a **shape** rather than a sentence. Where the
 * reconstructed history lands at month −1 and the authored current salary disagree, the engine
 * keeps both and lets the current one win (see `SalaryTrajectory`); drawn, that is a literal
 * vertical jump at "now", annotated in place. Set the two anchors equal and the line goes
 * continuous and the annotation disappears — the chart teaches the rule instead of explaining
 * it.
 *
 * Three things about it are load-bearing:
 *
 * - **Pay is a staircase, never interpolated** (`type="stepAfter"`). Pay is flat between
 *   changes, so a straight line between them invents raises that never happened — and, worse,
 *   smooths the month-0 jump into a slope, hiding the exact thing the chart is here to show.
 * - **There is no net-worth line, on purpose.** Income is a flow and drawing earnings you
 *   actually had across your past is honest; a balance is a stock, and drawing one over a span
 *   the app never simulated implies an accumulation that isn't there. Prototyped, and the
 *   failure mode was that the honest version (a line starting at "now", nothing to its left)
 *   reads as an unfinished chart rather than as the rule.
 * - **The axis is also an input:** clicking an age seeds a pay change there. That works
 *   precisely *because* the axis is age — clicking left of "now" is an ordinary act needing no
 *   new vocabulary, where a month picker would have to explain a negative number.
 *
 * Recharts, like every other chart in the app. The summary and the seam mirror render OUTSIDE
 * Recharts, because jsdom gives it no real width and it draws nothing there — the same reason
 * `incomeChart` and `taxChart` carry their own mirrors.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { JobPayPath } from "@finley/engine";
import { formatDollars } from "../../format";
import { monthAtOwnerAge, ownerAgeAtMonth } from "../../planPeople";
import styles from "./jobsPanel.module.css";

// The panel's accent (`--color-accent`), with the shared earth axis/grid the other charts use.
// Literals rather than CSS variables: Recharts writes these into SVG attributes.
const PAY = "#b5761f";
const AXIS = "#6b6552";
const GRID = "#e3dcc6";
// Everything already lived. One flat wash — the single cue saying which half of the axis is
// which, and deliberately not a second colour competing with the pay line.
const PAST = "#000000";
const NOW = "#1f3a2e";

interface PayChartProps {
  readonly path: JobPayPath;
  readonly birthYear: number;
  /** The owner's retirement age — where the axis stops, and where an open-ended job does. */
  readonly retirementAge: number;
  readonly label: string;
  /** Seed a pay change at the clicked age. */
  readonly onPickAge: (age: number) => void;
}

export function PayChart({ path, birthYear, retirementAge, label, onPickAge }: PayChartProps) {
  const currentAge = ownerAgeAtMonth(birthYear, 0);
  const startAge = ownerAgeAtMonth(birthYear, path.span.startMonth);
  const endAge = ownerAgeAtMonth(birthYear, path.span.endMonthExclusive);

  // A whole life, from birth to retirement. Ages, not months: the whole panel dates in the
  // owner's age and the axis must not be the one exception.
  //
  // Starting at 0 rather than snugly around the job costs a flat stretch before anyone works,
  // but it buys a FIXED axis: every job on the panel is drawn against the same lifetime, so
  // two jobs' spans and pay are read against each other by looking, instead of each being
  // auto-scaled to itself and silently lying about how they compare.
  const minAge = 0;
  const maxAge = Math.max(endAge, currentAge, retirementAge) + 2;

  // Sampled per age-year, the resolution the form authors in — every date on this panel is a
  // whole age, so a change always lands on a sample and no step is drawn a year off.
  const rows = Array.from({ length: maxAge - minAge + 1 }, (_, i) => {
    const age = minAge + i;
    return { age, pay: path.monthlyCentsAt(monthAtOwnerAge(birthYear, age)) };
  });
  const peak = Math.max(...rows.map((r) => r.pay), 1);

  const reach = path.historyReachMonthlyCents;
  const step = path.monthZeroStepCents;
  const hasSeam = step !== 0 && reach !== null;

  return (
    <div
      className={styles.chart}
      role="img"
      aria-label={
        `Monthly pay across ${label}, from age ${startAge} to ${endAge}, ` +
        `topping out at ${formatDollars(peak)} a month` +
        (hasSeam
          ? `. At ${currentAge} it ${step > 0 ? "steps up" : "steps down"} ${formatDollars(Math.abs(step))} a month.`
          : ".")
      }
    >
      {/* Data mirror: Recharts draws nothing in jsdom, so the seam — the one fact this chart
          exists to state — is asserted here instead of off the SVG. */}
      <output data-testid="pay-chart-seam" hidden>
        {hasSeam ? step : 0}
      </output>

      <ResponsiveContainer width="100%" height={140}>
        <ComposedChart
          data={rows}
          margin={{ top: 14, right: 12, bottom: 4, left: 4 }}
          style={{ cursor: "crosshair" }}
          onClick={(state: { activeLabel?: string | number } | null) => {
            const age = Number(state?.activeLabel);
            if (Number.isFinite(age)) onPickAge(Math.round(age));
          }}
        >
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="age"
            type="number"
            domain={[minAge, maxAge]}
            allowDataOverflow
            // Birth, then the ages that mean something on THIS job. No evenly-spaced ruler:
            // the dates a user authors here are the job's own, not round decades.
            ticks={[...new Set([minAge, startAge, currentAge, endAge])].filter(
              (a) => a >= minAge && a <= maxAge,
            )}
            tickFormatter={(age: number) => String(age)}
            tick={{ fill: AXIS, fontSize: 11 }}
            stroke={GRID}
          />
          <YAxis
            width={64}
            tickFormatter={formatDollars}
            tick={{ fill: AXIS, fontSize: 11 }}
            stroke={GRID}
          />
          <Tooltip
            formatter={(value) => [`${formatDollars(Number(value))}/mo`, "Pay"]}
            labelFormatter={(age) => `Age ${age}`}
            contentStyle={{ fontSize: 12 }}
          />

          {/* Everything already lived, shaded once. */}
          <ReferenceArea x1={minAge} x2={currentAge} fill={PAST} fillOpacity={0.045} />

          <Area
            // Flat between changes, stepping at the age a change takes effect — never a slope.
            type="stepAfter"
            dataKey="pay"
            name="Pay"
            stroke={PAY}
            strokeWidth={2}
            fill={PAY}
            fillOpacity={0.14}
            dot={false}
            isAnimationActive={false}
          />

          <ReferenceLine
            x={currentAge}
            stroke={NOW}
            strokeWidth={1.5}
            label={{ value: `now · ${currentAge}`, position: "top", fill: AXIS, fontSize: 11 }}
          />

          {/* The seam, named where it happens rather than only in prose underneath. NEUTRAL:
              a cut is as legitimate as a raise, so this is drawn in the pay colour and never
              as a warning — the engine keeps this gap open on purpose. */}
          {hasSeam && (
            <>
              <ReferenceDot x={currentAge} y={reach} r={2.5} fill={PAY} stroke="none" />
              <ReferenceDot
                x={currentAge}
                y={reach + step}
                r={3}
                fill={PAY}
                stroke="none"
                label={{
                  value: `${step > 0 ? "+" : "−"}${formatDollars(Math.abs(step))}/mo`,
                  // Above the step, not beside it: `right` lays the text along the pay line
                  // leaving "now", which is exactly where the line is flat and the two collide.
                  position: "top",
                  fill: PAY,
                  fontSize: 10,
                }}
              />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
