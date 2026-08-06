/** Partner joins the household — a RelationshipEvent. */

import { useState } from "react";
import { AGE_LIMITS, isPreExisting, MAX_AGE, MAX_LIVED_AGE, type RelationshipEvent } from "@finley/engine";
import {
  elapsedYears,
  monthOfElapsedYears,
  MonthSelect,
  type EditProps,
  type FormProps,
} from "./formControls";
import { blankJobDraft, jobInputFromDraft, yearOfMonth, type JobEditDraft } from "../../planPeople";
import { START_YEAR } from "../../config";
import { NumInput } from "../numInput/numInput";
import { formatDollars } from "../../format";
import { JobForm } from "../jobsPanel/jobForm";

/** A generic-adult starting point, until the user says otherwise. */
const PARTNER_DEFAULT_AGE = 40;

/**
 * What the life-expectancy field opens on. A visible, editable starting point — NOT a fallback:
 * the engine requires a partner's own expectancy and never substitutes the primary's, so the
 * number has to be one the user can see and change, exactly like {@link PARTNER_DEFAULT_AGE}.
 */
const PARTNER_DEFAULT_LIFE_EXPECTANCY = 90;

/** The form's live state — one draft, not a hook per field. */
interface RelationshipDraft {
  readonly month: number;
  readonly name: string;
  /**
   * The partner's age in the {@link ageYearOf} reference year — the moment this form describes,
   * so the age the user has in mind ("they'll be 45 when we marry"; for a partner already here,
   * how old they are today). A birth year would make them do the arithmetic.
   */
  readonly age: number;
  /**
   * The age they are projected to live to — THEIRS, never the household's. The projection runs to
   * the longest-lived member, so a partner younger than the primary is what extends it.
   */
  readonly lifeExpectancy: number;
  /** The age their government benefit begins, 62–70. */
  readonly claimingAge: number;
  /** Jobs authored for the partner, in the terms the Jobs form speaks (ages + dollars). */
  readonly jobs: readonly JobEditDraft[];
}

/**
 * The year the age field speaks in. A partner still to come is described by the moment they
 * arrive, so it is the join year. One already in the household (an ANCHOR, dated at the true
 * past month they got together) is described as they are NOW — "their age today", the term the
 * Starting position form collected — so their age must not restate itself when the anniversary
 * moves, which is what reading it against the join year would do.
 */
const ageYearOf = (month: number): number => (isPreExisting(month) ? START_YEAR : yearOfMonth(month));

/**
 * Seed an edit from the partner already on the timeline. Their birth year becomes the age in
 * {@link ageYearOf}'s year — the term this form collects — so a correction is made in the same
 * vocabulary the partner was authored in. Jobs are not carried: a `marry` revision cannot touch
 * them (they are edited in the Jobs panel), so the draft starts them empty and the form hides
 * the section.
 */
function draftFromEvent(event: RelationshipEvent): RelationshipDraft {
  const { month, person } = event;
  return {
    month,
    name: person.name,
    age: ageYearOf(month) - person.birthYear,
    lifeExpectancy: person.lifeExpectancy,
    claimingAge: person.benefitClaimingAge,
    jobs: [],
  };
}

