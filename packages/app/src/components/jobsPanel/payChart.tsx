/**
 * One job's pay across the owner's whole working life, on an age axis that runs straight
 * through "now".
 *
 * The chart exists to make the month-0 seam a **shape** rather than a sentence. Where the
 * reconstructed history lands at month −1 and the authored current salary disagree, the engine
 * keeps both and lets the current one win (see `SalaryTrajectory`); drawn, that is a literal
 * vertical jump at "now", annotated in place. Set the two anchors equal and the line goes
 * continuous and the annotation disappears — the chart teaches the rule instead of explaining
 * it.
 *
 * Two things about it are load-bearing:
 *
 * - **Pay is a staircase, never interpolated.** Pay is flat between changes, so a straight line
 *   between them invents raises that never happened — and, worse, smooths the month-0 jump into
 *   a slope, hiding the exact thing the chart is here to show.
 * - **There is no net-worth line, on purpose.** Income is a flow and drawing earnings you
 *   actually had across your past is honest; a balance is a stock, and drawing one over a span
 *   the app never simulated implies an accumulation that isn't there. Prototyped, and the
 *   failure mode was that the honest version (a line starting at "now", nothing to its left)
 *   reads as an unfinished chart rather than as the rule.
 *
 * The axis is also an input: clicking an age seeds a pay change there. That works precisely
 * *because* the axis is age — clicking left of "now" is an ordinary act needing no new
 * vocabulary, where a month picker would have to explain a negative number.
 */

import type { JobPayPath } from "@finley/engine";
import { formatDollars } from "../../format";
import { monthAtOwnerAge, ownerAgeAtMonth } from "../../planPeople";
import styles from "./jobsPanel.module.css";

const WIDTH = 560;
const HEIGHT = 132;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_BOTTOM = 18;
const PAD_TOP = 14;

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

  // A working life, wide enough to hold this job wherever it sits in one. Ages, not months:
  // the whole panel dates in the owner's age and the axis must not be the one exception.
  const minAge = Math.min(startAge, currentAge) - 2;
  const maxAge = Math.max(endAge, currentAge, retirementAge) + 2;

  // Sampled per age-year, the resolution the form authors in — every date on this panel is a
  // whole age, so a change always lands on a sample and no step is drawn a year off.
  const ages = Array.from({ length: maxAge - minAge + 1 }, (_, i) => minAge + i);
  const values = ages.map((age) => path.monthlyCentsAt(monthAtOwnerAge(birthYear, age)));
  const peak = Math.max(...values, 1);

  const x = (age: number) => PAD_LEFT + ((age - minAge) / (maxAge - minAge)) * (WIDTH - PAD_LEFT - PAD_RIGHT);
  const y = (cents: number) =>
    HEIGHT - PAD_BOTTOM - (cents / peak) * (HEIGHT - PAD_BOTTOM - PAD_TOP);
  const nowX = x(currentAge);
  const baseY = HEIGHT - PAD_BOTTOM;

  // The staircase: hold the previous year's pay across to this age, then step to the new one.
  let staircase = "";
  ages.forEach((age, i) => {
    const here = values[i];
    if (i === 0) {
      staircase = `M${x(age)},${y(here)}`;
      return;
    }
    staircase += ` L${x(age)},${y(values[i - 1])} L${x(age)},${y(here)}`;
  });

  const reach = path.historyReachMonthlyCents;
  const step = path.monthZeroStepCents;

  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`Monthly pay across ${label}, from age ${startAge} to ${endAge}, topping out at ${formatDollars(peak)} a month`}
    >
      {/* Everything already lived, shaded once — the one thing that says which half is which. */}
      <rect x={PAD_LEFT} y={0} width={Math.max(0, nowX - PAD_LEFT)} height={baseY} className={styles.chartPast} />

      <path d={`${staircase} L${x(maxAge)},${baseY} L${x(minAge)},${baseY} Z`} className={styles.chartArea} />
      <path d={staircase} className={styles.chartLine} />

      {/* The seam, named where it happens rather than only in prose underneath. Neutral: a cut
          is as legitimate as a raise, and this is not a problem to be fixed. */}
      {step !== 0 && reach !== null && (
        <g className={styles.chartStep}>
          <circle cx={nowX} cy={y(reach)} r={2.5} />
          <circle cx={nowX} cy={y(reach + step)} r={3} />
          <text x={nowX + 5} y={(y(reach) + y(reach + step)) / 2 + 4}>
            {step > 0 ? "+" : "−"}
            {formatDollars(Math.abs(step))}/mo
          </text>
        </g>
      )}

      <line x1={nowX} y1={0} x2={nowX} y2={baseY} className={styles.chartNow} />
      <text x={nowX + 4} y={10} className={styles.chartTick}>
        now · {currentAge}
      </text>
      <line x1={PAD_LEFT} y1={baseY} x2={WIDTH - PAD_RIGHT} y2={baseY} className={styles.chartAxis} />
      {[startAge, endAge].map((age, i) => (
        <text key={`${age}-${i}`} x={x(age)} y={HEIGHT - 5} textAnchor="middle" className={styles.chartTick}>
          {age}
        </text>
      ))}
      {/* The scale's top. Bare, without the "/mo" the headline carries — the two would
          otherwise read as the same statement made twice. */}
      <text x={PAD_LEFT} y={10} className={styles.chartTick}>
        {formatDollars(peak)}
      </text>

      {/* The axis as an input. Sits last so it takes the clicks. */}
      <rect
        x={PAD_LEFT}
        y={0}
        width={WIDTH - PAD_LEFT - PAD_RIGHT}
        height={baseY}
        className={styles.chartHit}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const fraction = (e.clientX - box.left) / box.width;
          onPickAge(Math.round(minAge + fraction * (maxAge - minAge)));
        }}
      />
    </svg>
  );
}
