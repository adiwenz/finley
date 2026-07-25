/** Partner joins the household — a RelationshipEvent. */

import { useState } from "react";
import { MonthSelect, type FormProps } from "./formControls";
import { blankJobDraftFor, buildJobFromDraft, yearOfMonth, type JobDraft } from "../../planPeople";
import { NumInput } from "../numInput/numInput";
import { formatDollars } from "../../format";
import { JobForm } from "../jobsPanel/jobForm";

/** A generic-adult starting point for the partner's age, until the user says otherwise. */
const PARTNER_DEFAULT_AGE = 40;

/** The form's live state — one draft, not a hook per field. Carries the partner's own jobs (§8, issue #118). */
interface RelationshipDraft {
  readonly month: number;
  readonly name: string;
  /**
   * The partner's age **in the year they join** — the moment this form describes, so it
   * is the age the user actually has in mind ("they'll be 45 when we marry"). A birth
   * year would make them do the arithmetic, and every other age in the app (yours, a
   * retirement age, a job's start age) is an age too.
   */
  readonly age: number;
  /** The age their open-ended jobs stop (§5) — their own, not the household's. */
  readonly retirementAge: number;
  /** The age their government benefit begins (§5.4), 62–70. */
  readonly claimingAge: number;
  /** Jobs authored for the partner, in the terms the Jobs form speaks (ages + dollars). */
  readonly jobs: readonly JobDraft[];
}

export function RelationshipForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [draft, setDraft] = useState<RelationshipDraft>(() => ({
    month: defaultMonth,
    name: "",
    age: PARTNER_DEFAULT_AGE,
    retirementAge: 65,
    claimingAge: 67,
    jobs: [],
  }));
  const [addingJob, setAddingJob] = useState(false);
  const patch = (fields: Partial<RelationshipDraft>) => setDraft((d) => ({ ...d, ...fields }));

  const partnerId = `p-${nextId}`;
  const joinYear = yearOfMonth(draft.month);
  /**
   * Their birth year — what the engine actually reasons in. Derived from the age at the
   * join year, so moving the wedding later keeps them the age the user entered and
   * shifts the birth year, which is what "they'll be 45 when we marry" means. It drives
   * their whole arc: when their open-ended jobs stop (birthYear + retirement age), when
   * their Social Security starts (birthYear + claiming age), their RMDs, and the ages
   * their authored jobs resolve against. A hardcoded 40 put every partner's benefit in
   * the same calendar year whoever they were.
   */
  const partnerBirthYear = joinYear - draft.age;

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
        retirementTargetAge: draft.retirementAge,
        benefitClaimingAge: draft.claimingAge,
        jobs: draft.jobs.map((job, i) =>
          buildJobFromDraft(`${partnerId}-job-${i + 1}`, partnerBirthYear, job),
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

      {/* Their age, anchored to the year they join so there is nothing to infer: at
          month 0 that year IS now. Drives their retirement, benefit, and job ages. */}
      <NumInput
        label={`Their age in ${joinYear}`}
        value={draft.age}
        onChange={(age) => patch({ age })}
        min={18}
        max={100}
        step={1}
      />

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
            // Scoped to the partner: no picker here (they are the only owner in this
            // form), and the ages are theirs. Once they have joined, the Jobs panel
            // lists these alongside everyone else's and can reassign them (#118).
            // Seeded at the age they join, so a fresh job starts the year they arrive.
            initial={blankJobDraftFor(partnerId, draft.age)}
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

      {/* §10.4: their two life-stage ages sit behind a disclosure — both have sensible
          defaults, and a partner who retires and claims like anyone else needs neither.
          Labelled "Their …" because the primary earner's own versions of both are on
          screen at the same time, in the Budget editor. */}
      <details className="advanced">
        <summary>Advanced</summary>
        {/* Not chained to their current age, unlike the primary earner's: a partner who
            has ALREADY retired is a real thing to author (no earned income, a benefit at
            their claiming age), and the household's own retirement age has no say over
            when they stopped working. */}
        <NumInput
          label="Their retirement age"
          value={draft.retirementAge}
          onChange={(retirementAge) => patch({ retirementAge })}
          min={40}
          max={80}
          step={1}
        />
        {/* §5.4: the pinned claiming age (62–70), theirs to set — their benefit rides
            their own covered earnings, so it begins on their clock, not the household's. */}
        <NumInput
          label="Their Social Security claiming age"
          value={draft.claimingAge}
          onChange={(claimingAge) => patch({ claimingAge })}
          min={62}
          max={70}
          step={1}
        />
        <p className="hint">
          Their open-ended jobs run until their retirement age, and their benefit begins at
          their claiming age (claim earlier for a smaller monthly check, later for a larger
          one). Estimate, not advice.
        </p>
      </details>

      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
