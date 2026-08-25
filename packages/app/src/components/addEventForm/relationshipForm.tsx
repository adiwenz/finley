/** Partner joins the household — a RelationshipEvent. */

import { useMemo, useState } from "react";
import {
  AGE_LIMITS,
  isPreExisting,
  MAX_AGE,
  MAX_LIVED_AGE,
  minLifeExpectancyFor,
  dollarsToCents,
  centsToDollars,
  type Projection,
  type ProjectionResult,
  type RelationshipEvent,
} from "@finley/engine";
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
import { DEFAULT_PARTNER_SHARE_PERCENT, SharedSplitFields } from "./sharedSplitFields";

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
  /**
   * The money they bring, in DOLLARS — the form's unit; the engine is told cents. Their own
   * accounts, never merged into the primary's: they fund the household while the couple is
   * together and leave with them at separation.
   */
  readonly savings: number;
  readonly retirement: number;
  readonly brokerage: number;
  /** Their share of shared household spending, 0–100. The primary carries the rest. */
  readonly sharePercent: number;
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
    savings: centsToDollars(event.accounts?.savingsBalanceCents ?? 0),
    retirement: centsToDollars(event.accounts?.retirementBalanceCents ?? 0),
    brokerage: centsToDollars(event.accounts?.brokerageBalanceCents ?? 0),
    // Absent on the event means the default, which is also what a partnership authored before
    // the split existed means — so an old scenario edits as 50/50 rather than as a blank.
    sharePercent: event.partnerSharePercent ?? DEFAULT_PARTNER_SHARE_PERCENT,
  };
}

