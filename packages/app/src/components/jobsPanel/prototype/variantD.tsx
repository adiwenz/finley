/**
 * PROTOTYPE — Variant D: "Lifetime job editor".
 *
 * One age axis from 0 to life expectancy. Every job is a bar on it, including jobs that ended
 * before now. Earned income is drawn under the bars across the WHOLE span, history included,
 * and you author a pay change by clicking an age — so there is no "can't go before month 0"
 * anywhere, because there is no month 0 in the UI at all.
 *
 * The question this variant exists to answer is NOT "is a lifetime axis nice" — it obviously
 * is. It is: **does drawing pre-now income make people expect that income to have accumulated
 * into net worth?** The app's rule is that historical data feeds Social-Security-covered
 * earnings and nothing else; today's balances are authored, not derived from a past you never
 * entered. So this variant deliberately renders the tempting thing — a shaded income region
 * over the past, and a running "earned so far" total — and puts the net-worth line beside it,
 * which is *absent* before now. Toggle `Show net worth` and watch the gap.
 *
 * If the gap reads as a missing feature rather than as a rule, this variant is the wrong idea
 * however good the axis feels.
 */

import { useState } from "react";
import { NumInput } from "../../numInput/numInput";
import {
  LIFE_EXPECTANCY,
  RETIREMENT_AGE,
  householdIncomeAtAge,
  money,
  monthOfAge,
  monthlyPayAtAge,
  withChange,
  withoutChange,
  sortedChanges,
  ageOfMonth,
  describeChange,
  type ProtoJob,
} from "./model";
import styles from "./proto.module.css";

const W = 660;
const H = 150;
const PAD_L = 44;
const PAD_B = 22;
const MIN_AGE = 0;