export function RelationshipForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  edit,
}: FormProps & { edit?: EditProps<RelationshipEvent> }) {
  const [draft, setDraft] = useState<RelationshipDraft>(() =>
    edit
      ? draftFromEvent(edit.event)
      : {
          month: defaultMonth,
          name: "",
          age: PARTNER_DEFAULT_AGE,
          lifeExpectancy: PARTNER_DEFAULT_LIFE_EXPECTANCY,
          claimingAge: 67,
          jobs: [],
        },
  );
  const [addingJob, setAddingJob] = useState(false);
  const patch = (fields: Partial<RelationshipDraft>) => setDraft((d) => ({ ...d, ...fields }));

  const joinYear = yearOfMonth(draft.month);
  /**
   * An anchor: the partner is already in the household, so this form dates them the way the
   * Starting position form did — by how long you have been together — instead of by a year on
   * the plan's timeline, which cannot reach the past. Fixed for the life of the form; the fields
   * below never move an event across the boundary.
   */
  const anchored = edit !== undefined && isPreExisting(edit.event.month);
  /**
   * Their birth year — what the engine reasons in. Derived from the age in the year that age was
   * given in, so moving a future wedding later keeps them the age entered and shifts the birth
   * year ("they'll be 45 when we marry"), while correcting how long an existing couple has been
   * together leaves their age today — and so their birth year — alone. Drives their whole arc:
   * when open-ended jobs stop, when Social Security starts, RMDs, and the ages their jobs
   * resolve against.
   */
  const ageYear = anchored ? START_YEAR : joinYear;
  const partnerBirthYear = ageYear - draft.age;

  function addJob(job: JobEditDraft) {
    setDraft((d) => ({ ...d, jobs: [...d.jobs, job] }));
    setAddingJob(false);
  }

  function removeJob(index: number) {
    setDraft((d) => ({ ...d, jobs: d.jobs.filter((_, i) => i !== index) }));
  }

  function submit() {
    // A revision names only the person's own fields; the `marry` verb and revision share them,
    // so the same draft feeds both paths. Jobs are absent from the revision — the engine keeps
    // the partner's existing list untouched, and the Jobs panel is where they change.
    if (edit) {
      edit.onRevise((p) =>
        p.reviseTransaction(edit.event.id, {
          type: "marry",
          month: draft.month,
          name: draft.name || "Partner",
          birthYear: partnerBirthYear,
          lifeExpectancy: draft.lifeExpectancy,
          benefitClaimingAge: draft.claimingAge,
        }),
      );
      return;
    }
    // `marry` mints the partner's person id and every job id, and stamps each job's owner to
    // that person — so the form hands over jobs as inputs, scoped only by the partner's birth
    // year, and invents no id of its own. Their jobs drive earned income, 401(k) deferral, and
    // covered earnings just as the primary earner's do.
    onAdd((p) =>
      p.marry({
        month: draft.month,
        name: draft.name || "Partner",
        birthYear: partnerBirthYear,
        lifeExpectancy: draft.lifeExpectancy,
        benefitClaimingAge: draft.claimingAge,
        jobs: draft.jobs.map((job) => jobInputFromDraft(partnerBirthYear, job)),
      }),
    );
  }

  return (
    <>
      {/* The same question the Starting position form asked, so a correction is made in the
          vocabulary the partnering was authored in — and the true past month it sits on stays
          reachable, which a picker spanning only the plan's own years never made it. Kept
          positive: a partnering already behind us is what this branch is for. */}
      {anchored ? (
        <NumInput
          label="Together for"
          value={elapsedYears(draft.month)}
          onChange={(years) => patch({ month: monthOfElapsedYears(years) })}
          suffix="yr"
          min={1}
          max={70}
        />
      ) : (
        <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      )}
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

      {/* Read against the join year so there is nothing to infer: at month 0 that year IS now.
          A partner already in the household is instead read against today — they are here, so
          "their age today" is the fact the user holds. */}
      <NumInput
        label={anchored ? "Their age today" : `Their age in ${joinYear}`}
        value={draft.age}
        onChange={(age) => patch({ age })}
        min={18}
        max={MAX_LIVED_AGE}
        step={1}
      />

      {/* The same job model and form the primary earner uses, scoped to the partner. Hidden
          when editing: a `marry` revision cannot rewrite the job list, so authoring here would
          silently do nothing — their jobs are edited in the Jobs panel instead. */}
      {edit ? (
        <p className="hint">Edit this partner’s jobs in the Jobs &amp; income panel below.</p>
      ) : (
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
            // Scoped to the partner: there is no ownership question to ask here — `marry`
            // stamps every one of these jobs onto the person it mints — and the ages are
            // theirs. Seeded at the join age, so a fresh job starts the year they arrive.
            ownership="fixed"
            initial={blankJobDraft(draft.age)}
            // Their age when they join, which is "now" for every age this form collects — a
            // partner's job is authored in the terms of the moment they arrive.
            currentAge={draft.age}
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
      )}

      {/* Labelled "Their …" because the primary earner's versions are on screen at the same
          time, in the Budget editor. */}
      <details className="advanced">
        <summary>Advanced</summary>
        {/* No "their retirement age" here. Each job they hold says when it ends, so a second
            age that also ended their jobs could only ever contradict one of them. */}
        {/* Their own expectancy, not the household's — the run reaches the longest-lived
            member, so a younger partner extends it and nothing infers that for them. */}
        <NumInput
          label="Their life expectancy"
          value={draft.lifeExpectancy}
          onChange={(lifeExpectancy) => patch({ lifeExpectancy })}
          min={Math.max(60, draft.age)}
          max={MAX_AGE}
          step={1}
        />
        {/* Their benefit rides their own covered earnings, so it begins on their clock, not
            the household's. */}
        <NumInput
          label="Their Social Security claiming age"
          value={draft.claimingAge}
          onChange={(claimingAge) => patch({ claimingAge })}
          min={62}
          max={AGE_LIMITS.benefitClaimingAge}
          step={1}
        />
        <p className="hint">
          Each job above runs to the end date you gave it, and their benefit begins at their
          claiming age (claim earlier for a smaller monthly check, later for a larger one).
          Estimate, not advice.
        </p>
      </details>

      <button className="btn primary" onClick={submit}>
        {edit ? "Save changes" : "Add event"}
      </button>
    </>
  );
}