export function RelationshipForm({
  result,
  defaultMonth,
  horizonMonths,
  onAdd,
  edit,
}: FormProps & { result: ProjectionResult; edit?: EditProps<RelationshipEvent> }) {
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
          savings: 0,
          retirement: 0,
          brokerage: 0,
          sharePercent: DEFAULT_PARTNER_SHARE_PERCENT,
        },
  );
  const [addingJob, setAddingJob] = useState(false);
  /**
   * The split is mid-retype, so the form is not showing one. Saving here would write the
   * percentage the emptied field is in the middle of replacing — a figure nobody is looking at.
   */
  const [splitIncomplete, setSplitIncomplete] = useState(false);
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

  /** Whoever is never a partner — the household's own person, who carries the remainder. */
  const primaryName = result.household.memberships[0]?.person.name ?? "You";
  /**
   * Why this partnership cannot be written, if it cannot — the engine's own span overlap, asked
   * before the click instead of after it. The household may only ever be in one partnership at a
   * time, and the question is a SPAN rather than a date: a partnering authored in Year 6 with a
   * partner already booked for Year 7 would still be running when they arrive, so a date nobody
   * else occupies is not on its own enough.
   *
   * Recomputed from the whole draft, so it answers again when the month moves, when the partner's
   * expectancy changes the span's far end, and when a separation elsewhere on the timeline opens
   * or closes the gap. A revision never conflicts with the partnership it is revising — the id
   * below is what excludes it.
   *
   * The engine refuses this regardless; blocking here only spares the user a click that could
   * only fail.
   */
  const rawConflict = result.partnershipConflict({
    month: draft.month,
    person: {
      name: draft.name || "Partner",
      birthYear: partnerBirthYear,
      lifeExpectancy: draft.lifeExpectancy,
      ...(edit ? { id: edit.event.person.id } : {}),
    },
  });
  // One text node, not three: the engine composes the clause mid-sentence, and splicing the
  // capital in as its own child would break the sentence across elements for anything reading it.
  const conflictReason =
    rawConflict === null ? null : `${rawConflict.charAt(0).toUpperCase()}${rawConflict.slice(1)}.`;

  function addJob(job: JobEditDraft) {
    setDraft((d) => ({ ...d, jobs: [...d.jobs, job] }));
    setAddingJob(false);
  }

  function removeJob(index: number) {
    setDraft((d) => ({ ...d, jobs: d.jobs.filter((_, i) => i !== index) }));
  }

  /**
   * The revision this form would write. Named rather than inlined at the click, because the same
   * write is what the dry run below asks the engine about — a Save that is offered and a Save that
   * is refused must be the same edit, or the button would promise something else.
   */
  const revise = (p: Projection): void => {
    if (edit === undefined) return;
    p.reviseTransaction(edit.event.id, {
      type: "marry",
      month: draft.month,
      name: draft.name || "Partner",
      birthYear: partnerBirthYear,
      lifeExpectancy: draft.lifeExpectancy,
      benefitClaimingAge: draft.claimingAge,
      // Balances only — the rates the event already carries are the household's own.
      accountBalances: {
        savingsBalanceCents: dollarsToCents(draft.savings),
        retirementBalanceCents: dollarsToCents(draft.retirement),
        brokerageBalanceCents: dollarsToCents(draft.brokerage),
      },
      partnerSharePercent: draft.sharePercent,
    });
  };

  /**
   * Why this correction would be refused, if it would be — everything the engine checks that this
   * form does not, asked before the click.
   *
   * A partner's life expectancy is the field that needed it: shortening it below the end of a job
   * they already hold is refused (a job must end while its owner is alive), and the click did
   * nothing a reader could connect to the number they had just typed — the panel stayed open on
   * the value they entered, and the reason appeared as a banner in the other column. The engine's
   * own sentence names the year, the job and the person, so it is shown verbatim on the control it
   * belongs to.
   *
   * Editing only. A new partnering has no event to revise, and its own overlap check is
   * `partnershipConflict` above.
   */
  const reviseConflict = useMemo(
    () => (edit?.conflictOf === undefined ? null : edit.conflictOf(revise)),
    // Every field of the draft feeds the revision, so the answer is re-asked whenever any of
    // them moves — which is exactly when it can change.
    [edit, draft, partnerBirthYear],
  );

  /**
   * The one thing standing in the way, if anything is. Overlap first: it is the more specific
   * answer, and it is the only one a form that is ADDING can give.
   */
  const blockedReason = conflictReason ?? reviseConflict;

  function submit() {
    // A revision names only the person's own fields; the `marry` verb and revision share them,
    // so the same draft feeds both paths. Jobs are absent from the revision — the engine keeps
    // the partner's existing list untouched, and the Jobs panel is where they change.
    if (edit) {
      edit.onRevise(revise);
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
        accounts: {
          savingsBalanceCents: dollarsToCents(draft.savings),
          retirementBalanceCents: dollarsToCents(draft.retirement),
          brokerageBalanceCents: dollarsToCents(draft.brokerage),
        },
        partnerSharePercent: draft.sharePercent,
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

      <SharedSplitFields
        primaryName={primaryName}
        partnerName={draft.name}
        partnerPercent={draft.sharePercent}
        onChange={(sharePercent) => patch({ sharePercent })}
        onIncompleteChange={setSplitIncomplete}
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
            // The expectancy being authored in this very form, so the job's end age follows the
            // partner's own life as it is typed — the engine bounds it by that, not the primary's.
            lifeExpectancy={draft.lifeExpectancy}
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
          // Their own age, plus one — the engine's floor and nothing else. It used to carry a
          // `Math.max(60, …)`, which snapped a 40-year-old partner's expectancy to 60 (an age
          // nobody typed), and `draft.age` unfloored would have committed the one value the
          // engine refuses outright.
          min={minLifeExpectancyFor(draft.age)}
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

      <details className="collapsible">
        <summary>
          <h4>What they bring</h4>
        </summary>
        {/* No return-rate fields: their accounts grow at the household's own plan rates. One
            market assumption for the household, not a second set to keep in step with it. */}
        <NumInput
          label="Their cash savings"
          value={draft.savings}
          onChange={(savings) => patch({ savings })}
          prefix="$"
          step={1_000}
          min={0}
        />
        <NumInput
          label="Their retirement account"
          value={draft.retirement}
          onChange={(retirement) => patch({ retirement })}
          prefix="$"
          step={1_000}
          min={0}
        />
        <NumInput
          label="Their brokerage"
          value={draft.brokerage}
          onChange={(brokerage) => patch({ brokerage })}
          prefix="$"
          step={1_000}
          min={0}
        />
        <p className="hint">
          Their accounts stay theirs. While you are together they count toward household net worth
          and can fund household spending; at separation they leave with them.
        </p>
      </details>

      {blockedReason !== null && (
        <p className="hint warn" role="status">
          {blockedReason}
        </p>
      )}
      <button
        className="btn primary"
        disabled={blockedReason !== null || splitIncomplete}
        onClick={submit}
      >
        {edit ? "Save changes" : "Add event"}
      </button>
    </>
  );
}
