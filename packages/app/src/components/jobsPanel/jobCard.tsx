/**
 * One {@link Job} on the Jobs panel: its headline pay, span, deferral and one-off adjustments,
 * the pay chart and timeline, and the per-job authoring surfaces (edit, change pay). A
 * Finley-specific card, not a generic one — it knows a job has two salary anchors, a seam at
 * "now", and a Social-Security-covered past.
 *
 * Every plan mutation leaves through a narrow callback; the card never holds the plan setter or
 * decides how a write is committed. Which authoring panel is open is the panel's state, passed
 * in as {@link JobCardProps.authoring}, so only one card is ever mid-edit across the list.
 */

import type { Job } from "@finley/engine";
import type { JobPayPath } from "@finley/engine";
import {
  jobEndAgeFor,
  jobStartAgeFor,
  ownerAgeAtMonth,
  type JobEditDraft,
} from "../../planPeople";
import type { JobOwner } from "../../jobOwners";
import { formatDollars } from "../../format";
import { JobForm } from "./jobForm";
import { PayChangeForm, type PayChangeDraft } from "./payChangeForm";
import { PayChart } from "./payChart";
import { PayTimeline } from "./payTimeline";
import styles from "./jobsPanel.module.css";

/** Which authoring panel this card has open, if any — the panel's state, narrowed to one job. */
export type JobCardAuthoring =
  | { kind: "edit" }
  /** `seedAge` is where the change form opens — an age clicked on the chart, else the seam. */
  | { kind: "payChange"; seedAge?: number }
  | null;

/** "from age 18 · open-ended (to retirement)" / "age 30–45" — a job's span in its OWNER's terms. */
function describeSpan(owner: JobOwner, job: Job): string {
  const start = jobStartAgeFor(owner.birthYear, job);
  const end = jobEndAgeFor(owner.birthYear, job);
  return end === null
    ? `from age ${start} · open-ended (to retirement)`
    : `age ${start}–${end}`;
}

export interface JobCardProps {
  readonly owner: JobOwner;
  readonly job: Job;
  /** The app's name for this job — owner-qualified once a second earner exists. */
  readonly label: string;
  /** Current monthly pay at month 0, the projection's anchor. Read here, never written. */
  readonly monthlyCents: number;
  /** The edit form's seed, prepared by the panel from the same projection reads. */
  readonly initialEditDraft: JobEditDraft;
  /** The job's pay across its whole employment, in the panel's chosen denomination. */
  readonly path: JobPayPath;
  readonly lifeExpectancy: number;
  readonly inTodaysDollars: boolean;
  /** The household holds more than one earner, so the edit form shows whose job this is. */
  readonly severalOwners: boolean;
  /** Whether this job's owner is the primary person — context for the edit form's age copy. */
  readonly isPrimaryOwner: boolean;
  readonly authoring: JobCardAuthoring;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onSaveEdit: (draft: JobEditDraft) => void;
  readonly onCancel: () => void;
  readonly onStartPayChange: () => void;
  /** An age clicked on the pay chart, seeding a change there. */
  readonly onPickAge: (age: number) => void;
  readonly onSubmitPayChange: (draft: PayChangeDraft) => void;
  readonly onRemovePayChange: (payChangeId: string) => void;
  readonly onRemoveOverride: (overrideId: string) => void;
}

export function JobCard({
  owner,
  job,
  label,
  monthlyCents,
  initialEditDraft,
  path,
  lifeExpectancy,
  inTodaysDollars,
  severalOwners,
  isPrimaryOwner,
  authoring,
  onEdit,
  onDelete,
  onSaveEdit,
  onCancel,
  onStartPayChange,
  onPickAge,
  onSubmitPayChange,
  onRemovePayChange,
  onRemoveOverride,
}: JobCardProps) {
  const overrideCount = job.incomeOverrides?.length ?? 0;
  const payChanges = job.payChanges ?? [];
  const currentAge = ownerAgeAtMonth(owner.birthYear, 0);
  const startAge = jobStartAgeFor(owner.birthYear, job);
  // The last age the job still pays: its span end is exclusive, so a change dated there would
  // have nothing left to change.
  const lastPaidAge = ownerAgeAtMonth(owner.birthYear, path.span.endMonthExclusive) - 1;

  return (
    <li className={styles.row} aria-label={label}>
      <div className={styles.head}>
        <span className={styles.name}>{label}</span>
        {/* A job that is over has no current pay to headline — quoting one would state a figure
            the engine never reads. What it paid is on the list below, in the past tense. */}
        {path.endedBeforeNow ? (
          <span className={styles.salary} title="This job has ended">
            ended at age {lastPaidAge + 1}
          </span>
        ) : (
          <span className={styles.salary} title="Current pay — see pay changes below">
            {formatDollars(monthlyCents)}/mo{payChanges.length > 0 ? " now" : ""}
          </span>
        )}
      </div>
      <div className={styles.meta}>{describeSpan(owner, job)}</div>
      {(job.deferral || overrideCount > 0) && (
        <div className={styles.meta}>
          {job.deferral
            ? `${Math.round(job.deferral.deferralFraction * 100)}% to 401(k)${
                job.deferral.employerMatchFraction
                  ? ` · ${Math.round(job.deferral.employerMatchFraction * 100)}% match`
                  : ""
              }`
            : ""}
          {job.deferral && overrideCount > 0 ? " · " : ""}
          {overrideCount > 0
            ? `${overrideCount} one-off (single-month) adjustment${overrideCount === 1 ? "" : "s"}`
            : ""}
        </div>
      )}
      {/* The job's pay across the whole employment, seam and all. Clicking an age seeds a change
          there — the chart is an input, not a picture. */}
      <PayChart
        path={path}
        payChanges={payChanges}
        incomeOverrides={job.incomeOverrides ?? []}
        birthYear={owner.birthYear}
        lifeExpectancy={lifeExpectancy}
        label={label}
        inTodaysDollars={inTodaysDollars}
        onPickAge={onPickAge}
      />
      <PayTimeline
        job={job}
        birthYear={owner.birthYear}
        path={path}
        label={label}
        onRemove={onRemovePayChange}
        onRemoveOverride={onRemoveOverride}
      />
      <div className={styles.actions}>
        <button type="button" aria-label={`Edit ${label}`} onClick={onEdit}>
          Edit
        </button>
        <button type="button" aria-label={`Change pay on ${label}`} onClick={onStartPayChange}>
          Change pay
        </button>
        <button type="button" aria-label={`Delete ${label}`} onClick={onDelete}>
          Delete
        </button>
      </div>
      {authoring?.kind === "payChange" && (
        <PayChangeForm
          // Floored at the job's START age, not at "now": a change before the job existed has no
          // baseline to apply to, but one before today does — that is exactly what authoring a
          // pay history is.
          minAge={startAge}
          maxAge={lastPaidAge}
          // Opens on the clicked age, else on the seam, so the direction stays an explicit choice
          // instead of a bias baked into the default.
          defaultAge={authoring.seedAge ?? currentAge}
          currentAge={currentAge}
          onSubmit={onSubmitPayChange}
          onCancel={onCancel}
        />
      )}
      {authoring?.kind === "edit" && (
        <JobForm
          initial={initialEditDraft}
          currentAge={currentAge}
          submitLabel="Save"
          // Fixed, and shown as context when there is anyone else it could have been. The
          // submission type carries no owner at all.
          ownership="fixed"
          {...(severalOwners ? { owner: { name: owner.name, isPrimary: isPrimaryOwner } } : {})}
          onSubmit={onSaveEdit}
          onCancel={onCancel}
        />
      )}
    </li>
  );
}