export function VariantD({
  jobs,
  setJobs,
}: {
  jobs: readonly ProtoJob[];
  setJobs: (jobs: readonly ProtoJob[]) => void;
}) {
  const currentAge = jobs[0]?.currentAge ?? 41;
  const [selectedAge, setSelectedAge] = useState<number>(currentAge);
  const [selectedJob, setSelectedJob] = useState(0);
  const [showNetWorth, setShowNetWorth] = useState(false);
  const [honest, setHonest] = useState(true);

  const ages = Array.from({ length: LIFE_EXPECTANCY - MIN_AGE + 1 }, (_, i) => MIN_AGE + i);
  const incomes = ages.map((age) => householdIncomeAtAge(jobs, age));
  const maxIncome = Math.max(...incomes, 1);

  const x = (age: number) => PAD_L + ((age - MIN_AGE) / (LIFE_EXPECTANCY - MIN_AGE)) * (W - PAD_L - 8);
  const y = (income: number) => H - PAD_B - (income / maxIncome) * (H - PAD_B - 10);

  const nowX = x(currentAge);

  // Total earned before now. The single most dangerous number on this screen: it is a flow,
  // and it renders like a stock.
  const earnedSoFar = ages
    .filter((age) => age < currentAge)
    .reduce((sum, age) => sum + householdIncomeAtAge(jobs, age), 0);

  const job = jobs[selectedJob];
  const patch = (next: ProtoJob) =>
    setJobs(jobs.map((j, i) => (i === selectedJob ? next : j)));

  const areaPath = (from: number, to: number) => {
    const pts = ages.filter((a) => a >= from && a <= to);
    if (pts.length === 0) return "";
    const top = pts.map((a) => `${x(a)},${y(householdIncomeAtAge(jobs, a))}`).join(" L");
    return `M${x(pts[0])},${H - PAD_B} L${top} L${x(pts[pts.length - 1])},${H - PAD_B} Z`;
  };

  return (
    <>
      <h2>Jobs &amp; income — your working life</h2>
      <p className="hint">
        Every job you’ve had and expect to have, on one age line. Click an age to add a pay
        change there.
      </p>

      <svg width={W} height={H} role="img" aria-label="Lifetime earned income by age">
        {/* History is shaded — the visual claim under test. */}
        <rect x={PAD_L} y={0} width={nowX - PAD_L} height={H - PAD_B} fill="rgba(0,0,0,0.045)" />
        <path d={areaPath(MIN_AGE, currentAge)} fill="var(--color-accent)" opacity={0.28} />
        <path d={areaPath(currentAge, LIFE_EXPECTANCY)} fill="var(--color-accent)" opacity={0.55} />

        {/* Net worth: authored at "now", and simply does not exist to the left of it. */}
        {showNetWorth && (
          <>
            <path
              d={ages
                .filter((a) => a >= currentAge)
                .map((a, i) => {
                  const grown = 120000 * Math.pow(1.06, a - currentAge);
                  const capped = Math.min(grown, maxIncome * 8);
                  return `${i === 0 ? "M" : "L"}${x(a)},${H - PAD_B - (capped / (maxIncome * 8)) * (H - PAD_B - 10)}`;
                })
                .join(" ")}
              fill="none"
              stroke="#2f6f4f"
              strokeWidth={2}
            />
            {!honest && (
              /* The tempting lie: back-fill net worth from past earnings. Shown dashed so it
                 is obvious this is the thing we must NOT ship. */
              <path
                d={ages
                  .filter((a) => a < currentAge)
                  .map((a, i) => {
                    const acc = ages
                      .filter((b) => b <= a)
                      .reduce((s, b) => s + householdIncomeAtAge(jobs, b) * 0.15, 0);
                    return `${i === 0 ? "M" : "L"}${x(a)},${H - PAD_B - (Math.min(acc, maxIncome * 8) / (maxIncome * 8)) * (H - PAD_B - 10)}`;
                  })
                  .join(" ")}
                fill="none"
                stroke="#2f6f4f"
                strokeWidth={2}
                strokeDasharray="4 3"
                opacity={0.6}
              />
            )}
          </>
        )}

        {/* "Now" — the only line on this chart that is a rule rather than a datum. */}
        <line x1={nowX} y1={0} x2={nowX} y2={H - PAD_B} stroke="var(--color-accent)" strokeWidth={2} />
        <text x={nowX + 4} y={12} fontSize={11} fill="var(--color-accent)">
          now · {currentAge}
        </text>
        <line x1={x(RETIREMENT_AGE)} y1={0} x2={x(RETIREMENT_AGE)} y2={H - PAD_B} stroke="var(--color-border)" strokeDasharray="3 3" />
        <text x={x(RETIREMENT_AGE) + 4} y={12} fontSize={11} fill="var(--color-text-muted)">
          retire
        </text>

        <line x1={PAD_L} y1={H - PAD_B} x2={W - 8} y2={H - PAD_B} stroke="var(--color-border)" />
        {[0, 20, 40, 60, 80].map((age) => (
          <text key={age} x={x(age)} y={H - 6} fontSize={11} fill="var(--color-text-muted)" textAnchor="middle">
            {age}
          </text>
        ))}
        <text x={4} y={14} fontSize={11} fill="var(--color-text-muted)">
          {money(maxIncome)}/yr
        </text>

        {/* Click-to-select: an age, never a month. */}
        <rect
          x={PAD_L}
          y={0}
          width={W - PAD_L - 8}
          height={H - PAD_B}
          fill="transparent"
          style={{ cursor: "crosshair" }}
          onClick={(e) => {
            const box = (e.target as SVGRectElement).getBoundingClientRect();
            const frac = (e.clientX - box.left) / box.width;
            setSelectedAge(Math.round(MIN_AGE + frac * (LIFE_EXPECTANCY - MIN_AGE)));
          }}
        />
        <line x1={x(selectedAge)} y1={0} x2={x(selectedAge)} y2={H - PAD_B} stroke="#888" strokeDasharray="2 2" />
      </svg>

      {/* Job bars — including one that ended 15 years ago, which today's panel shows as a
          flat row with no sense that it is over. */}
      <ul className={styles.timeline}>
        {jobs.map((j, i) => (
          <li
            key={j.name}
            className={styles.entry}
            style={{ cursor: "pointer", opacity: i === selectedJob ? 1 : 0.7 }}
            onClick={() => setSelectedJob(i)}
          >
            <span className={styles.entryAge}>
              {j.startAge}–{j.endAge ?? RETIREMENT_AGE}
            </span>
            <span>
              <span style={{ fontWeight: i === selectedJob ? 600 : 400 }}>{j.name}</span>
              <span
                style={{
                  display: "block",
                  height: 6,
                  borderRadius: 3,
                  background: "var(--color-accent)",
                  opacity: (j.endAge ?? RETIREMENT_AGE) <= j.currentAge ? 0.35 : 0.7,
                  marginTop: 4,
                  marginLeft: `${((j.startAge - MIN_AGE) / (LIFE_EXPECTANCY - MIN_AGE)) * 100}%`,
                  width: `${(((j.endAge ?? RETIREMENT_AGE) - j.startAge) / (LIFE_EXPECTANCY - MIN_AGE)) * 100}%`,
                }}
              />
            </span>
            <span className={styles.entryPay}>
              {monthlyPayAtAge(j, selectedAge) > 0 ? `${money(monthlyPayAtAge(j, selectedAge))}/mo` : "—"}
            </span>
            <span />
          </li>
        ))}
      </ul>

      <div className={styles.form}>
        <p className={styles.sectionLabel}>
          {job.name} · age {selectedAge}
        </p>

        <NumInput
          label={`Salary when it started (age ${job.startAge})`}
          value={job.startingMonthlyDollars}
          onChange={(startingMonthlyDollars) => patch({ ...job, startingMonthlyDollars })}
          prefix="$"
          step={1}
          min={0}
        />
        <NumInput
          label={`Salary now (age ${job.currentAge})`}
          value={job.currentMonthlyDollars}
          onChange={(currentMonthlyDollars) => patch({ ...job, currentMonthlyDollars })}
          prefix="$"
          step={1}
          min={0}
        />

        <div className={styles.formActions}>
          <button
            type="button"
            className="btn"
            onClick={() =>
              patch(
                withChange(job, {
                  month: monthOfAge(job, selectedAge),
                  kind: "setTo",
                  dollars: monthlyPayAtAge(job, selectedAge) || job.currentMonthlyDollars,
                }),
              )
            }
          >
            + Pay change at age {selectedAge}
          </button>
        </div>

        <ul className={styles.timeline}>
          {sortedChanges(job).map((c) => (
            <li key={c.month} className={styles.entry}>
              <span className={styles.entryAge}>age {ageOfMonth(job, c.month)}</span>
              <span>{describeChange(c)}</span>
              <span className={styles.entryPay}>{c.month < 0 ? "past" : "future"}</span>
              <button type="button" onClick={() => patch(withoutChange(job, c.month))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* ---- the risk, made explicit ---- */}
      <p className={styles.sectionLabel}>Does this imply accumulation?</p>
      <div className={styles.row}>
        <div className={styles.head}>
          <span className={styles.name}>Earned before now</span>
          <span className={styles.salary}>{money(earnedSoFar)}</span>
        </div>
        <p className="hint">
          This is the number to be suspicious of. It is a <em>flow</em> — money that came in and
          mostly went back out — but it renders exactly like a <em>stock</em>. Nothing in the app
          turns it into net worth: your balances today are what you told us they are.
        </p>
        <label className={styles.check}>
          <input type="checkbox" checked={showNetWorth} onChange={(e) => setShowNetWorth(e.target.checked)} />
          <span>Show net worth on the chart</span>
        </label>
        {showNetWorth && (
          <label className={styles.check}>
            <input type="checkbox" checked={!honest} onChange={(e) => setHonest(!e.target.checked)} />
            <span>…and back-fill it from past earnings (the thing we must NOT ship)</span>
          </label>
        )}
        {showNetWorth && honest && (
          <p className="hint">
            Net worth starts at “now” and there is nothing to its left. Watch whether that empty
            space reads as <strong>a rule</strong> or as <strong>a missing feature</strong> — that
            is the whole verdict on this variant.
          </p>
        )}
        {showNetWorth && !honest && (
          <p className="hint">
            The dashed line is a lie: it assumes a savings rate you never stated and a market
            history that never happened. Once a user has seen it, the honest chart looks broken.
          </p>
        )}
      </div>
    </>
  );
}
