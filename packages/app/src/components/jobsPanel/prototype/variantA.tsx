/**
 * PROTOTYPE — Variant A: "Pay history section".
 *
 * The job form grows a second salary anchor and absorbs the pay-change list, so a job's pay
 * reads as one story in age order: started at X, these things happened, now it's Y, these
 * things will happen. There is no separate historical surface and no month anywhere — the
 * sign of the month falls out of whether the age you typed is below your current age.
 *
 * What this variant is asking: does folding history into the job form make the month-0 seam
 * legible, or does it just make the form long?
 */

import { useState } from "react";
import { NumInput } from "../../numInput/numInput";
import {
  RETIREMENT_AGE,
  money,
  monthZeroStepDollars,
  withChange,
  withoutChange,
  type ProtoJob,
} from "./model";
import { PayTimeline, ProtoPayChangeForm } from "./shared";
import styles from "./proto.module.css";

export function VariantA({
  job,
  setJob,
}: {
  job: ProtoJob;
  setJob: (job: ProtoJob) => void;
}) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const step = monthZeroStepDollars(job);

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
        <div className={styles.meta}>from age {job.startAge} · open-ended (to retirement)</div>
        <div className={styles.actions}>
          <button type="button" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Edit"}
          </button>
          <button type="button">Delete</button>
        </div>

        {open && (
          <div className={styles.form}>
            <label className="field">
              <span className="field-label">Job name (optional)</span>
              <span className="field-input-wrap">
                <input
                  type="text"
                  value={job.name}
                  onChange={(e) => setJob({ ...job, name: e.target.value })}
                />
              </span>
            </label>

            <NumInput
              label="Start age"
              value={job.startAge}
              onChange={(startAge) => setJob({ ...job, startAge })}
              min={14}
              max={100}
              step={1}
            />

            {/* The two anchors, side by side and labelled by WHEN rather than by which engine
                field they land in. Neither derives from the other; the form never back-solves
                one from the other, which is the thing the handoff explicitly rejected. */}
            <p className={styles.sectionLabel}>Monthly salary</p>
            <NumInput
              label={`When it started (age ${job.startAge})`}
              value={job.startingMonthlyDollars}
              onChange={(startingMonthlyDollars) => setJob({ ...job, startingMonthlyDollars })}
              prefix="$"
              step={1}
              min={0}
            />
            <NumInput
              label={`Now (age ${job.currentAge})`}
              value={job.currentMonthlyDollars}
              onChange={(currentMonthlyDollars) => setJob({ ...job, currentMonthlyDollars })}
              prefix="$"
              step={1}
              min={0}
            />
            <p className="hint">
              What you earned when you started seeds your Social-Security-covered years. What
              you earn now is what the projection starts from.
            </p>

            {/* One list across the seam. Removing works on both sides; the "now" row is not
                removable because it is an anchor, not an event. */}
            <p className={styles.sectionLabel}>Pay history</p>
            <PayTimeline job={job} onRemove={(month) => setJob(withoutChange(job, month))} />

            {adding ? (
              <ProtoPayChangeForm
                job={job}
                title="Add a pay change"
                minAge={job.startAge}
                maxAge={(job.endAge ?? RETIREMENT_AGE) - 1}
                // Opens ON the seam, not past it. `currentAge + 1` read as a clamp: it biased
                // every new change toward the future and made the (correct) start-age floor
                // invisible. Opening at "now" makes the direction an explicit choice.
                defaultAge={job.currentAge}
                onSubmit={(change) => {
                  setJob(withChange(job, change));
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <div className={styles.formActions}>
                <button type="button" className="btn" onClick={() => setAdding(true)}>
                  + Add a pay change
                </button>
              </div>
            )}

            <div className={styles.formActions}>
              <button type="button" className="btn primary">
                Save
              </button>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="hint">
        {step === 0
          ? "History lands exactly on today’s pay."
          : `There is a ${money(Math.abs(step))}/mo step at "now" — the pay history and today's stated pay disagree, and today's pay wins. That is allowed, and intentional.`}
      </p>
    </>
  );
}
