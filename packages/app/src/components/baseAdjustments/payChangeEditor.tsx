/**
 * The **pay change at this month** control. Owns the disclosed form's transient state, so
 * {@link BaseAdjustmentsPanel} carries none of it. It never sees `Plan` or a transaction; it
 * hands the parent a finished {@link JobIncomeOverride} or {@link JobPayChange} to apply,
 * against a month the parent selects.
 *
 * Every kind rides the job's own income series, so all are taxed as wages and run through
 * its 401(k) — a bonus is not tax-free cash. No separate "missed paycheck" kind: that is
 * "Set pay this month" to $0.
 */

import { useState } from "react";
import { dollarsToCents, type JobIncomeOverride, type JobPayChange } from "@finley/engine";
import { formatDollars } from "../../format";
import { NumInput } from "../numInput/numInput";
import styles from "./baseAdjustments.module.css";

/**
 * Not a {@link import("@finley/engine").Job}: the form reads no job fields and does not know
 * who holds it. The parent supplies a label already owner-qualified where needed ("Sam · Job
 * 1"), so two members' identically-titled jobs stay distinguishable.
 */
export interface PayChangeJobOption {
  readonly id: string;
  readonly label: string;
}

/**
 * The first two are one-month perturbations (a {@link JobIncomeOverride}); the last two are
 * permanent step changes from the month forward (a {@link JobPayChange}). Permanent cuts
 * both ways: a new ongoing pay can be lower, so this is a *pay change*, not a "raise".
 */
export type PayChangeKind = "addBonus" | "setTo" | "setOngoing" | "changeOngoing";

const isPermanentChange = (kind: PayChangeKind): kind is "setOngoing" | "changeOngoing" =>
  kind === "setOngoing" || kind === "changeOngoing";

/**
 * The open form's live contents; `null` means closed — the single open/shut flag. The
 * confirmation note is not part of it: it reports the last applied change, so it outlives
 * the form it came from.
 */
interface PayChangeDraft {
  readonly kind: PayChangeKind;
  readonly dollars: number;
  /** The explicitly picked job, or `null` to fall back to the first job. */
  readonly jobId: string | null;
}

const freshDraft = (): PayChangeDraft => ({ kind: "addBonus", dollars: 0, jobId: null });

export interface PayChangeEditorProps {
  /** Every job in the household, in join order. */
  readonly jobs: readonly PayChangeJobOption[];
  /** The panel's selected month, floored to a paying month. */
  readonly incomeMonth: number;
  /** Plan mutation lives in the parent. */
  readonly onApplyOverride: (jobId: string, override: JobIncomeOverride) => void;
  /** A raise or a cut. Plan mutation lives in the parent. */
  readonly onApplyPayChange: (jobId: string, payChange: JobPayChange) => void;
}

export function PayChangeEditor({
  jobs,
  incomeMonth,
  onApplyOverride,
  onApplyPayChange,
}: PayChangeEditorProps) {
  const [draft, setDraft] = useState<PayChangeDraft | null>(null);
  /** Echoed like the spending route's confirmation. */
  const [note, setNote] = useState<string | null>(null);

  const targetJobId = draft?.jobId ?? jobs[0]?.id ?? null;

  /** On success the form closes but the note stays. */
  function apply(): void {
    if (draft === null || targetJobId === null) return;
    const cents = dollarsToCents(draft.dollars);
    // The note names the job as the picker does, owner and all.
    const jobLabel = jobs.find((j) => j.id === targetJobId)?.label ?? targetJobId;

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
          {/* Shown even for a single job — one consistent shape. */}
          <label className="field">
            <span className="field-label">Job</span>
            <select
              aria-label="Job"
              value={targetJobId ?? ""}
              onChange={(e) => setDraft((d) => d && { ...d, jobId: e.target.value })}
            >
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
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
