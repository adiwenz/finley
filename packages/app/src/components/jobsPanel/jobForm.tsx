/**
 * Add/edit surface for one job on the value-editing plane: a direct edit to `plan.jobs`,
 * never a timeline event. Speaks the user's terms (monthly salary, start age, whether it
 * runs to retirement) and folds them into a draft on submit. 401(k) deferral and
 * above-inflation raises hide behind an "Advanced" details, like the account-return knobs in
 * the Budget editor. One set of fields backs every caller — `initial` seeds them.
 *
 * What differs between callers is only whether *whose job* is still an open question, and that
 * is the prop union below: `ownership: "choose"` submits a {@link NewJobDraft}, `"fixed"` a
 * {@link JobEditDraft} that has no owner field to carry a different answer in. The guarantee is
 * a type, not a hidden input — an edit handler typed to take `JobEditDraft` cannot be handed an
 * owner even by a caller that means to.
 */

import { useState } from "react";
import { MAX_LIVED_AGE } from "@finley/engine";
import type { PersonId } from "@finley/engine";
import type { JobEditDraft, NewJobDraft } from "../../planPeople";
import { NumInput } from "../numInput/numInput";
import styles from "./jobsPanel.module.css";

/** A household member this job could belong to — the owner picker's options. */
export interface JobFormOwner {
  readonly id: PersonId;
  readonly name: string;
  /**
   * Their age now. Every age in this form is the selected owner's, so picking a different one
   * re-reads whether the job has a past — a start age of 30 is history for a 41-year-old and
   * the future for a 25-year-old, and the salary fields follow.
   */
  readonly currentAge: number;
  /** Their own expectancy, which is where this form's ages stop — see {@link JobFormCommon}. */
  readonly lifeExpectancy: number;
}

interface JobFormCommon {
  /**
   * The owner's age now — where "now" falls on the ages this form collects. With a picker on
   * screen the selected owner's own age wins; this is the age of the owner the form opened on.
   */
  currentAge: number;
  /**
   * The owner's own life expectancy — the ceiling on this form's ages, for the same reason the
   * Budget editor chains current age below it: **a job must be worked while its owner is alive**,
   * so the engine refuses one ending past their death, and a field that let a higher age through
   * would commit a value the very next write rejected. The form would then close on an edit that
   * never landed, which reads as nothing having happened at all.
   *
   * An end AT this age is allowed and is the point of stating it as the ceiling rather than one
   * below: `endAge` is exclusive, so a job ending at the expectancy is worked to the last month
   * lived — "I'll work as long as I can", which must stay writable.
   */
  lifeExpectancy: number;
  /** Verb shown on the primary button and used to label the form ("Add" / "Save"). */
  submitLabel: string;
  onCancel: () => void;
}

/**
 * Creating a job, with whose it is still to settle. A second earner discloses a picker; with
 * only the primary person there is nothing to pick and none shows, but the answer still rides
 * out on the draft.
 */
interface ChooseOwnerProps extends JobFormCommon {
  ownership: "choose";
  initial: NewJobDraft;
  /** The members this job could be created for. */
  owners: readonly JobFormOwner[];
  onSubmit: (draft: NewJobDraft) => void;
}

/**
 * A form with no ownership question to ask: editing an existing job, whose owner is settled and
 * unchangeable, or authoring a partner's own jobs inside the event that brings them in, where
 * they are the only person the form could mean.
 *
 * `owner` is context, not an input — it names whose ages these are, and is absent when there is
 * only one person in view.
 */
interface FixedOwnerProps extends JobFormCommon {
  ownership: "fixed";
  initial: JobEditDraft;
  /** Whose job this is, when the household holds more than one earner; else absent. */
  owner?: { readonly name: string; readonly isPrimary: boolean };
  onSubmit: (draft: JobEditDraft) => void;
}

type JobFormProps = ChooseOwnerProps | FixedOwnerProps;

/**
 * The form's live state in the fields' own terms — one object, not a hook per field. Salary is
 * held in whole dollars (the unit the input edits) and converted to cents on submit.
 */
