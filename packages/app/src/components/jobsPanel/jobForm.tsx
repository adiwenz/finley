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

import { useRef, useState } from "react";
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

/**
 * The form's live state, in the terms the fields speak — one object, not a hook per field.
 * `endAge: null` IS "open-ended": the checkbox is derived from it rather than tracked
 * separately, so the two can never disagree. (Salary is held in whole dollars, the unit the
 * input edits; it's converted to cents on submit.)
 */
interface JobFormDraft {
  readonly monthlyDollars: number;
  readonly startAge: number;
  /** `null` = open-ended (runs to retirement); a number = a fixed end age. */
  readonly endAge: number | null;
  readonly deferralPct: number;
  readonly realGrowthPct: number;
}

/** A sensible finite end age to fall back to when none was ever entered. */
const defaultEndAge = (startAge: number): number => Math.max(startAge + 1, 65);

export function JobForm({ initial, submitLabel, onSubmit, onCancel }: JobFormProps) {
  const [draft, setDraft] = useState<JobFormDraft>(() => ({
    monthlyDollars: Math.round(initial.monthlyCents / 100),
    startAge: initial.startAge,
    endAge: initial.endAge,
    deferralPct: initial.deferralPct,
    realGrowthPct: initial.realGrowthPct,
  }));

  // The last finite end age the user had, remembered across "open-ended" toggles: ticking
  // the box sets `endAge` to null (the field disappears), and unticking restores THIS value
  // rather than snapping back to a default. Not part of the draft — it's a UX memory, not
  // domain state — so `endAge` stays a single source of truth.
  const lastFiniteEndAge = useRef(initial.endAge ?? defaultEndAge(initial.startAge));

  const patch = (fields: Partial<JobFormDraft>) => setDraft((d) => ({ ...d, ...fields }));

  const openEnded = draft.endAge === null;

  function submit() {
    onSubmit({
      monthlyCents: Math.round(draft.monthlyDollars * 100),
      startAge: draft.startAge,
      endAge: draft.endAge === null ? null : Math.max(draft.startAge + 1, draft.endAge),
      realGrowthPct: draft.realGrowthPct,
      deferralPct: draft.deferralPct,
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
        value={draft.monthlyDollars}
        onChange={(v) => patch({ monthlyDollars: v })}
        prefix="$"
        step={1}
        min={0}
      />
      <NumInput
        label="Start age"
        value={draft.startAge}
        onChange={(v) => patch({ startAge: v })}
        min={14}
        max={100}
        step={1}
      />
      <label className="field field-check">
        <input
          type="checkbox"
          checked={openEnded}
          onChange={(e) => patch({ endAge: e.target.checked ? null : lastFiniteEndAge.current })}
        />
        <span className="field-label">Open-ended (runs until retirement)</span>
      </label>
      {draft.endAge !== null && (
        <NumInput
          label="End age"
          value={draft.endAge}
          onChange={(v) => {
            lastFiniteEndAge.current = v;
            patch({ endAge: v });
          }}
          min={draft.startAge + 1}
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
          value={draft.deferralPct}
          onChange={(v) => patch({ deferralPct: v })}
          suffix="%"
          min={0}
          max={100}
          step={1}
        />
        <NumInput
          label="Raises above inflation"
          value={draft.realGrowthPct}
          onChange={(v) => patch({ realGrowthPct: v })}
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
