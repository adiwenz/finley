/**
 * PROTOTYPE — Variant E: A's editor under D's lifetime graph.
 *
 * A proved the *editor*: two anchors labelled by when, and one age-ordered pay list that runs
 * straight through "now" instead of stopping at it. D proved the *axis*: a whole working life
 * on one age line, with jobs that already ended drawn as what they are.
 *
 * Putting them together buys something neither had on its own. A could only *describe* the
 * month-0 step in prose ("history reaches $6,250; you've stated $6,667"). Charting the job's
 * own pay draws it — a literal vertical jump at "now", annotated in place. The seam stops being
 * a sentence the user has to parse and becomes a shape they can see.
 *
 * Carried over from D deliberately: the income area. NOT carried over: the net-worth line. D's
 * finding was that co-plotting a stock over the historical span makes the honest chart look
 * broken — the empty space left of "now" reads as a missing feature rather than as the rule.
 * Income is a flow; drawing earnings you actually had is honest. That distinction is the whole
 * reason this variant charts pay and nothing else.
 */

import { useState } from "react";
import { NumInput } from "../../numInput/numInput";
import {
  LIFE_EXPECTANCY,
  RETIREMENT_AGE,
  historyReachesDollars,
  householdIncomeAtAge,
  money,
  monthlyPayAtAge,
  monthZeroStepDollars,
  withChange,
  withoutChange,
  type ProtoJob,
} from "./model";
import { PayTimeline, ProtoPayChangeForm } from "./shared";
import styles from "./proto.module.css";

const W = 660;
const H = 168;
const PAD_L = 52;
const PAD_B = 22;
const MIN_AGE = 0;

