/** Partner joins the household — a RelationshipEvent. */

import { useState } from "react";
import { MonthSelect, type FormProps } from "./formControls";
import { START_YEAR } from "../../config";
import { blankJobDraftForAge, buildJobFromDraft, type JobDraft } from "../../planPeople";
import { formatDollars } from "../../format";
import { JobForm } from "../jobsPanel/jobForm";

/**
 * A generic-adult placeholder age for the partner (§8): drives the age display, and —
 * since the Jobs form speaks in ages — the birth year the partner's authored job spans
 * resolve against. The retirement/benefit inputs still take sensible defaults.
 */
const PARTNER_DEFAULT_AGE = 40;

/** The form's live state — one draft, not a hook per field. Carries the partner's own jobs (§8, issue #118). */
interface RelationshipDraft {
  readonly month: number;
  readonly name: string;
  /** Jobs authored for the partner, in the terms the Jobs form speaks (ages + dollars). */
  readonly jobs: readonly JobDraft[];
}

export function RelationshipForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [draft, setDraft] = useState<RelationshipDraft>(() => ({
    month: defaultMonth,
    name: "",
    jobs: [],
  }));
  const [addingJob, setAddingJob] = useState(false);
  const patch = (fields: Partial<RelationshipDraft>) => setDraft((d) => ({ ...d, ...fields }));

  const partnerId = `p-${nextId}`;
  const partnerBirthYear = START_YEAR - PARTNER_DEFAULT_AGE;

  function addJob(job: JobDraft) {
    setDraft((d) => ({ ...d, jobs: [...d.jobs, job] }));
    setAddingJob(false);
  }

  function removeJob(index: number) {
    setDraft((d) => ({ ...d, jobs: d.jobs.filter((_, i) => i !== index) }));
  }

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "RelationshipEvent",
      month: draft.month,
      // Authoring Person (§8): the partner joins with the name and any jobs the user
      // authored. Their jobs — scoped to the partner as owner — drive their earned
      // income, 401(k) deferral, and Social-Security-covered earnings exactly as the
      // primary earner's do (issue #118). With no jobs the partner joins as before.
      person: {
        id: partnerId,
        name: draft.name || "Partner",
        birthYear: partnerBirthYear,
        retirementTargetAge: 65,
        benefitClaimingAge: 67,
        jobs: draft.jobs.map((job, i) =>
          buildJobFromDraft(`${partnerId}-job-${i + 1}`, partnerId, partnerBirthYear, job),
        ),
      },
    });
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="text-input"
          type="text"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="Partner's name"
        />
      </label>

      {/* The partner's own jobs (issue #118) — the same job model and form the primary
          earner uses, scoped to the partner. Authored up front; a partner with none
          joins exactly as before. */}
      <div className="field">
        <span className="field-label">Jobs (optional)</span>
        {draft.jobs.length === 0 ? (
          <p className="hint">No jobs — the partner joins with no earned income of their own.</p>
        ) : (
          <ul>
            {draft.jobs.map((job, i) => {
              const label = job.name?.trim() || `Job ${i + 1}`;
              return (
                <li key={i} aria-label={label}>
                  <span>
                    {label} · {formatDollars(job.monthlyCents)}/mo
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove job ${i + 1}`}
                    onClick={() => removeJob(i)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {addingJob ? (
          <JobForm
            initial={blankJobDraftForAge(PARTNER_DEFAULT_AGE)}
            submitLabel="Add"
            onSubmit={addJob}
            onCancel={() => setAddingJob(false)}
          />
        ) : (
          <button type="button" className="btn" onClick={() => setAddingJob(true)}>
            + Add a job
          </button>
        )}
      </div>

      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
