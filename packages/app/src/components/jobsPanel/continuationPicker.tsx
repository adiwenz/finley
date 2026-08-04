/**
 * **"Which job should Finley model as continuing beyond its planned end?"** — one member's
 * continuation job, authored beside their jobs rather than inside any of them.
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

import type { Job, JobId, PersonId } from "@finley/engine";

/** One member and the jobs the question is about — a narrow slice of `JobOwner`. */
export interface ContinuationOwner {
  readonly id: PersonId;
  readonly name: string;
  readonly jobs: readonly Job[];
}

/** The `<option>` value standing for "None" — `null` cannot ride a DOM value attribute. */
const NONE = "";

export function ContinuationPicker({
  owner,
  selected,
  jobTitleOf,
  nowYear,
  severalOwners,
  onChange,
}: {
  owner: ContinuationOwner;
  /**
   * The job the SOLVER would continue — `Projection.continuationJobOf`, already resolved.
   *
   * Resolved by the engine rather than here, because a member who has never answered still has
   * a continuation job and the control has to show THAT: a blank "None" would misreport the
   * assumption their retirement age was actually computed under. Taking it as a prop keeps the
   * one rule in one place, where the solve reads it.
   */
  selected: JobId | null;
  /** How this panel names a job — the same title its card carries, so the two agree. */
  jobTitleOf: (job: Job) => string;
  /** The calendar year of month 0, which is what "a job you are working now" is read against. */
  nowYear: number;
  /** Whether to qualify the question with whose it is. */
  severalOwners: boolean;
  onChange: (jobId: JobId | null) => void;
}) {
  const label = severalOwners
    ? `Which of ${owner.name}\u2019s jobs should Finley model as continuing beyond its planned end?`
    : "Which job should Finley model as continuing beyond its planned end?";
  // A job whose authored end is already behind us. Selecting one is a counterfactual — it never
  // ended — rather than a plan to take it up again, and that is worth saying outright, because
  // it is the one selection whose meaning a reader is likely to guess wrong.
  const selectedIsCompleted =
    selected !== null && (owner.jobs.find((j) => j.id === selected)?.endYear ?? Infinity) <= nowYear;

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        value={selected ?? NONE}
        onChange={(e) => onChange(e.target.value === NONE ? null : e.target.value)}
      >
        <option value={NONE}>None — do not assume additional work</option>
        {/* Every job, including ones already finished: whether that work could have carried on
            is knowledge the plan does not have, so it is offered rather than assumed. The
            engine never selects one for them, but it is theirs to pick. */}
        {owner.jobs.map((job) => (
          <option key={job.id} value={job.id}>
            {jobTitleOf(job)}
          </option>
        ))}
      </select>
      <p className="hint">
        Finley will extend this job continuously through the tested stop-working date. Other jobs
        keep their planned dates, so jobs may overlap.
      </p>
      {selectedIsCompleted && (
        <p className="hint">
          Selecting this job models what would have happened if it had continued without ending.
        </p>
      )}
    </label>
  );
}
