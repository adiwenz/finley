/**
 * A permanent pay change on ONE job — a raise, or a cut — authored where the job is.
 *
 * Dated in the OWNER's age, like every other date in this panel, rather than the simulation
 * month Base + Adjustments works in: there the month is the thing already selected, here the
 * job is. Both end up as the same {@link JobPayChange}.
 *
 * The age runs the whole job, **including the part already lived**: an age below the owner's
 * current one becomes a negative month, which the engine routes to the historical
 * reconstruction rather than the projection. That one relaxed bound is what makes a job's pay
 * history authorable at all, and it needs no new vocabulary — age is already the panel's date.
 *
 * The owner's current age is the one age that does not mean "from this month": month 0 is
 * already owned by the authored current salary, so a change dated there takes force next month
 * (`payChangeEffectiveMonth`). The hint says so at the moment the age is typed, because a raise
 * that quietly starts a month later than asked is worse than one that says it will.
 *
 * Only permanent changes. A single-month perturbation (a bonus, a missed paycheck) belongs to
 * a month rather than to the employment, and stays where a month is picked.
 */

import { useState } from "react";
import type { JobPayChange } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import styles from "./jobsPanel.module.css";

/** What the form collects: the engine's two permanent kinds, an age, and an amount. */
export interface PayChangeDraft {
  readonly kind: JobPayChange["kind"];
  readonly age: number;
  readonly dollars: number;
}

export interface PayChangeFormProps {
  /**
   * The job's start age. A change before the job existed has no baseline to apply to, so this
   * — not the owner's current age — is the floor.
   */
  readonly minAge: number;
  /**
   * The last age the job still pays. A change after it ended has nothing left to change.
   */
  readonly maxAge: number;
  /**
   * Where the form opens. The seam ("now") by default, so the direction — back into history or
   * forward into the projection — stays an explicit choice rather than a bias in the default.
   */
  readonly defaultAge: number;
  /** The owner's age now, for the line naming which side of "now" the change lands on. */
  readonly currentAge: number;
  readonly onSubmit: (draft: PayChangeDraft) => void;
  readonly onCancel: () => void;
}

export function PayChangeForm({
  minAge,
  maxAge,
  defaultAge,
  currentAge,
  onSubmit,
  onCancel,
}: PayChangeFormProps) {
  const clamp = (age: number) => Math.min(Math.max(age, minAge), maxAge);
  const [draft, setDraft] = useState<PayChangeDraft>(() => ({
    kind: "setTo",
    // Clamped on the way IN, not only on blur: a default outside the job's span — a job that
    // ended years ago, opening at today's age — would otherwise submit unchanged if the user
    // never touched the field.
    age: clamp(defaultAge),
    dollars: 0,
  }));

  return (
    <div className={styles.form} role="group" aria-label="Pay change">
      <label className="field">
        <span className="field-label">Change</span>
        <select
          aria-label="Pay change kind"
          value={draft.kind}
          onChange={(e) =>
            setDraft((d) => ({ ...d, kind: e.target.value as JobPayChange["kind"] }))
          }
        >
          <option value="setTo">Set new pay</option>
          <option value="changeBy">Change pay by (+/−)</option>
        </select>
      </label>
      <NumInput
        label="From age"
        value={draft.age}
        onChange={(age) => setDraft((d) => ({ ...d, age }))}
        step={1}
        min={minAge}
        max={maxAge}
      />
      <NumInput
        label="Amount"
        value={draft.dollars}
        onChange={(dollars) => setDraft((d) => ({ ...d, dollars }))}
        prefix="$"
        step={1}
        // A cut is a negative `changeBy`; a new pay is never below zero.
        min={draft.kind === "changeBy" ? undefined : 0}
      />
      {/* Names which half of the plan the change lands in, in the panel's own terms — never
          "month −60". A job whose whole span is behind us has no forward half to name. */}
      <p className="hint">
        {draft.age < currentAge
          ? `Age ${draft.age} is before now, so this changes what you earned — it feeds your Social-Security-covered years.`
          : draft.age === currentAge
            ? // Dated "now", where the stated current salary already owns the month. The change
              // is kept and starts next month rather than displacing the figure it sits beside.
              `Age ${draft.age} is your age now, so this starts next month — this month still pays the salary you’ve stated above.`
            : `Age ${draft.age} is from now on, so this changes what the projection pays you.`}
        {/* Stated up front, so the bound is not discovered by having a typed age snap back. */}
        {` This job pays from age ${minAge} to ${maxAge}.`}
      </p>
      <div className={styles.formActions}>
        <button
          type="button"
          className="btn primary"
          onClick={() => onSubmit({ ...draft, age: clamp(draft.age) })}
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
