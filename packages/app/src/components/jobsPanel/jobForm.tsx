/**
 * Add/edit surface for one job on the value-editing plane: a direct edit to `plan.jobs`,
 * never a timeline event. Speaks the user's terms (monthly salary, start age, whether it
 * runs to retirement) and folds them into a {@link JobDraft} on submit. 401(k) deferral
 * and above-inflation raises hide behind an "Advanced" details, like the account-return
 * knobs in the Budget editor. One form backs both add and edit — `initial` seeds it.
 */

import { useRef, useState } from "react";
import type { PersonId } from "@finley/engine";
import type { JobDraft } from "../../planPeople";
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
}

interface JobFormProps {
  /** Seed values (an existing job's draft when editing); a blank draft when adding. */
  initial: JobDraft;
  /**
   * The owner's age now — where "now" falls on the ages this form collects. With a picker on
   * screen the selected owner's own age wins; this is the age of the owner the form opened on.
   */
  currentAge: number;
  /** Verb shown on the primary button and used to label the form ("Add" / "Save"). */
  submitLabel: string;
  /**
   * Who could own this job. A second earner discloses a picker so the job can be
   * authored for — or reassigned to — either; with only the primary person, none shows.
   */
  owners?: readonly JobFormOwner[];
  onSubmit: (draft: JobDraft) => void;
  onCancel: () => void;
}

/**
 * The form's live state in the fields' own terms — one object, not a hook per field.
 * `endAge: null` IS "open-ended"; the checkbox derives from it rather than being tracked
 * separately, so the two cannot disagree. Salary is held in whole dollars (the unit the
 * input edits) and converted to cents on submit.
 */
interface JobFormDraft {
  readonly name: string;
  /** Whose job this is — the ages below are this person's ages. */
  readonly ownerId: PersonId;
  /** Pay a month at month 0 — what the projection starts from. */
  readonly monthlyDollars: number;
  /** Pay a month in the job's own start year — what the historical reconstruction starts from. */
  readonly startingMonthlyDollars: number;
  readonly startAge: number;
  /** `null` = open-ended (runs to retirement); a number = a fixed end age. */
  readonly endAge: number | null;
  readonly deferralPct: number;
  /** Employer match as a whole-number percent OF the deferral; only bites when there's one. */
  readonly employerMatchPct: number;
  readonly realGrowthPct: number;
}

/** A sensible finite end age to fall back to when none was ever entered. */
const defaultEndAge = (startAge: number): number => Math.max(startAge + 1, 65);

/** Hoisted so the no-picker case reuses one array instead of minting one per render. */
const NO_OWNERS: readonly JobFormOwner[] = [];

export function JobForm({
  initial,
  currentAge,
  submitLabel,
  owners,
  onSubmit,
  onCancel,
}: JobFormProps) {
  const [draft, setDraft] = useState<JobFormDraft>(() => ({
    name: initial.name,
    ownerId: initial.ownerId,
    monthlyDollars: Math.round(initial.monthlyCents / 100),
    startingMonthlyDollars: Math.round(initial.startingMonthlyCents / 100),
    startAge: initial.startAge,
    endAge: initial.endAge,
    deferralPct: initial.deferralPct,
    employerMatchPct: initial.employerMatchPct,
    realGrowthPct: initial.realGrowthPct,
  }));

  // Last finite end age, remembered across "open-ended" toggles: ticking the box nulls
  // `endAge` (field disappears), unticking restores THIS rather than a default. Kept out
  // of the draft — UX memory, not domain state — so `endAge` stays the single truth.
  const lastFiniteEndAge = useRef(initial.endAge ?? defaultEndAge(initial.startAge));

  const patch = (fields: Partial<JobFormDraft>) => setDraft((d) => ({ ...d, ...fields }));

  const openEnded = draft.endAge === null;

  const pickableOwners = owners ?? NO_OWNERS;
  /**
   * Name to phrase the age copy in when the job belongs to someone other than the primary
   * person (always first in the list) — "the ages above are Sam's", not "your
   * Social-Security-covered years". `null` means the job is the user's own.
   */
  const otherOwnerName =
    pickableOwners.length > 1 && draft.ownerId !== pickableOwners[0].id
      ? (pickableOwners.find((o) => o.id === draft.ownerId)?.name ?? null)
      : null;

  // The ages here are the SELECTED owner's, so reassigning a job re-reads its whole past
  // against the new clock before anything is submitted.
  const ownerAge = pickableOwners.find((o) => o.id === draft.ownerId)?.currentAge ?? currentAge;
  /** The job is already under way, so what it paid on day one is a separate fact from today's pay. */
  const hasHistory = draft.startAge < ownerAge;
  /**
   * The whole job is behind us. It has no pay "now" — `compileJobIncome` drops a wholly-past
   * job before the current-salary anchor is ever read — so the form does not ask for one, and
   * {@link jobInputFromDraft} / {@link applyJobDraft} pin the dead anchor to what it last paid.
   */
  const endedBeforeNow = draft.endAge !== null && draft.endAge <= ownerAge;

  function submit() {
    onSubmit({
      name: draft.name,
      ownerId: draft.ownerId,
      monthlyCents: Math.round(draft.monthlyDollars * 100),
      // A job with no past states ONE salary, so the two anchors go out equal — "it pays X"
      // means a flat history, and the deviations from that are what a pay change is for. Once
      // the job has a past, the two fields are on screen and neither is derived.
      startingMonthlyCents: Math.round(
        (hasHistory ? draft.startingMonthlyDollars : draft.monthlyDollars) * 100,
      ),
      startAge: draft.startAge,
      endAge: draft.endAge === null ? null : Math.max(draft.startAge + 1, draft.endAge),
      realGrowthPct: draft.realGrowthPct,
      deferralPct: draft.deferralPct,
      employerMatchPct: draft.employerMatchPct,
    });
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
      {/* Shown only once the household holds a second earner. Changing it on an
          existing job reassigns the job to that member. */}
      {pickableOwners.length > 1 && (
        <label className="field">
          <span className="field-label">Whose job</span>
          <select value={draft.ownerId} onChange={(e) => patch({ ownerId: e.target.value })}>
            {pickableOwners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
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
            Inflation is only used for projections and optional historical estimates.
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
      {hasHistory && !endedBeforeNow && (
        <p className="hint">
          What it paid when it started seeds the covered-earnings record behind Social Security.
          What it pays now is what the projection starts from. They need not line up — a step
          between them is an authored fact, not a mistake.
        </p>
      )}
      <NumInput
        label="Start age"
        value={draft.startAge}
        onChange={(v) => patch({ startAge: v })}
        min={14}
        max={100}
        step={1}
      />
      <label className="field field-check">
        <input
          type="checkbox"
          checked={openEnded}
          onChange={(e) => patch({ endAge: e.target.checked ? null : lastFiniteEndAge.current })}
        />
        <span className="field-label">Open-ended (runs until retirement)</span>
      </label>
      {draft.endAge !== null && (
        <NumInput
          label="End age"
          value={draft.endAge}
          onChange={(v) => {
            lastFiniteEndAge.current = v;
            patch({ endAge: v });
          }}
          min={draft.startAge + 1}
          max={100}
          step={1}
        />
      )}
      <p className="hint">
        {otherOwnerName === null
          ? "The age you began this job seeds your Social-Security-covered years; an open-ended job runs until your retirement age. Estimate, not advice."
          : `These are ${otherOwnerName}’s ages. The age they began this job seeds their Social-Security-covered years; an open-ended job runs until their retirement age. Estimate, not advice.`}
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
