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

import {
  applyJobIncomeOverride,
  orderedIncomeOverrides,
  payChangeEffectiveMonth,
  type Job,
  type JobIncomeOverride,
  type JobPayChange,
  type JobPayPath,
} from "@finley/engine";
import { formatDollars } from "../../format";
import { describeIncomeOverride } from "../../jobAdjustments";
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
  /** By the adjustment's own id — see {@link onRemoveOverride}. */
  readonly onRemove: (payChangeId: string) => void;
  /**
   * A one-month adjustment is a different write from a pay change, so it is a different call —
   * and it is addressed by id, because a month may hold several and removing "the bonus in
   * March" has to mean the one whose row was clicked.
   */
  readonly onRemoveOverride: (overrideId: string) => void;
}

interface Row {
  readonly key: string;
  readonly month: number;
  readonly kind: "start" | "change" | "now" | "oneOff";
  readonly label: string;
  readonly monthlyCents: number;
  /** Filled in by "Estimate missing pay history" rather than stated by the user. */
  readonly estimated?: boolean;
  /** Present on the rows a user authored, and only those: the start and "now" are not removable. */
  readonly change?: JobPayChange;
  /** Present on one-month rows; removing one is a different write from removing a change. */
  readonly override?: JobIncomeOverride;
}

export function PayTimeline({
  job,
  birthYear,
  path,
  label,
  onRemove,
  onRemoveOverride,
}: PayTimelineProps) {
  const { startMonth, endMonthExclusive } = path.span;
  const changes = [...(job.payChanges ?? [])]
    .filter((c) => c.month >= startMonth && c.month < endMonthExclusive)
    .sort((a, b) => a.month - b.month);
  /**
   * One-month adjustments, interleaved by date with the permanent changes rather than listed
   * apart. The panel used to only COUNT them in the subtitle, which named a fact the reader
   * could then find nowhere — and could not remove from here at all.
   */
  const overrides = orderedIncomeOverrides(job.incomeOverrides ?? []).filter(
    (o) => o.month >= startMonth && o.month < endMonthExclusive,
  );
  /**
   * What a month pays after each adjustment in turn — the running fold, so three bonuses in one
   * month read $7,000 / $8,000 / $8,500 rather than three rows all claiming the same figure.
   * Called once per row in list order, which is the engine's own order, so the last row of a
   * month states exactly what the projection pays for it.
   */
  const runningPay = new Map<number, number>();
  const payAfter = (override: JobIncomeOverride): number => {
    const base = runningPay.get(override.month) ?? path.monthlyCentsAt(override.month);
    const next = applyJobIncomeOverride(base, override);
    runningPay.set(override.month, next);
    return next;
  };
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
  /**
   * Both kinds in one date order. A permanent change is placed at the month it takes FORCE (a
   * change authored at "now" starts next month); a one-off is placed at the month it lands, and
   * sorts after a change sharing that month, because the change sets the pay the one-off then
   * perturbs.
   */
  const events = [
    ...changes.map((change) => ({ at: payChangeEffectiveMonth(change), rank: 0, change })),
    ...overrides.map((override) => ({ at: override.month, rank: 1, override })),
  ].sort((a, b) => a.at - b.at || a.rank - b.rank);

  for (const event of events) {
    // The seam sits between the last historical entry and the first forward one, so it is
    // inserted on the crossing rather than appended — the list is in age order throughout.
    if (event.at >= 0 && spansNow && !rows.some((r) => r.kind === "now")) {
      rows.push(nowRow(path));
    }
    if ("change" in event) {
      const { change } = event;
      rows.push({
        key: change.id,
        month: change.month,
        kind: "change",
        // A change authored at "now" takes force next month — the stated current salary owns
        // month 0. Say so on the row, and quote the pay from the month it actually starts,
        // rather than the month-0 figure that is still the old one.
        label:
          change.month === 0
            ? `${describePayChange(change)} — from next month`
            : describePayChange(change),
        monthlyCents: path.monthlyCentsAt(payChangeEffectiveMonth(change)),
        estimated: change.estimated === true,
        change,
      });
    } else {
      const { override } = event;
      rows.push({
        key: override.id,
        month: override.month,
        kind: "oneOff",
        label: `${describeIncomeOverride(override)} — this month only`,
        // What the month pays with this adjustment and everything stacked before it — the
        // same figure the chart marks and the projection pays.
        monthlyCents: payAfter(override),
        override,
      });
    }
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
            row.kind === "oneOff" ? styles.entryOneOff : "",
            row.month < 0 ? styles.entryHistory : "",
            row.estimated ? styles.entryEstimated : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <span className={styles.entryAge}>
            {row.kind === "now"
              ? `now · ${ownerAgeAtMonth(birthYear, 0)}`
              : `age ${ownerAgeAtMonth(birthYear, row.month)}`}
          </span>
          <span>
            {row.label}
            {/* Named, not merely styled: "estimated" is a fact about the number, and colour
                alone would not carry it to a screen reader or a colour-blind reader. */}
            {row.estimated && <em className={styles.estimatedTag}> · estimated</em>}
          </span>
          <span className={styles.entryPay}>
            {formatDollars(row.monthlyCents)}
            {/* A one-off row quotes what that ONE month pays, so "/mo" — a rate — would be a
                lie about it. */}
            {row.kind === "oneOff" ? " this month" : "/mo"}
          </span>
          <span>
            {row.change && (
              <button
                type="button"
                aria-label={`Remove pay change at age ${ownerAgeAtMonth(birthYear, row.month)} on ${label}`}
                onClick={() => onRemove(row.change!.id)}
              >
                Remove
              </button>
            )}
            {row.override && (
              <button
                type="button"
                // Named by what it IS, not only when: stacked siblings share a month, and
                // "Remove one-off adjustment at age 36" would be the same name twice.
                aria-label={`Remove ${describeIncomeOverride(row.override)} at age ${ownerAgeAtMonth(birthYear, row.month)} on ${label}`}
                onClick={() => onRemoveOverride(row.override!.id)}
              >
                Remove
              </button>
            )}
          </span>
          {row.kind === "now" && path.monthZeroStepCents !== 0 && (
            <span className={styles.seamNote} data-testid="seam-note">
              {/* Derived from the step rather than read separately, so the two figures and the
                  gap between them are the same arithmetic the chart draws. Quoting the last
                  paid month instead would put a whole growth year inside a sentence that
                  reads as a subtraction. */}
              Your history runs to{" "}
              {formatDollars(row.monthlyCents - path.monthZeroStepCents)}/mo by now; you’ve
              stated {formatDollars(row.monthlyCents)}/mo as today’s pay. Today’s pay wins from
              here on.
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
