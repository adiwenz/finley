/**
 * PROTOTYPE — Variant B: "Minimal unblock".
 *
 * Nothing moves. The start-salary anchor goes into the job form's existing Advanced details,
 * next to 401(k) and raises, and the existing "Change pay" form's age floor drops from the
 * owner's current age to the job's start age. Pay changes stay listed on the job row exactly
 * as they are today.
 *
 * What this variant is asking: is the cheap version actually usable, or does a start salary
 * hidden behind a disclosure — disconnected from the pay-change list in a different disclosure
 * — leave the user with no idea the two combine?
 */

import { useState } from "react";
import { NumInput } from "../../numInput/numInput";
import {
  RETIREMENT_AGE,
  ageOfMonth,
  describeChange,
  money,
  sortedChanges,
  withChange,
  withoutChange,
  type ProtoJob,
} from "./model";
import { ProtoPayChangeForm } from "./shared";
import styles from "./proto.module.css";

export function VariantB({
  job,
  setJob,
}: {
  job: ProtoJob;
  setJob: (job: ProtoJob) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [changingPay, setChangingPay] = useState(false);

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

        {/* The list as it exists today — flat prose lines, no sense of a seam. History and
            future changes are indistinguishable here beyond the age you have to compare
            yourself against your own current age. */}
        <ul className={styles.timeline}>
          {sortedChanges(job).map((change) => (
            <li key={change.month} className={styles.entry}>
              <span className={styles.entryAge}>age {ageOfMonth(job, change.month)}</span>
              <span>{describeChange(change)}</span>
              <span />
              <button type="button" onClick={() => setJob(withoutChange(job, change.month))}>
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className={styles.actions}>
          <button type="button" onClick={() => setEditing((e) => !e)}>
            Edit
          </button>
          <button type="button" onClick={() => setChangingPay((c) => !c)}>
            Change pay
          </button>
          <button type="button">Delete</button>
        </div>

        {changingPay && (
          <ProtoPayChangeForm
            job={job}
            title="Pay change"
            // The one-line change that unblocks history: was `min={currentAge}`.
            minAge={job.startAge}
            maxAge={(job.endAge ?? RETIREMENT_AGE) - 1}
            defaultAge={job.currentAge + 1}
            onSubmit={(change) => {
              setJob(withChange(job, change));
              setChangingPay(false);
            }}
            onCancel={() => setChangingPay(false)}
          />
        )}

        {editing && (
          <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
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
              label="Monthly salary"
              value={job.currentMonthlyDollars}
              onChange={(currentMonthlyDollars) => setJob({ ...job, currentMonthlyDollars })}
              prefix="$"
              step={1}
              min={0}
            />
            <NumInput
              label="Start age"
              value={job.startAge}
              onChange={(startAge) => setJob({ ...job, startAge })}
              min={14}
              max={100}
              step={1}
            />
            <label className="field field-check">
              <input type="checkbox" checked readOnly />
              <span className="field-label">Open-ended (runs until retirement)</span>
            </label>

            <details className="advanced">
              <summary>Advanced</summary>
              {/* The whole historical half of the feature, behind a disclosure, three fields
                  down from anything that mentions it. This is the variant's weak point and
                  the reason to look at it in a browser rather than argue about it. */}
              <NumInput
                label="Salary when this job started"
                value={job.startingMonthlyDollars}
                onChange={(startingMonthlyDollars) => setJob({ ...job, startingMonthlyDollars })}
                prefix="$"
                step={1}
                min={0}
              />
              <p className="hint">
                Used for your Social-Security-covered years only. Leave it equal to your
                current salary if you don’t want to model past raises.
              </p>
              <NumInput label="401(k) contribution" value={6} onChange={() => {}} suffix="%" />
              <NumInput
                label="Raises above inflation"
                value={0}
                onChange={() => {}}
                suffix="%/yr"
                step={0.5}
              />
            </details>

            <div className={styles.formActions}>
              <button type="submit" className="btn primary">
                Save
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
