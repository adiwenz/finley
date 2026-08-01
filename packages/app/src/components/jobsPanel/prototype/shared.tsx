/** PROTOTYPE — throwaway. Pieces more than one variant needs. */

import { useState } from "react";
import { NumInput } from "../../numInput/numInput";
import {
  ageOfMonth,
  money,
  monthOfAge,
  monthZeroStepDollars,
  payTimeline,
  type ProtoJob,
  type ProtoPayChange,
} from "./model";
import styles from "./proto.module.css";

/**
 * The whole pay story in age order, seam included. This is the idea variants A and C are
 * really testing: history and future are ONE list, and "now" is a row in it rather than an
 * invisible boundary between two forms.
 */
export function PayTimeline({
  job,
  onRemove,
  showSeamNote = true,
  ended = false,
}: {
  job: ProtoJob;
  onRemove?: (month: number) => void;
  showSeamNote?: boolean;
  /**
   * This job finished before "now". There is no month-0 anchor to show and no seam to explain
   * — the job's whole story is history, and it ends where the job ended.
   */
  ended?: boolean;
}) {
  const rows = payTimeline(job).filter((r) => !(ended && r.kind === "now"));
  const step = monthZeroStepDollars(job);

  return (
    <ul className={styles.timeline}>
      {rows.map((row) => (
        <li
          key={row.key}
          className={[
            styles.entry,
            row.kind === "now" ? styles.entryNow : "",
            row.kind === "history" || row.kind === "start" ? styles.entryHistory : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <span className={styles.entryAge}>
            {row.kind === "now" ? `now · ${row.age}` : `age ${row.age}`}
          </span>
          <span>{row.label}</span>
          <span className={styles.entryPay}>{money(row.payDollars)}/mo</span>
          <span>
            {row.change && onRemove ? (
              <button type="button" onClick={() => onRemove(row.month)}>
                Remove
              </button>
            ) : null}
          </span>
          {/* The authored step at month 0. Stated, never reconciled — the current-pay anchor
              already reflects whatever really happened, so closing the gap would double-count
              the historical raises. Neutral wording: a cut is legitimate. */}
          {row.kind === "now" && showSeamNote && step !== 0 && (
            <span className={styles.seamNote}>
              History reaches {money(job.currentMonthlyDollars - step)}/mo; you’ve stated{" "}
              {money(job.currentMonthlyDollars)}/mo as today’s pay. Today’s pay wins from here on.
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A pay change dated by the owner's age, with the floor moved from "now" down to the job's
 * start age. That one change is what makes history authorable at all — an age below the
 * owner's current age becomes a negative month, which the engine routes to the historical
 * reconstruction.
 */
export function ProtoPayChangeForm({
  job,
  minAge,
  maxAge,
  defaultAge,
  onSubmit,
  onCancel,
  title,
}: {
  job: ProtoJob;
  minAge: number;
  /** Last age this job still pays. A change after the job ended has nothing to change. */
  maxAge: number;
  defaultAge: number;
  onSubmit: (change: ProtoPayChange) => void;
  onCancel: () => void;
  title: string;
}) {
  const clamp = (a: number) => Math.min(Math.max(a, minAge), maxAge);
  const [kind, setKind] = useState<ProtoPayChange["kind"]>("setTo");
  // Clamped on the way IN, not just on blur: a default outside the job's span (a job that
  // ended years ago, opened at today's age) would otherwise submit unchanged if the user
  // never touches the field.
  const [age, setAge] = useState(() => clamp(defaultAge));
  const [dollars, setDollars] = useState(0);

  const month = monthOfAge(job, age);
  const side =
    month < 0 ? "before now — feeds Social Security" : "from now on — feeds the projection";
  const ended = maxAge < job.currentAge;

  return (
    <div className={styles.form} role="group" aria-label={title}>
      <label className="field">
        <span className="field-label">Change</span>
        <select
          aria-label="Pay change kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ProtoPayChange["kind"])}
        >
          <option value="setTo">Set new pay</option>
          <option value="changeBy">Change pay by (+/−)</option>
        </select>
      </label>
      <NumInput label="From age" value={age} onChange={setAge} step={1} min={minAge} max={maxAge} />
      <NumInput
        label="Amount"
        value={dollars}
        onChange={setDollars}
        prefix="$"
        step={1}
        min={kind === "changeBy" ? undefined : 0}
      />
      {/* Names which half of the engine the change lands in, without ever saying "month −60".
          Worth watching in the prototype: does this read as helpful, or as leaking? */}
      <p className="hint">
        Age {age} is {side}.
        {/* A job that is over can only take changes inside the span it actually ran. Stated up
            front, so the bound isn't discovered by having a typed age snap back. */}
        {ended
          ? ` This job ran from age ${job.startAge} to ${job.endAge}, so a pay change on it has to land in that span.`
          : ""}
      </p>
      <div className={styles.formActions}>
        <button
          type="button"
          className="btn primary"
          onClick={() => onSubmit({ month: monthOfAge(job, clamp(age)), kind, dollars })}
        >
          Apply
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Rule 5: surface the state. The exact record each variant would hand the engine. */
export function StateReadout({ job }: { job: ProtoJob }) {
  const step = monthZeroStepDollars(job);
  const shape = {
    salary: {
      startingSalaryCents: job.startingMonthlyDollars * 12 * 100,
      currentSalaryCents: job.currentMonthlyDollars * 12 * 100,
    },
    payChanges: [...job.payChanges]
      .sort((a, b) => a.month - b.month)
      .map((c) => ({
        month: c.month,
        age: ageOfMonth(job, c.month),
        side: c.month < 0 ? "history" : "forward",
        kind: c.kind,
        cents: c.dollars * 100,
      })),
    monthZeroStep: `${step >= 0 ? "+" : "−"}${money(Math.abs(step))}/mo (authored, not reconciled)`,
  };
  return <pre className={styles.state}>{JSON.stringify(shape, null, 2)}</pre>;
}