export function VariantE({
  jobs,
  setJobs,
}: {
  jobs: readonly ProtoJob[];
  setJobs: (jobs: readonly ProtoJob[]) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const [draftAge, setDraftAge] = useState<number | null>(null);

  const job = jobs[selectedIndex];

  /**
   * Write a job back, keeping an ended job's dead current-pay anchor pinned to what it was
   * paying when it ended.
   *
   * The engine never reads `currentSalaryCents` for a job whose span is wholly past —
   * `compileJobIncome` returns null before the anchor is touched — so this value is inert and
   * the choice is free. It is pinned rather than zeroed because zero is a lie with a delayed
   * cost: push the end age past "now" (you went back, or the age was a typo) and a zeroed job
   * silently pays nothing forward, while a mirrored one continues at its last known pay.
   */
  const patch = (next: ProtoJob) => {
    const over = (next.endAge ?? RETIREMENT_AGE) <= next.currentAge;
    const settled = over
      ? { ...next, currentMonthlyDollars: historyReachesDollars(next) }
      : next;
    setJobs(jobs.map((j, i) => (i === selectedIndex ? settled : j)));
  };

  const currentAge = job.currentAge;
  const step = monthZeroStepDollars(job);
  const ages = Array.from({ length: LIFE_EXPECTANCY - MIN_AGE + 1 }, (_, i) => MIN_AGE + i);

  // One scale for both series, so the job's own pay reads against the household's total.
  const maxAnnual = Math.max(
    ...ages.map((a) => householdIncomeAtAge(jobs, a)),
    ...ages.map((a) => monthlyPayAtAge(job, a) * 12),
    1,
  );

  const x = (age: number) =>
    PAD_L + ((age - MIN_AGE) / (LIFE_EXPECTANCY - MIN_AGE)) * (W - PAD_L - 10);
  const y = (annual: number) => H - PAD_B - (annual / maxAnnual) * (H - PAD_B - 16);
  const nowX = x(currentAge);

  const jobEnd = job.endAge ?? RETIREMENT_AGE;
  const spanAges = ages.filter((a) => a >= job.startAge && a <= jobEnd);
  /**
   * This job was over before month 0. Its current-pay anchor is meaningless — there is no
   * "today's pay" for a job that ended — so the editor doesn't ask for one and the chart draws
   * no seam. The engine still requires `currentSalaryCents` on every job; for an ended job it
   * is dead weight the UI should fill in rather than interrogate the user about.
   */
  const ended = jobEnd <= currentAge;

  /**
   * The selected job's pay as a staircase. Pay is flat between changes, so a straight
   * interpolation would invent raises that never happened — and, more to the point, would
   * smooth the month-0 jump into a slope instead of showing it as the discontinuity it is.
   */
  const stepPath = (): string => {
    if (spanAges.length === 0) return "";
    const v = (a: number) => monthlyPayAtAge(job, a) * 12;
    let d = `M${x(spanAges[0])},${y(v(spanAges[0]))}`;
    for (let i = 1; i < spanAges.length; i++) {
      const a = spanAges[i];
      d += ` L${x(a)},${y(v(spanAges[i - 1]))} L${x(a)},${y(v(a))}`;
    }
    return d;
  };

  const householdArea = (from: number, to: number) => {
    const pts = ages.filter((a) => a >= from && a <= to);
    if (pts.length === 0) return "";
    const top = pts.map((a) => `${x(a)},${y(householdIncomeAtAge(jobs, a))}`).join(" L");
    return `M${x(pts[0])},${H - PAD_B} L${top} L${x(pts[pts.length - 1])},${H - PAD_B} Z`;
  };

  const historyAnnual = historyReachesDollars(job) * 12;
  const currentAnnual = job.currentMonthlyDollars * 12;

  return (
    <>
      <h2>Jobs &amp; income — your working life</h2>
      <p className="hint">
        Every job on one age line. Click an age to add a pay change there — before or after
        today.
      </p>

      <svg width={W} height={H} role="img" aria-label="Pay across your working life">
        {/* Everything before today, shaded once. */}
        <rect x={PAD_L} y={0} width={nowX - PAD_L} height={H - PAD_B} fill="rgba(0,0,0,0.045)" />

        {/* Household earned income, as context behind the job being edited. */}
        <path d={householdArea(MIN_AGE, currentAge)} fill="var(--color-accent)" opacity={0.16} />
        <path d={householdArea(currentAge, LIFE_EXPECTANCY)} fill="var(--color-accent)" opacity={0.3} />

        {/* The selected job's pay. The vertical at `now` IS the month-0 step. */}
        <path d={stepPath()} fill="none" stroke="#2f6f4f" strokeWidth={2} />

        {/* Name the step where it happens, rather than only in prose underneath. An ended job
            has no seam: it never reaches month 0. */}
        {step !== 0 && !ended && (
          <>
            <circle cx={nowX} cy={y(historyAnnual)} r={3} fill="#2f6f4f" opacity={0.5} />
            <circle cx={nowX} cy={y(currentAnnual)} r={3.5} fill="#2f6f4f" />
            <text
              x={nowX + 6}
              y={(y(historyAnnual) + y(currentAnnual)) / 2 + 4}
              fontSize={11}
              fill="#2f6f4f"
            >
              {step > 0 ? "+" : "−"}
              {money(Math.abs(step))}/mo
            </text>
          </>
        )}

        {/* Pay changes as handles on the line. */}
        {job.payChanges.map((c) => {
          const age = currentAge + Math.floor(c.month / 12);
          if (age < job.startAge || age > jobEnd) return null;
          return (
            <circle
              key={c.month}
              cx={x(age)}
              cy={y(monthlyPayAtAge(job, age) * 12)}
              r={4}
              fill="var(--color-white)"
              stroke="#2f6f4f"
              strokeWidth={2}
            />
          );
        })}

        <line x1={nowX} y1={0} x2={nowX} y2={H - PAD_B} stroke="var(--color-accent)" strokeWidth={2} />
        <text x={nowX + 4} y={12} fontSize={11} fill="var(--color-accent)">
          now · {currentAge}
        </text>
        <line
          x1={x(RETIREMENT_AGE)}
          y1={0}
          x2={x(RETIREMENT_AGE)}
          y2={H - PAD_B}
          stroke="var(--color-border)"
          strokeDasharray="3 3"
        />
        <text x={x(RETIREMENT_AGE) + 4} y={12} fontSize={11} fill="var(--color-text-muted)">
          retire
        </text>

        <line x1={PAD_L} y1={H - PAD_B} x2={W - 10} y2={H - PAD_B} stroke="var(--color-border)" />
        {[0, 20, 40, 60, 80].map((age) => (
          <text
            key={age}
            x={x(age)}
            y={H - 6}
            fontSize={11}
            fill="var(--color-text-muted)"
            textAnchor="middle"
          >
            {age}
          </text>
        ))}
        <text x={4} y={16} fontSize={11} fill="var(--color-text-muted)">
          {money(maxAnnual)}/yr
        </text>

        {/* Click an age to seed the pay-change form. The chart is an input, not just a picture
            — and because the axis is age, clicking left of "now" is an ordinary act. */}
        <rect
          x={PAD_L}
          y={0}
          width={W - PAD_L - 10}
          height={H - PAD_B}
          fill="transparent"
          style={{ cursor: "crosshair" }}
          onClick={(e) => {
            const box = (e.target as SVGRectElement).getBoundingClientRect();
            const frac = (e.clientX - box.left) / box.width;
            const age = Math.round(MIN_AGE + frac * (LIFE_EXPECTANCY - MIN_AGE));
            setDraftAge(Math.min(Math.max(age, job.startAge), jobEnd));
            setAdding(true);
          }}
        />
        {draftAge !== null && (
          <line
            x1={x(draftAge)}
            y1={0}
            x2={x(draftAge)}
            y2={H - PAD_B}
            stroke="#888"
            strokeDasharray="2 2"
          />
        )}
      </svg>

      {/* Job picker — jobs that already ended included, drawn as spans. */}
      <ul className={styles.timeline}>
        {jobs.map((j, i) => (
          <li
            key={j.name}
            className={styles.entry}
            style={{ cursor: "pointer", opacity: i === selectedIndex ? 1 : 0.6 }}
            onClick={() => {
              setSelectedIndex(i);
              setAdding(false);
              setDraftAge(null);
            }}
          >
            <span className={styles.entryAge}>
              {j.startAge}–{j.endAge ?? RETIREMENT_AGE}
            </span>
            <span style={{ fontWeight: i === selectedIndex ? 600 : 400 }}>{j.name}</span>
            {/* A job that already ended has no "now" pay — saying so is the whole point of
                putting past jobs on the list in the first place. */}
            <span className={styles.entryPay}>
              {(j.endAge ?? RETIREMENT_AGE) <= j.currentAge
                ? `ended at ${j.endAge}`
                : `${money(j.currentMonthlyDollars)}/mo now`}
            </span>
            <span />
          </li>
        ))}
      </ul>

      {/* ---- A's editor, unchanged in substance ---- */}
      <div className={styles.form}>
        <p className={styles.sectionLabel}>Monthly salary</p>
        <NumInput
          label={`When it started (age ${job.startAge})`}
          value={job.startingMonthlyDollars}
          onChange={(startingMonthlyDollars) => patch({ ...job, startingMonthlyDollars })}
          prefix="$"
          step={1}
          min={0}
        />
        {ended ? (
          <p className="hint">
            This job ended at age {job.endAge}, so it has no pay “now”. Everything it paid feeds
            your Social-Security-covered years and nothing else.
          </p>
        ) : (
          <>
            <NumInput
              label={`Now (age ${job.currentAge})`}
              value={job.currentMonthlyDollars}
              onChange={(currentMonthlyDollars) => patch({ ...job, currentMonthlyDollars })}
              prefix="$"
              step={1}
              min={0}
            />
            <p className="hint">
              What you earned when you started seeds your Social-Security-covered years. What you
              earn now is what the projection starts from.
            </p>
          </>
        )}

        <p className={styles.sectionLabel}>Pay history</p>
        <PayTimeline
          job={job}
          ended={ended}
          onRemove={(month) => patch(withoutChange(job, month))}
        />

        {adding ? (
          <ProtoPayChangeForm
            job={job}
            title="Add a pay change"
            minAge={job.startAge}
            // `jobEnd` is the first age the job no longer pays, so the last authorable age is
            // one below it.
            maxAge={jobEnd - 1}
            defaultAge={draftAge ?? job.currentAge}
            onSubmit={(change) => {
              patch(withChange(job, change));
              setAdding(false);
              setDraftAge(null);
            }}
            onCancel={() => {
              setAdding(false);
              setDraftAge(null);
            }}
          />
        ) : (
          <div className={styles.formActions}>
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              + Add a pay change
            </button>
          </div>
        )}
      </div>

      {!ended && (
        <p className="hint">
          {step === 0
            ? "History lands exactly on today’s pay — the line is continuous at “now”."
            : `The jump at “now” is the ${money(Math.abs(step))}/mo step: your pay history and today’s stated pay disagree, and today’s pay wins. That is allowed, and intentional.`}
        </p>
      )}
      <p className="hint">
        There is no net-worth line on this chart, on purpose. Earnings are a flow and drawing
        them across your past is honest; a balance is a stock, and drawing one over a period the
        app never simulated would imply an accumulation that isn’t there.
      </p>
    </>
  );
}
