/**
 * Job authoring form (§6, issue #72) — the disclosed add/edit surface for one job on
 * the value-editing plane (§4.2 / §10.3): a direct edit to `plan.jobs`, never a timeline
 * event. Speaks the user's terms (a monthly salary, the age they started, whether it
 * runs to retirement) and folds them into a {@link JobDraft} on submit. Progressive
 * disclosure (§10.4): the 401(k) deferral and above-inflation raises live behind an
 * "Advanced" details, like the account-return knobs in the Budget editor.
 *
 * The same form backs both add and edit — `initial` seeds it.
 */

import { useState } from "react";
import type { JobDraft } from "../../planPeople";
import { NumInput } from "../numInput/numInput";
import styles from "./jobsPanel.module.css";

interface JobFormProps {
  /** Seed values (an existing job's draft when editing); a blank draft when adding. */
  initial: JobDraft;
  /** Verb shown on the primary button and used to label the form ("Add" / "Save"). */
  submitLabel: string;
  onSubmit: (draft: JobDraft) => void;
  onCancel: () => void;
}

export function JobForm({ initial, submitLabel, onSubmit, onCancel }: JobFormProps) {
  const [monthlyDollars, setMonthlyDollars] = useState(Math.round(initial.monthlyCents / 100));
  const [startAge, setStartAge] = useState(initial.startAge);
  const [openEnded, setOpenEnded] = useState(initial.endAge === null);
  const [endAge, setEndAge] = useState(initial.endAge ?? Math.max(initial.startAge + 1, 65));
  const [deferralPct, setDeferralPct] = useState(initial.deferralPct);
  const [realGrowthPct, setRealGrowthPct] = useState(initial.realGrowthPct);

  function submit() {
    onSubmit({
      monthlyCents: Math.round(monthlyDollars * 100),
      startAge,
      endAge: openEnded ? null : Math.max(startAge + 1, endAge),
      realGrowthPct,
      deferralPct,
    });
  }

  return (
    <form
      className={styles.form}
      aria-label={`${submitLabel} job`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* step=1: salary is free-form dollars — a larger spinner step would make the
          browser reject an off-step value (e.g. $5,250) on submit (HTML5 validity). */}
      <NumInput
        label="Monthly salary"
        value={monthlyDollars}
        onChange={setMonthlyDollars}
        prefix="$"
        step={1}
        min={0}
      />
      <NumInput label="Start age" value={startAge} onChange={setStartAge} min={14} max={100} step={1} />
      <label className="field field-check">
        <input
          type="checkbox"
          checked={openEnded}
          onChange={(e) => setOpenEnded(e.target.checked)}
        />
        <span className="field-label">Open-ended (runs until retirement)</span>
      </label>
      {!openEnded && (
        <NumInput
          label="End age"
          value={endAge}
          onChange={setEndAge}
          min={startAge + 1}
          max={100}
          step={1}
        />
      )}
      <p className="hint">
        The age you began this job seeds your Social-Security-covered years; an open-ended
        job runs until your retirement age. Estimate, not advice.
      </p>

      <details className="advanced">
        <summary>Advanced</summary>
        {/* Capped at 100%: you can't defer more than your whole paycheck. The annual
            DOLLAR elective limit is enforced separately by the engine (§5.4) — deferral
            past it is paid as taxable income, disclosed by the nudge on the Jobs panel. */}
        <NumInput
          label="401(k) contribution"
          value={deferralPct}
          onChange={setDeferralPct}
          suffix="%"
          min={0}
          max={100}
          step={1}
        />
        <NumInput
          label="Raises above inflation"
          value={realGrowthPct}
          onChange={setRealGrowthPct}
          suffix="%/yr"
          min={0}
          step={0.5}
        />
        <p className="hint">
          0%/yr holds your pay flat in today’s dollars (it still keeps up with inflation).
          A positive rate is real growth on top. Estimate, not advice.
        </p>
      </details>

      <div className={styles.formActions}>
        <button type="submit" className="btn primary">
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
