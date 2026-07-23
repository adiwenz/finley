/**
 * The **pay change at this month** control (§6/§10.3/§20 of JOBS_HOUSEHOLD_REDESIGN).
 * Extracted from {@link BaseAdjustmentsPanel} so the panel no longer carries the form's
 * transient state: this component owns the whole disclosed form — whether it is open, its
 * live contents, and the confirmation note after a change is applied.
 *
 * A pay change is made against a month the parent selects. The first two kinds are
 * one-month perturbations (a bonus on top of that month's pay, or an absolute one-month
 * figure — a {@link JobIncomeOverride}); the last two are PERMANENT step changes that hold
 * from the month forward (a new ongoing pay, or a delta — a {@link JobPayChange}). Every
 * kind rides the job's own income series, so all are taxed as wages and run through its
 * 401(k): a bonus is not tax-free cash, and a raise is not a magic influx.
 *
 * There is no separate "missed paycheck" kind: a missed month is just "Set pay this month"
 * to $0, which zeroes the month's wages (and so its wage tax) the same way.
 *
 * Plan mutation stays in the parent — this component never sees `Plan` or `setBudget`. It
 * hands the parent a finished {@link JobIncomeOverride} or {@link JobPayChange} to apply and
 * keeps only the form's own state.
 */

import { useState } from "react";
import { dollarsToCents, type Job, type JobIncomeOverride, type JobPayChange } from "@finley/engine";
import { formatDollars } from "../../format";
import { NumInput } from "../numInput/numInput";
import styles from "./baseAdjustments.module.css";

/**
 * A pay change made against the selected month — all flavours share one form. The first two
 * are one-month perturbations (a {@link JobIncomeOverride}); the last two are PERMANENT step
 * changes from the month forward (a {@link JobPayChange}). "Permanent" cuts both ways: a new
 * ongoing pay can be lower than before, so this is a *pay change*, not a "raise".
 */
export type PayChangeKind = "addBonus" | "setTo" | "setOngoing" | "changeOngoing";

/** Whether a kind is a permanent pay change (rides a {@link JobPayChange}) vs. one month. */
const isPermanentChange = (kind: PayChangeKind): kind is "setOngoing" | "changeOngoing" =>
  kind === "setOngoing" || kind === "changeOngoing";

/**
 * The open form's live contents. `null` means the editor is closed — the single flag that
 * says whether the form is showing at all. The confirmation note is deliberately NOT part
 * of this: it is the result of the LAST applied change, so it outlives the form it came
 * from and would be wrong to reset every time the draft's fields move.
 */
interface OneOffDraft {
  readonly kind: PayChangeKind;
  readonly dollars: number;
  /** The explicitly picked job, or `null` to fall back to the first job. */
  readonly jobId: string | null;
}

/** The draft a freshly opened form starts from: a bonus, no amount, no explicit job pick. */
const freshDraft = (): OneOffDraft => ({ kind: "addBonus", dollars: 0, jobId: null });

export interface OneOffIncomeEditorProps {
  readonly jobs: readonly Job[];
  /** The month the change is applied at (the panel's selected month, floored to a paying month). */
  readonly incomeMonth: number;
  /** Apply a one-month perturbation to a job. Plan mutation lives in the parent. */
  readonly onApplyOverride: (jobId: string, override: JobIncomeOverride) => void;
  /** Apply a permanent pay change (a raise OR a cut) to a job. Plan mutation lives in the parent. */
  readonly onApplyPayChange: (jobId: string, payChange: JobPayChange) => void;
}

