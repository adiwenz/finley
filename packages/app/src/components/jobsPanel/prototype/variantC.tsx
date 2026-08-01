/**
 * PROTOTYPE — Variant C: "Separate Pay history editor".
 *
 * A third button on the job row opens a surface that owns everything BEFORE now: the start
 * salary anchor and the historical raises. The job form and the forward "Change pay" form are
 * untouched. The split mirrors the engine's own — negative months here, non-negative there.
 *
 * What this variant is asking: does mirroring the engine's split help the user, or does it
 * make them answer "is this raise before or after now?" as a NAVIGATION question, before they
 * can even find the right form?
 */

import { useState } from "react";
import { NumInput } from "../../numInput/numInput";
import {
  RETIREMENT_AGE,
  ageOfMonth,
  describeChange,
  money,
  monthZeroStepDollars,
  sortedChanges,
  withChange,
  withoutChange,
  type ProtoJob,
} from "./model";
import { PayTimeline, ProtoPayChangeForm } from "./shared";
import styles from "./proto.module.css";

type Surface = "none" | "history" | "forward";

export function VariantC({
  job,
  setJob,
}: {
  job: ProtoJob;
  setJob: (job: ProtoJob) => void;
}) {
  const [surface, setSurface] = useState<Surface>("history");
  const [adding, setAdding] = useState(false);
  const step = monthZeroStepDollars(job);

  const historical = sortedChanges(job).filter((c) => c.month < 0);
  const forward = sortedChanges(job).filter((c) => c.month >= 0);

  return (
    <>
      <h2>Jobs &amp; income</h2>
      <p className="hint">
        Earned income comes from your jobs — add as many as you like, and date a raise or a cut
        on any of them.
      </p>

      <div className={styles.row}>
        <div className={styles.head}>
          <span className={styles.name}>{job.name}</span>
          <span className={styles.salary}>{money(job.currentMonthlyDollars)}/mo now</span>
        </div>
        <div className={styles.meta}>
          from age {job.startAge} · open-ended (to retirement) · {historical.length} past,{" "}
          {forward.length} future pay change{forward.length === 1 ? "" : "s"}
        </div>

        <div className={styles.actions}>
          <button type="button">Edit</button>
          <button
            type="button"
            onClick={() => {
              setSurface((s) => (s === "history" ? "none" : "history"));
              setAdding(false);
            }}
          >
            Pay history
          </button>
          <button
            type="button"
            onClick={() => {
              setSurface((s) => (s === "forward" ? "none" : "forward"));
              setAdding(false);
            }}
          >
            Change pay
          </button>
          <button type="button">Delete</button>
        </div>

        {surface === "history" && (
          <div className={styles.form}>
            <p className={styles.sectionLabel}>Pay history — up to today</p>
            <p className="hint">
              What you actually earned on this job before now. This feeds your
              Social-Security-covered earnings; it does not change the projection, which starts
              from today’s pay.
            </p>

            <NumInput
              label={`Salary when it started (age ${job.startAge})`}
              value={job.startingMonthlyDollars}
              onChange={(startingMonthlyDollars) => setJob({ ...job, startingMonthlyDollars })}
              prefix="$"
              step={1}
              min={0}
            />

            <ul className={styles.timeline}>
              {historical.length === 0 && (
                <li className={styles.entry}>
                  <span className={styles.entryAge}>—</span>
                  <span className="hint">No past pay changes — pay held flat until today.</span>
                  <span />
                  <span />
                </li>
              )}
              {historical.map((change) => (
                <li key={change.month} className={`${styles.entry} ${styles.entryHistory}`}>
                  <span className={styles.entryAge}>age {ageOfMonth(job, change.month)}</span>
                  <span>{describeChange(change)}</span>
                  <span />
                  <button type="button" onClick={() => setJob(withoutChange(job, change.month))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>

            {adding ? (
              <ProtoPayChangeForm
                job={job}
                title="Add a past pay change"
                minAge={job.startAge}
                // This surface only authors history, so the age can't reach today — and it
                // can't outlive a job that already ended either.
                maxAge={Math.min((job.endAge ?? RETIREMENT_AGE) - 1, job.currentAge - 1)}
                defaultAge={Math.max(job.startAge, job.currentAge - 1)}
                onSubmit={(change) => {
                  setJob(withChange(job, { ...change, month: Math.min(-12, change.month) }));
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <div className={styles.formActions}>
                <button type="button" className="btn" onClick={() => setAdding(true)}>
                  + Add a past pay change
                </button>
              </div>
            )}

            <p className="hint">
              {step === 0
                ? `History reaches ${money(job.currentMonthlyDollars)}/mo — exactly today’s pay.`
                : `History reaches ${money(job.currentMonthlyDollars - step)}/mo. Today’s pay is stated separately as ${money(job.currentMonthlyDollars)}/mo, and that is what the projection uses.`}
            </p>
          </div>
        )}

        {surface === "forward" && (
          <ProtoPayChangeForm
            job={job}
            title="Pay change"
            // Untouched from today's app: forward only.
            minAge={job.currentAge}
            maxAge={(job.endAge ?? RETIREMENT_AGE) - 1}
            defaultAge={job.currentAge + 1}
            onSubmit={(change) => {
              setJob(withChange(job, change));
              setSurface("none");
            }}
            onCancel={() => setSurface("none")}
          />
        )}
      </div>

      <p className={styles.sectionLabel}>For comparison — the whole story in one list</p>
      <p className="hint">
        This is what variant A shows inline. Variant C never renders it to the user; it is here
        so you can see what the split surfaces are hiding.
      </p>
      <PayTimeline job={job} />
    </>
  );
}
