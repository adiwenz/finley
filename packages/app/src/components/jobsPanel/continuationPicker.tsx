/**
 * **"If you needed to work longer, which job would continue?"** — one member's continuation job,
 * authored beside their jobs rather than inside any of them.
 *
 * Per PERSON, not per job, because that is the shape of the question: several jobs cannot each
 * be the one you would continue. It was per job once — a checkbox reading "solver may extend this
 * job" — and the engine was then left picking between whichever ones said yes, which is the same
 * date-based guess the checkbox existed to remove, only one step further back.
 *
 * It authors NOTHING about the projection. The plan is paid over exactly the years each job was
 * given whatever is selected here; this is read only when the plan is asked "when could you stop
 * working?", and by the preview that shows what that answer assumed.
 */

import { resolveContinuationJobId, type Job, type JobId, type PersonId } from "@finley/engine";

/** One member's jobs and their stated choice — a narrow slice of `JobOwner`. */
export interface ContinuationOwner {
  readonly id: PersonId;
  readonly name: string;
  readonly jobs: readonly Job[];
  /** As STATED: `undefined` until they have answered. See {@link resolveContinuationJobId}. */
  readonly continuationJobId?: JobId | null;
}

/** The `<option>` value standing for "None" — `null` cannot ride a DOM value attribute. */
const NONE = "";

export function ContinuationPicker({
  owner,
  jobTitleOf,
  nowYear,
  severalOwners,
  onChange,
}: {
  owner: ContinuationOwner;
  /** How this panel names a job — the same title its card carries, so the two agree. */
  jobTitleOf: (job: Job) => string;
  /** The calendar year of month 0, which is what "a job you are working now" is read against. */
  nowYear: number;
  /** Whether to qualify the question with whose it is. */
  severalOwners: boolean;
  onChange: (jobId: JobId | null) => void;
}) {
  // The job the SOLVER would use, which is what the control must show: a household that has
  // never answered still has a continuation job, and hiding that behind a blank "None" would
  // misreport the assumption their retirement age was actually computed under.
  const selected = resolveContinuationJobId(owner.jobs, owner.continuationJobId, nowYear);
  const label = severalOwners
    ? `If ${owner.name} needed to work longer, which job would continue?`
    : "If you needed to work longer, which job would continue?";

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        value={selected ?? NONE}
        onChange={(e) => onChange(e.target.value === NONE ? null : e.target.value)}
      >
        <option value={NONE}>None (don’t assume additional work)</option>
        {/* Every job, including ones already finished: "I could go back to that" is knowledge
            the plan does not have, so it is offered rather than assumed. The initialization
            rule never selects one for them — see `resolveContinuationJobId`. */}
        {owner.jobs.map((job) => (
          <option key={job.id} value={job.id}>
            {jobTitleOf(job)}
          </option>
        ))}
      </select>
    </label>
  );
}