interface JobFormDraft {
  readonly name: string;
  /** Pay a month at month 0 — what the projection starts from. */
  readonly monthlyDollars: number;
  /** Pay a month in the job's own start year — what the historical reconstruction starts from. */
  readonly startingMonthlyDollars: number;
  readonly startAge: number;
  /** When the job ends. Always a number: a job that does not say when it ends cannot be authored. */
  readonly endAge: number;
  readonly deferralPct: number;
  /** Employer match as a whole-number percent OF the deferral; only bites when there's one. */
  readonly employerMatchPct: number;
  readonly realGrowthPct: number;
}

/** Hoisted so the no-picker case reuses one array instead of minting one per render. */
const NO_OWNERS: readonly JobFormOwner[] = [];

export function JobForm(props: JobFormProps) {
  const { initial, currentAge, lifeExpectancy, submitLabel, onCancel } = props;
  const [draft, setDraft] = useState<JobFormDraft>(() => ({
    name: initial.name,
    monthlyDollars: Math.round(initial.monthlyCents / 100),
    startingMonthlyDollars: Math.round(initial.startingMonthlyCents / 100),
    startAge: initial.startAge,
    endAge: initial.endAge,
    deferralPct: initial.deferralPct,
    employerMatchPct: initial.employerMatchPct,
    realGrowthPct: initial.realGrowthPct,
  }));

  // Whose job this WILL be, while that is still open. Held apart from the field draft because
  // it is not a field: the "fixed" form has no such state, and its submission has no such key.
  const [ownerId, setOwnerId] = useState<PersonId | null>(
    props.ownership === "choose" ? props.initial.ownerId : null,
  );

  const patch = (fields: Partial<JobFormDraft>) => setDraft((d) => ({ ...d, ...fields }));


  const pickableOwners = props.ownership === "choose" ? props.owners : NO_OWNERS;
  const picked = pickableOwners.find((o) => o.id === ownerId);
  /**
   * Name to phrase the age copy in when the job belongs to someone other than the primary
   * person (always first in the list) — "their Social-Security-covered years", not "yours".
   * `null` means the job is the user's own, or that there is nobody else it could be.
   */
  const otherOwnerName =
    props.ownership === "choose"
      ? (pickableOwners.length > 1 && ownerId !== pickableOwners[0].id ? (picked?.name ?? null) : null)
      : (props.owner !== undefined && !props.owner.isPrimary ? props.owner.name : null);

  // The ages here are the owner's, so picking a different one while creating re-reads the whole
  // form against the new clock before anything is submitted.
  const ownerAge = picked?.currentAge ?? currentAge;
  /**
   * Where this owner's ages stop. Picked up from the selected owner for the same reason
   * {@link ownerAge} is: a partner ten years younger with a shorter expectancy has a different
   * ceiling, and the job being authored is theirs the moment the picker says so.
   */
  const ownerLifeExpectancy = picked?.lifeExpectancy ?? lifeExpectancy;
  /**
   * The last age a job may still START at — a job needs a month to be worked in AND a later end,
   * so it stops one below the end's own ceiling.
   */
  const maxStartAge = Math.min(MAX_LIVED_AGE, ownerLifeExpectancy - 1);
  /** The job is already under way, so what it paid on day one is a separate fact from today's pay. */
  const hasHistory = draft.startAge < ownerAge;
  /**
   * The whole job is behind us. It has no pay "now" — `compileJobIncome` drops a wholly-past
   * job before the current-salary anchor is ever read — so the form does not ask for one, and
   * {@link jobInputFromDraft} / {@link applyJobDraft} pin the dead anchor to what it last paid.
   */
  const endedBeforeNow = draft.endAge <= ownerAge;

  function submit() {
    const fields: JobEditDraft = {
      name: draft.name,
      monthlyCents: Math.round(draft.monthlyDollars * 100),
      // A job with no past states ONE salary, so the two anchors go out equal — "it pays X"
      // means a flat history, and the deviations from that are what a pay change is for. Once
      // the job has a past, the two fields are on screen and neither is derived.
      startingMonthlyCents: Math.round(
        (hasHistory ? draft.startingMonthlyDollars : draft.monthlyDollars) * 100,
      ),
      startAge: Math.min(draft.startAge, maxStartAge),
      // Bounded at both ends, and in this order: after the start, and not past the death. The
      // fields already clamp on commit, so this is the guard against a draft assembled around
      // them — an owner picked after the ages were typed, whose own expectancy is lower.
      endAge: Math.min(
        Math.max(Math.min(draft.startAge, maxStartAge) + 1, draft.endAge),
        ownerLifeExpectancy,
      ),
      realGrowthPct: draft.realGrowthPct,
      deferralPct: draft.deferralPct,
      employerMatchPct: draft.employerMatchPct,
    };
    // The one place the two submissions differ. `ownerId` is reachable only down this branch,
    // where the handler is typed to receive it.
    // `?? props.initial.ownerId` is total, not a fallback: this branch seeded the state from
    // that very field, so it is null only in the branch that never reads it.
    if (props.ownership === "choose")
      props.onSubmit({ ...fields, ownerId: ownerId ?? props.initial.ownerId });
    else props.onSubmit(fields);
  }

  return (
    <form
      className={styles.form}
      aria-label={`${submitLabel} job`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* Shown only while creating, and only once the household holds a second earner: it
          settles whose job this will be. There is no counterpart while editing — see the prop
          union above. */}
      {props.ownership === "choose" && pickableOwners.length > 1 && (
        <label className="field">
          <span className="field-label">Whose job</span>
          <select
            value={ownerId ?? ""}
            onChange={(e) => {
              const newOwnerId = e.target.value;
              setOwnerId(newOwnerId);
              // Ages on this form are the selected owner's, so a new owner needs a new start
              // age or the old one silently becomes their history or their future — see the
              // module doc on `JobFormOwner.currentAge`.
              const newOwner = pickableOwners.find((o) => o.id === newOwnerId);
              if (newOwner !== undefined) patch({ startAge: newOwner.currentAge });
            }}
          >
            {pickableOwners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* The settled answer, shown where the picker would have been: whose ages these are is
          the one thing a reader needs from it, and stating it beats an inert disabled select
          that invites a click. Absent on a household with nobody else it could be. */}
      {props.ownership === "fixed" && props.owner !== undefined && (
        <p className="hint" data-testid="job-owner">
          <strong>{props.owner.name}’s job.</strong> A job stays with the person it was added
          for — every age below is theirs. To move it, delete it and add it to someone else.
        </p>
      )}
      {/* Blank leaves the job unnamed and reports fall back to its stable id, so a quick
          add is never forced to name it. */}
      <label className="field">
        <span className="field-label">Job name (optional)</span>
        <span className="field-input-wrap">
          <input
            type="text"
            value={draft.name}
            placeholder="e.g. Software Engineer"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </span>
      </label>
      {/* The two salary anchors, labelled by WHEN rather than by which field of the model they
          land on. Neither derives from the other: what a job paid on day one is not evidence
          about what it pays today, and de-growing today's pay to guess it would reapply the
          raises that figure already includes. A job with no past shows one field, because
          there is only one fact to state.
          step=1: salary is free-form dollars — a larger step makes HTML5 validity reject an
          off-step value (e.g. $5,250) on submit. */}
      {hasHistory && (
        <>
          <NumInput
            label={`Monthly salary when this job started (age ${draft.startAge})`}
            value={draft.startingMonthlyDollars}
            onChange={(v) => patch({ startingMonthlyDollars: v })}
            prefix="$"
            step={1}
            min={0}
          />
          {/* Says which money the figure is in, at the field that collects it. The engine takes
              it verbatim, so the only wrong answer here is one converted into today's dollars
              by a helpful user. */}
          <p className="hint">
            <strong>Enter the amount you were actually paid at the time.</strong> Finley stores
            your historical pay exactly as entered, and holds it there until you say otherwise.
            Inflation is only used for projections.
          </p>
        </>
      )}
      {endedBeforeNow ? (
        <p className="hint">
          {otherOwnerName === null
            ? `This job ended at age ${draft.endAge}, so it has no pay “now”. What it paid feeds your Social-Security-covered years and nothing else.`
            : `This job ended at ${otherOwnerName}’s age ${draft.endAge}, so it has no pay “now”. What it paid feeds their Social-Security-covered years and nothing else.`}
        </p>
      ) : (
        <NumInput
          label={hasHistory ? `Monthly salary now (age ${ownerAge})` : "Monthly salary"}
          value={draft.monthlyDollars}
          onChange={(v) => patch({ monthlyDollars: v })}
          prefix="$"
          step={1}
          min={0}
        />
      )}
      {/* Two things a reader can misread about the pay "now" field. With a past, that the two
          anchors differ is fine — neither is derived from the other. On someone else's job, that
          "now" is the projection's now and not the month they join: the salary path belongs to
          the employment, and membership decides only who is paid from it. Asking for pay at the
          join month instead would tie the anchor to the wedding date and leave a pre-join raise
          nothing to compose against. */}
      {!endedBeforeNow && (hasHistory || otherOwnerName !== null) && (
        <p className="hint">
          {hasHistory && (
            <>
              What it paid at the start feeds{" "}
              {otherOwnerName === null ? "your" : "their"} Social-Security-covered years; what it
              pays today is where the projection begins. A step between them is fine — it’s a
              fact you stated, not a mistake.{" "}
            </>
          )}
          {otherOwnerName !== null &&
            `Enter today’s pay even if ${otherOwnerName} hasn’t joined you yet. Finley follows the whole job, and pays your household from the month they arrive.`}
        </p>
      )}
      <NumInput
        label="Start age"
        value={draft.startAge}
        onChange={(v) => patch({ startAge: v })}
        min={14}
        max={maxStartAge}
        step={1}
      />
      {/* Required, like the start age. A job used to be allowed to leave this blank and be
          "open-ended", which meant it silently ended at whatever retirement age was authored
          elsewhere — a date the user never typed, on a form that showed no end at all.

          Its ceiling is the owner's own expectancy, not the engine's age limit: the job has to
          be worked while they are alive. See {@link JobFormCommon.lifeExpectancy}. */}
      <NumInput
        label="End age"
        value={draft.endAge}
        onChange={(v) => patch({ endAge: v })}
        min={draft.startAge + 1}
        max={ownerLifeExpectancy}
        step={1}
      />
      <p className="hint">
        {otherOwnerName === null
          ? "The age you began this job seeds your Social-Security-covered years. Estimate, not advice."
          : `These are ${otherOwnerName}’s ages. The age they began this job seeds their Social-Security-covered years. Estimate, not advice.`}
      </p>

      <details className="advanced">
        <summary>Advanced</summary>
        {/* Capped at 100% — you can't defer more than your whole paycheck. The annual
            DOLLAR elective limit is enforced by the engine instead: deferral past it is
            paid as taxable income, disclosed by the nudge on the Jobs panel. */}
        <NumInput
          label="401(k) contribution"
          value={draft.deferralPct}
          onChange={(v) => patch({ deferralPct: v })}
          suffix="%"
          min={0}
          max={100}
          step={1}
        />
        {/* A match OF the contribution (50% = 50¢ per employee dollar), so it does nothing at
            0% deferral. Capped at 200% — generous plans rarely exceed a dollar-for-dollar match,
            and employer money is free of the elective limit (the engine deposits it on top). */}
        <NumInput
          label="Employer match"
          value={draft.employerMatchPct}
          onChange={(v) => patch({ employerMatchPct: v })}
          suffix="% of your contribution"
          min={0}
          max={200}
          step={1}
        />
        <NumInput
          label="Raises above inflation"
          value={draft.realGrowthPct}
          onChange={(v) => patch({ realGrowthPct: v })}
          suffix="%/yr"
          min={0}
          step={0.5}
        />
        <p className="hint">
          0%/yr holds your pay flat in today’s dollars (it still keeps up with inflation).
          A positive rate is real growth on top. Estimate, not advice.
        </p>
      </details>

      <div className={styles.formActions}>
        <button type="submit" className="btn primary">
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
