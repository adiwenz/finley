/**
 * One job's whole pay story as a single age-ordered list — where it started, every permanent
 * change, and "now" as a row *in* the list rather than an invisible boundary between two of
 * them.
 *
 * The engine splits a job's pay at month 0: negative months reconstruct what was actually
 * earned, month 0 onward is anchored on the authored current salary and never continued from
 * the history (see `SalaryTrajectory`). That split is real, and the list deliberately does not
 * mirror it as two surfaces — a user asking "when did I get that raise?" should not first have
 * to answer "before or after today?" to know where to look.
 *
 * What the split does earn is the seam row. Where the reconstruction lands at month −1 need not
 * equal the stated current salary, and the engine does not reconcile the two: both are authored
 * facts and the current one wins from there on. The row states that, **neutrally** — a pay cut,
 * a job change, a stated salary that simply doesn't match are all legitimate, and warning
 * styling would invite users to close the one gap the engine keeps open on purpose.
 */

import type { Job, JobPayChange, JobPayPath } from "@finley/engine";
import { formatDollars } from "../../format";
import { ownerAgeAtMonth } from "../../planPeople";
import styles from "./jobsPanel.module.css";

/** "Pay set to $6,250/mo" / "Pay cut $500/mo" — a permanent change, undated. */
export function describePayChange(change: JobPayChange): string {
  if (change.kind === "setTo") return `Pay set to ${formatDollars(change.cents)}/mo`;
  const verb = change.cents < 0 ? "cut" : "raised";
  return `Pay ${verb} ${formatDollars(Math.abs(change.cents))}/mo`;
}

interface PayTimelineProps {
  readonly job: Job;
  readonly birthYear: number;
  readonly path: JobPayPath;
  /** How the job is named across the household — every control here says which job it acts on. */
  readonly label: string;
  readonly onRemove: (month: number) => void;
}

interface Row {
  readonly key: string;
  readonly month: number;
  readonly kind: "start" | "change" | "now";
  readonly label: string;
  readonly monthlyCents: number;
  /** Present on the rows a user authored, and only those: the start and "now" are not removable. */
  readonly change?: JobPayChange;
}

export function PayTimeline({ job, birthYear, path, label, onRemove }: PayTimelineProps) {
  const { startMonth, endMonthExclusive } = path.span;
  const changes = [...(job.payChanges ?? [])]
    .filter((c) => c.month >= startMonth && c.month < endMonthExclusive)
    .sort((a, b) => a.month - b.month);
  /**
   * The job is under way and still paying, so month 0 falls inside it and the seam is a real
   * row. A job wholly behind us has no month-0 pay and never reads one; a job that has not
   * started yet has no history for a seam to sit between.
   */
  const spansNow = startMonth < 0 && endMonthExclusive > 0;

  const rows: Row[] = [
    {
      key: "start",
      month: startMonth,
      kind: "start",
      label: "Started this job",
      monthlyCents: path.monthlyCentsAt(startMonth),
    },
  ];
  for (const change of changes) {
    // The seam sits between the last historical change and the first forward one, so it is
    // inserted on the crossing rather than appended — the list is in age order throughout.
    if (change.month >= 0 && spansNow && !rows.some((r) => r.kind === "now")) {
      rows.push(nowRow(path));
    }
    rows.push({
      key: `c${change.month}`,
      month: change.month,
      kind: "change",
      label: describePayChange(change),
      monthlyCents: path.monthlyCentsAt(change.month),
      change,
    });
  }
  if (spansNow && !rows.some((r) => r.kind === "now")) rows.push(nowRow(path));

  return (
    <ul className={styles.timeline} aria-label={`Pay history for ${label}`}>
      {rows.map((row) => (
        <li
          key={row.key}
          className={[
            styles.entry,
            row.kind === "now" ? styles.entryNow : "",
            row.month < 0 ? styles.entryHistory : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <span className={styles.entryAge}>
            {row.kind === "now"
              ? `now · ${ownerAgeAtMonth(birthYear, 0)}`
              : `age ${ownerAgeAtMonth(birthYear, row.month)}`}
          </span>
          <span>{row.label}</span>
          <span className={styles.entryPay}>{formatDollars(row.monthlyCents)}/mo</span>
          <span>
            {row.change && (
              <button
                type="button"
                aria-label={`Remove pay change at age ${ownerAgeAtMonth(birthYear, row.month)} on ${label}`}
                onClick={() => onRemove(row.month)}
              >
                Remove
              </button>
            )}
          </span>
          {row.kind === "now" && path.monthZeroStepCents !== 0 && (
            <span className={styles.seamNote}>
              History reaches{" "}
              {formatDollars(path.historyReachMonthlyCents ?? 0)}/mo; you’ve stated{" "}
              {formatDollars(row.monthlyCents)}/mo as today’s pay. Today’s pay wins from here on.
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const nowRow = (path: JobPayPath): Row => ({
  key: "now",
  month: 0,
  kind: "now",
  label: "Now",
  monthlyCents: path.monthlyCentsAt(0),
});
