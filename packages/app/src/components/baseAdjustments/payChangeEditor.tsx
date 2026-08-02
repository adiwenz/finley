/**
 * The **pay change at this month** control. Owns the disclosed form's transient state, so
 * {@link BaseAdjustmentsPanel} carries none of it. It never sees `Plan` or a transaction; it
 * hands the parent a finished {@link JobIncomeOverrideInput} or {@link JobPayChangeInput} to apply,
 * against a month the parent selects.
 *
 * Every kind rides the job's own income series, so all are taxed as wages and run through
 * its 401(k) — a bonus is not tax-free cash. No separate "missed paycheck" kind: that is
 * "Set pay this month" to $0.
 */

import { useState } from "react";
import {
  dollarsToCents,
  type JobIncomeOverrideInput,
  type JobPayChangeInput,
} from "@finley/engine";
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
 * The first two are one-month perturbations (a {@link JobIncomeOverrideInput}); the last two are
 * permanent step changes from the month forward (a {@link JobPayChangeInput}). Permanent cuts
 * both ways: a new ongoing pay can be lower, so this is a *pay change*, not a "raise".
 */
export type PayChangeKind = "addBonus" | "setTo" | "setOngoing" | "changeOngoing";

/**
 * One thing already authored at the selected month, in the terms this control speaks. Derived
 * by the parent from the plan, so it survives a reload and disappears when the underlying
 * change does.
 */
export interface AppliedAdjustment {
  /**
   * The adjustment's own minted id — the row's identity. Not `${jobId}:${scope}`, which is what
   * a job's second bonus in one month used to collide with, so the list showed one entry where
   * two were stored and React reused the first row's node for the second's content.
   */
  readonly id: string;
  readonly jobId: string;
  /** Owner-qualified where needed, exactly as the job picker names it. */
  readonly jobLabel: string;
  /** A one-month perturbation, or a permanent change from this month forward. */
  readonly scope: "thisMonth" | "ongoing";
  /** "bonus of $4,000" / "pay set to $6,250" — undated; the row states the month. */
  readonly description: string;
}

const isPermanentChange = (kind: PayChangeKind): kind is "setOngoing" | "changeOngoing" =>
  kind === "setOngoing" || kind === "changeOngoing";

/** The open form's live contents; `null` means closed — the single open/shut flag. */
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
  /**
   * Everything already authored at {@link incomeMonth}, across every job, as the parent reads
   * it back from the plan.
   *
   * This used to be a `note` remembering the last thing applied, which was wrong in three ways
   * at once: a second change replaced the first on screen even when both were stored, a change
   * removed from the Jobs panel went on being reported here, and nothing at all showed after a
   * reload. What is at this month is a fact about the plan, so it is read rather than recalled.
   */
  readonly appliedAtMonth: readonly AppliedAdjustment[];
  /** The panel's selected month, floored to a paying month. */
  readonly incomeMonth: number;
  /** Plan mutation lives in the parent. */
  readonly onApplyOverride: (jobId: string, override: JobIncomeOverrideInput) => void;
  /** A raise or a cut. Plan mutation lives in the parent. */
  readonly onApplyPayChange: (jobId: string, payChange: JobPayChangeInput) => void;
}

export function PayChangeEditor({
  jobs,
  incomeMonth,
  appliedAtMonth,
  onApplyOverride,
  onApplyPayChange,
}: PayChangeEditorProps) {
  const [draft, setDraft] = useState<PayChangeDraft | null>(null);

  const targetJobId = draft?.jobId ?? jobs[0]?.id ?? null;

  /** On success the form closes; what was applied shows up in {@link appliedAtMonth}. */
  function apply(): void {
    if (draft === null || targetJobId === null) return;
    const cents = dollarsToCents(draft.dollars);

    if (isPermanentChange(draft.kind)) {
      const kind = draft.kind === "setOngoing" ? "setTo" : "changeBy";
      onApplyPayChange(targetJobId, { month: incomeMonth, kind, cents });
    } else {
      onApplyOverride(targetJobId, { month: incomeMonth, kind: draft.kind, cents });
    }
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
          onClick={() => setDraft(freshDraft())}
        >
          + Change pay at this month
        </button>
      )}
      {/* Every adjustment standing at this month, not the last one applied. Several stack;
          removing one anywhere removes it here. */}
      {appliedAtMonth.length > 0 && (
        <ul className={styles.routeEcho} data-testid="pay-change-route">
          {appliedAtMonth.map((applied) => (
            // The adjustment's own id. Keying by job and scope gave a job's two bonuses in one
            // month the same key, so React kept one row and the second silently replaced the
            // first's text.
            <li key={applied.id}>
              → {applied.description} on {applied.jobLabel}{" "}
              {applied.scope === "ongoing"
                ? `from month ${incomeMonth} onward (ongoing)`
                : `at month ${incomeMonth}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
