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
 *
 * **Three things about this chart can only be checked by looking at it.** The mirrors let a test
 * assert every figure drawn here, and the suite does; what no assertion can have an opinion on
 * is whether the result is legible, because jsdom gives Recharts no width and so draws nothing
 * to be legible. Anyone changing the sampling, the spike, or the axis should open it and check:
 *
 * 1. **Does a one-month spike read at all?** A month is about a pixel on a ninety-year axis, so
 *    the rise is a hairline and the apex dot is doing most of the work. If a change makes the
 *    dot smaller, or drops it, the adjustment becomes invisible without any test noticing.
 * 2. **Does the y-axis grow to include a bonus above the pay line?** That is why the adjusted
 *    figure is in the DATA rather than a `ReferenceDot` — a mark outside the domain is silently
 *    clipped out of frame, and clipped looks identical to absent.
 * 3. **Does the tooltip say "this month" on an adjusted month, and "/mo" everywhere else?** The
 *    height there is a single payment; "/mo" would state it as a new salary.
 */

import { useId } from "react";
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
import {
  applyJobIncomeOverridesAt,
  payChangeEffectiveMonth,
  type JobIncomeOverride,
  type JobPayChange,
  type JobPayPath,
  type UncountedPaySpan,
} from "@finley/engine";
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
// Marks the apex of a one-month spike. The PAY colour on purpose: the spike is the pay series,
// and a second colour would say a bonus is a different kind of quantity when it is the same
// dollars in the same month. The mark is a pointer, not a category.
const ONE_OFF = PAY;

/** "Age 35" on a birthday, "Age 35 + 4 mo" between two — the tooltip's date, at month resolution. */
function ageLabel(birthYear: number, month: number): string {
  const age = ownerAgeAtMonth(birthYear, month);
  const into = month - monthAtOwnerAge(birthYear, age);
  return into === 0 ? `Age ${age}` : `Age ${age} + ${into} mo`;
}

/** One uncounted interval as the chart takes it: the engine's span, worded by the panel. */
export interface UncountedPaySpanNote extends UncountedPaySpan {
  /** The sentence for {@link UncountedPaySpan.reason}, with the owner named. */
  readonly note: string;
}

interface PayChartProps {
  readonly path: JobPayPath;
  /**
   * The stretches of the drawn span that are not this household's income, each with its own
   * sentence — empty for the ordinary job.
   *
   * Drawn as a hatch OVER the pay rather than by shortening the line, because the two facts are
   * different and the reader needs both: the person goes on holding the job (their schedule is
   * unchanged, and truncating it would say they stopped working) while the household stops
   * receiving it. A gap where the line simply ends cannot say the first of those.
   *
   * A LIST, and each interval carries its own end: a partner who joined at 45 and separated at
   * 55 leaves two gaps in one job, and neither of them runs to the edge of the chart.
   */
  readonly uncounted: readonly UncountedPaySpanNote[];
  /** Only to pin each change's own month as a sample — the VALUES all come from `path`. */
  readonly payChanges: readonly JobPayChange[];
  /**
   * One-month adjustments. Unlike {@link payChanges} these carry a value the path does not
   * hold: `jobPayPath` compiles standing pay, and a bonus is a payment rather than a salary
   * state. Folded into the drawn pay as a one-month spike — see the note on `rows` below.
   */
  readonly incomeOverrides: readonly JobIncomeOverride[];
  readonly birthYear: number;
  /** The plan's life expectancy — where the axis stops, whatever this job does. */
  readonly lifeExpectancy: number;
  readonly label: string;
  /** Names the denomination in the summary, so a reader is never guessing which dollars. */
  readonly inTodaysDollars: boolean;
  /** Seed a pay change at the clicked age. */
  readonly onPickAge: (age: number) => void;
}