export function OneOffIncomeEditor({
  jobs,
  incomeMonth,
  onApplyOverride,
  onApplyPayChange,
}: OneOffIncomeEditorProps) {
  /** The open form's contents, or `null` when the form is closed. */
  const [draft, setDraft] = useState<OneOffDraft | null>(null);
  /** A short confirmation of the last pay change applied, echoed like the spending route. */
  const [note, setNote] = useState<string | null>(null);

  /** The job a pay change targets: the explicit pick, else the first job. */
  const targetJobId = draft?.jobId ?? jobs[0]?.id ?? null;

  /**
   * Apply the pay change to the target job at the selected month. The one-month kinds ride
   * a {@link JobIncomeOverride} (a bonus adds on top of that month's pay, "set pay this
   * month" fixes an absolute figure for the one month — $0 for a missed paycheck); the
   * permanent kinds ride a {@link JobPayChange} that holds from this month FORWARD (a new
   * ongoing pay, or a delta). On success the form closes but the confirmation note stays.
   */
  function apply(): void {
    if (draft === null || targetJobId === null) return;
    const cents = dollarsToCents(draft.dollars);
    const jobLabel = `Job ${Math.max(0, jobs.findIndex((j) => j.id === targetJobId)) + 1}`;

    if (isPermanentChange(draft.kind)) {
      const kind = draft.kind === "setOngoing" ? "setTo" : "changeBy";
      onApplyPayChange(targetJobId, { month: incomeMonth, kind, cents });
      const what =
        draft.kind === "setOngoing"
          ? `pay set to ${formatDollars(cents)}`
          : `pay changed by ${formatDollars(cents)}`;
      setNote(`→ ${what} on ${jobLabel} from month ${incomeMonth} onward (ongoing)`);
      setDraft(null);
      return;
    }

    onApplyOverride(targetJobId, { month: incomeMonth, kind: draft.kind, cents });
    const what =
      draft.kind === "addBonus"
        ? `bonus of ${formatDollars(cents)}`
        : `pay set to ${formatDollars(cents)}`;
    setNote(`→ ${what} on ${jobLabel} at month ${incomeMonth}`);
    setDraft(null);
  }

  return (
    <div className={styles.oneOff}>
      {draft !== null ? (
        <div className={styles.oneOffForm} role="group" aria-label="Pay change at this month">
          <label className="field">
            <span className="field-label">Change</span>
            <select
              aria-label="Pay change kind"
              value={draft.kind}
              onChange={(e) =>
                setDraft((d) => d && { ...d, kind: e.target.value as PayChangeKind })
              }
            >
              <optgroup label="This month only">
                <option value="addBonus">Bonus (add on top)</option>
                <option value="setTo">Set pay this month (0 = missed paycheck)</option>
              </optgroup>
              <optgroup label="Permanent (from this month on)">
                <option value="setOngoing">Set new pay</option>
                <option value="changeOngoing">Change pay by (+/−)</option>
              </optgroup>
            </select>
          </label>
          {/* Always show the job picker, even for a single job — one consistent shape, and
              the note/pay change always names the job it landed on. */}
          <label className="field">
            <span className="field-label">Job</span>
            <select
              aria-label="Job"
              value={targetJobId ?? ""}
              onChange={(e) => setDraft((d) => d && { ...d, jobId: e.target.value })}
            >
              {jobs.map((j, i) => (
                <option key={j.id} value={j.id}>
                  Job {i + 1}
                </option>
              ))}
            </select>
          </label>
          <NumInput
            label="Amount"
            value={draft.dollars}
            onChange={(v) => setDraft((d) => d && { ...d, dollars: v })}
            prefix="$"
            step={1}
            min={draft.kind === "changeOngoing" ? undefined : 0}
          />
          <div className={styles.oneOffActions}>
            <button
              type="button"
              className="btn primary"
              onClick={apply}
              disabled={targetJobId === null}
            >
              Apply
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={jobs.length === 0}
          onClick={() => {
            setNote(null);
            setDraft(freshDraft());
          }}
        >
          + Change pay at this month
        </button>
      )}
      {note && (
        <p className={styles.routeEcho} data-testid="pay-change-route">
          {note}
        </p>
      )}
    </div>
  );
}
