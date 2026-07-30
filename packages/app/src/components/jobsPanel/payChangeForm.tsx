/**
 * A permanent pay change on ONE job — a raise, or a cut — authored where the job is.
 *
 * Dated in the OWNER's age, like every other date in this panel, rather than the simulation
 * month Base + Adjustments works in: there the month is the thing already selected, here the
 * job is. Both end up as the same {@link JobPayChange}.
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
   * The owner's age now. A change cannot start before it — the past is not authorable — and a
   * fresh draft opens on the next round age so "Apply" without touching the date still means
   * something.
   */
  readonly currentAge: number;
  readonly onSubmit: (draft: PayChangeDraft) => void;
  readonly onCancel: () => void;
}

export function PayChangeForm({ currentAge, onSubmit, onCancel }: PayChangeFormProps) {
  const [draft, setDraft] = useState<PayChangeDraft>({
    kind: "setTo",
    age: currentAge + 1,
    dollars: 0,
  });

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
        min={currentAge}
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
      <div className={styles.formActions}>
        <button type="button" className="btn primary" onClick={() => onSubmit(draft)}>
          Apply
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