export function PayChart({
  path,
  uncounted,
  payChanges,
  incomeOverrides,
  birthYear,
  lifeExpectancy,
  label,
  inTodaysDollars,
  onPickAge,
}: PayChartProps) {
  const currentAge = ownerAgeAtMonth(birthYear, 0);
  const startAge = ownerAgeAtMonth(birthYear, path.span.startMonth);
  const endAge = ownerAgeAtMonth(birthYear, path.span.endMonthExclusive);

  // A whole life. Starting at 0 rather than snugly around the job costs a flat stretch before
  // anyone works, but it buys a FIXED axis: every job on the panel is drawn against the same
  // lifetime, so two jobs' spans and pay are read against each other by looking, instead of
  // each being auto-scaled to itself and silently lying about how they compare. Life
  // expectancy, not retirement: the plan's own horizon, identical for every job and every
  // household member, so nothing about one job's span can move the axis under another's.
  const minAge = 0;
  const maxAge = Math.max(endAge, currentAge, lifeExpectancy);
  const firstMonth = monthAtOwnerAge(birthYear, minAge);
  const lastMonth = monthAtOwnerAge(birthYear, maxAge);

  /**
   * The x is a MONTH, labelled as an age. Sampling once per age-year would put a change up to
   * eleven months from where it happens — most visibly for one authored at the owner's current
   * age, which takes force at month 1 and would not appear until the next birthday. Pay is a
   * monthly quantity and the engine dates it in months; the axis has to be able to say so.
   *
   * But a lifetime is ~1,080 months and the plot is under 1,000px, so one row per month cannot
   * work: the tooltip snaps to the NEAREST row, and with more rows than pixels some of them are
   * never the nearest — month 0 among them, which made "now" the one month unreadable. Nothing
   * is lost by thinning, because pay is piecewise constant: within a flat stretch every month
   * carries the same figure.
   *
   * So: a quarterly backbone, plus every month that actually MEANS something — "now", the job's
   * ends, and the month each pay change takes force. Every vertex is exact and the staircase is
   * drawn identically, while each row keeps a band of a few pixels to itself.
   *
   * Deliberately NO neighbouring months (no −1 beside 0, no `end − 1` beside `end`). `stepAfter`
   * holds the previous sample's value right up to the next one, so the step already lands on the
   * exact month without help — and a sample packed against another one is worse than useless: it
   * squeezes BOTH into a sub-pixel band and makes the pair unreachable. That is what once made
   * "now" the one month the tooltip would not stop on.
   */
  const months = new Set<number>();
  for (let month = firstMonth; month <= lastMonth; month += 3) months.add(month);
  const keyMonths = [
    firstMonth,
    lastMonth,
    0, // "now" — the seam, and the whole reason this chart exists
    path.span.startMonth,
    path.span.endMonthExclusive,
    ...payChanges.map(payChangeEffectiveMonth),
    // A one-month adjustment needs BOTH its own month and the one after it. Its own, because
    // the quarterly backbone would miss two months in three; the one after, because
    // `stepAfter` holds a sample until the next one — without it the bonus would be drawn as
    // lasting a whole quarter. The pair is what makes the spike exactly one month wide. This
    // is the one place the "no neighbouring samples" rule above is deliberately broken, and
    // the cost it warns about (a sub-pixel band that is hard to hover) is what a one-month
    // event honestly is.
    ...incomeOverrides.flatMap((o) => [o.month, o.month + 1]),
  ];
  for (const month of keyMonths) {
    if (month >= firstMonth && month <= lastMonth) months.add(month);
  }
  /**
   * A one-month adjustment rides the pay series itself, so the shaded region briefly rises and
   * falls back — the same way a bonus reads on the household income charts, where a month that
   * pays more is simply drawn taller.
   *
   * The staircase can carry it because the sampling above pins the month AND its successor: the
   * spike is one month wide, which is a blip and not a raise-then-cut. What makes that safe is
   * the width, not a separate series — a bonus held for a quarter would be a lie about a rate,
   * and a bonus held for a month is the truth about a payment.
   *
   * `adjusted` rides along so the tooltip can say "this month" instead of "/mo" on exactly
   * those months: the height is a payment there, not a salary.
   *
   * Several adjustments may share a month. They are folded through the engine's own
   * {@link applyJobIncomeOverridesAt}, so the spike is drawn at what the projection pays rather
   * than at whichever one the chart happened to look at last.
   */
  const adjustedMonths = new Set(incomeOverrides.map((o) => o.month));
  const rows = [...months]
    .sort((a, b) => a - b)
    .map((month) => {
      const standing = path.monthlyCentsAt(month);
      return {
        month,
        // The whole stack, not one of them: a month may carry several adjustments, and the
        // engine folds them in order. Drawing only the last would understate a double bonus.
        pay: applyJobIncomeOverridesAt(standing, incomeOverrides, month),
        adjusted: adjustedMonths.has(month),
      };
    });
  const peak = Math.max(...rows.map((r) => r.pay), 1);
  /** Ages worth naming; both ends, plus whatever this job does. */
  const tickMonths = [...new Set([minAge, startAge, currentAge, endAge, maxAge])]
    .filter((age) => age >= minAge && age <= maxAge)
    .map((age) => monthAtOwnerAge(birthYear, age));

  const reach = path.historyReachMonthlyCents;
  const step = path.monthZeroStepCents;
  const hasSeam = step !== 0 && reach !== null;

  // Every job card on the panel draws its own hatch, and an SVG pattern is addressed by a
  // DOCUMENT-wide id — so two cards sharing one would have the second silently redefine the
  // first. `useId` is the only source of uniqueness that survives however many cards render;
  // the colons it produces are legal in an id but not in a `url(#…)` reference, so they go.
  const patternId = `pay-uncounted-${useId().replace(/:/g, "")}`;
  const keyPatternId = `${patternId}-key`;
  /** The hatch itself, defined once per svg that draws it — the chart and its legend swatch. */
  const hatch = (id: string) => (
    <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1={0} y1={0} x2={0} y2={6} stroke={PAY} strokeWidth={1.5} strokeOpacity={0.5} />
    </pattern>
  );

  return (
    <div
      className={styles.chart}
      role="img"
      aria-label={
        `Monthly pay across ${label}, from age ${startAge} to ${endAge}, ` +
        `in ${inTodaysDollars ? "today’s money" : "the paycheck of each month"}, ` +
        `topping out at ${formatDollars(peak)} a month` +
        (incomeOverrides.length > 0
          ? `. ${incomeOverrides.length} single ${incomeOverrides.length === 1 ? "month rises or falls on its own" : "months rise or fall on their own"} for a one-off adjustment`
          : "") +
        (hasSeam
          ? `. At ${currentAge} it ${step > 0 ? "steps up" : "steps down"} ${formatDollars(Math.abs(step))} a month.`
          : ".") +
        // The hatch is the only cue for this on the chart itself, and a hatch is invisible to a
        // screen reader — so every interval travels in the description too, in ages like
        // everything else here.
        uncounted
          .map(
            (u) =>
              ` From age ${ownerAgeAtMonth(birthYear, u.startMonth)} to ${ownerAgeAtMonth(birthYear, u.endMonthExclusive)} the pay is not household income.`,
          )
          .join("")
      }
    >
      {/* Data mirror: Recharts draws nothing in jsdom, so the seam — the one fact this chart
          exists to state — is asserted here instead of off the SVG. */}
      <output data-testid="pay-chart-seam" hidden>
        {hasSeam ? step : 0}
      </output>
      {/* Same reason: what the one-off marks are drawn AT, so a test can read the months and
          the totals rather than the SVG that jsdom never produces. */}
      <output data-testid="pay-chart-one-offs" hidden>
        {JSON.stringify(rows.filter((r) => r.adjusted).map((r) => [r.month, r.pay]))}
      </output>
      {/* And the same for the hatches: a `<pattern>` fill inside Recharts is nothing jsdom can
          be asked about, so each interval — with the engine's own reason code — is stated where
          a test can read it. */}
      <output data-testid="pay-chart-uncounted" hidden>
        {JSON.stringify(uncounted.map((u) => [u.startMonth, u.endMonthExclusive, u.reason]))}
      </output>

      <ResponsiveContainer width="100%" height={140}>
        <ComposedChart
          data={rows}
          margin={{ top: 14, right: 12, bottom: 4, left: 4 }}
          style={{ cursor: "pointer" }}
          // Clicks come back as a month and are handed on as an age, because an age is what
          // the pay-change form dates by.
          onClick={(state: { activeLabel?: string | number } | null) => {
            const month = Number(state?.activeLabel);
            if (Number.isFinite(month)) onPickAge(ownerAgeAtMonth(birthYear, month));
          }}
        >
          <defs>{hatch(patternId)}</defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="month"
            type="number"
            domain={[firstMonth, lastMonth]}
            allowDataOverflow
            // Birth and life expectancy, then the ages that mean something on THIS job. No
            // evenly-spaced ruler: the dates a user authors here are the job's own, not round
            // decades. Both ends are labelled, or the axis just trails off past the job's end.
            ticks={tickMonths}
            tickFormatter={(month: number) => String(ownerAgeAtMonth(birthYear, month))}
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
            // A rate everywhere except the months carrying a one-month adjustment, where the
            // height is a single payment and "/mo" would read it as a new salary.
            formatter={(value, _name, item: { payload?: { adjusted?: boolean } }) =>
              item?.payload?.adjusted === true
                ? [`${formatDollars(Number(value))} this month`, "Pay"]
                : [`${formatDollars(Number(value))}/mo`, "Pay"]
            }
            // Scrubbing is month-by-month, so the label has to be too: a bare "Age 35" would
            // read identically for twelve consecutive positions.
            labelFormatter={(month) => ageLabel(birthYear, Number(month))}
            contentStyle={{ fontSize: 12 }}
          />

          {/* Everything already lived, shaded once. Month 0 is exactly where "now" is. */}
          <ReferenceArea x1={firstMonth} x2={0} fill={PAST} fillOpacity={0.045} />

          <Area
            // Flat between changes, stepping at the MONTH a change takes effect — never a
            // slope, which would invent raises and smooth the month-0 jump away.
            type="stepAfter"
            dataKey="pay"
            name="Pay"
            stroke={PAY}
            strokeWidth={2}
            fill={PAY}
            fillOpacity={0.14}
            // No dots on the ordinary staircase — a vertex every quarter is noise. Only the
            // months carrying a one-month adjustment are marked, because a one-month spike is
            // about a pixel wide on a lifetime axis and would otherwise be easy to miss
            // entirely. The mark says "look here"; the spike itself says what happened.
            dot={(props: { cx?: number; cy?: number; index?: number; payload?: { adjusted?: boolean } }) =>
              props.payload?.adjusted === true && props.cx !== undefined && props.cy !== undefined ? (
                <circle key={props.index} cx={props.cx} cy={props.cy} r={3.5} fill={ONE_OFF} />
              ) : (
                // Recharts requires an element back from every row; an empty group is how a
                // row declines to draw one.
                <g key={props.index} />
              )
            }
            isAnimationActive={false}
          />

          {/* After the pay area, so it reads as something laid OVER the pay rather than
              underneath it — the pay is still drawn, and still the owner's, and this says what
              the household does with it. The full height on purpose: the claim is about the
              whole stretch of time, not about the dollars in it. */}
          {uncounted.map((u) => (
            <ReferenceArea
              key={`${u.startMonth}-${u.endMonthExclusive}`}
              x1={u.startMonth}
              x2={u.endMonthExclusive}
              fill={`url(#${patternId})`}
              fillOpacity={1}
              stroke="none"
            />
          ))}

          <ReferenceLine
            x={0}
            stroke={NOW}
            strokeWidth={1.5}
            label={{ value: `now · ${currentAge}`, position: "top", fill: AXIS, fontSize: 11 }}
          />

          {/* The seam, named where it happens rather than only in prose underneath. NEUTRAL:
              a cut is as legitimate as a raise, so this is drawn in the pay colour and never
              as a warning — the engine keeps this gap open on purpose. */}
          {hasSeam && (
            <>
              <ReferenceDot x={0} y={reach} r={2.5} fill={PAY} stroke="none" />
              <ReferenceDot
                x={0}
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

      {/* The key. A hatch that nothing names is a texture, not a statement — and the one thing
          this pattern has to convey (that the pay is real and is not the household's) is exactly
          what a reader cannot infer from a texture. Outside Recharts, so it renders wherever the
          chart does not: jsdom, and any width too narrow for the plot. */}
      {uncounted.map((u) => (
        <p className={styles.chartKey} key={`${u.startMonth}-${u.endMonthExclusive}`}>
          <svg width={16} height={11} aria-hidden="true" focusable="false">
            <defs>{hatch(keyPatternId)}</defs>
            <rect width={16} height={11} fill={`url(#${keyPatternId})`} stroke={GRID} />
          </svg>
          {u.note}
        </p>
      ))}
    </div>
  );
}
