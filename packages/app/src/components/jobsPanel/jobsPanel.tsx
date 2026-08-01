/**
 * Every household member's {@link Job}s; none is privileged — there is no "career job".
 *
 * A job's whole pay story is authored here, beside the employment it belongs to — a raise is a
 * fact about a job, and looking for one anywhere else means knowing in advance which month it
 * lands in. That story runs **through** "now" rather than stopping at it: the engine dates a
 * pre-"now" pay change with a negative month and reconstructs what was actually earned from it,
 * and the surface for authoring one is this panel, in the same age vocabulary as everything
 * else. A job's two salary anchors — what it paid at its start, what it pays today — are
 * likewise stated separately, because neither derives from the other.
 *
 * Every row charts that pay across the owner's working life, staircase-style, with the month-0
 * seam drawn where it happens. See {@link PayChart} for why it is a staircase and why no
 * net-worth line is co-plotted with it.
 *
 * The headline is *current* pay — the month-0 anchor the projection actually starts from —
 * qualified with "now" once a change exists, so the headline and the dated changes below it
 * never contradict each other. A job that ended before "now" has no current pay to headline and
 * says so instead. Base + Adjustments still authors the same thing from the other direction (a
 * month is already selected there, over the projected span only), and single-month
 * perturbations only from there.
 *
 * A job belongs to a person, and every person's jobs are authored the same way: through
 * `Projection`, which owns the id. Where a job is *stored* differs — the primary person's
 * stand on the plan, a partner's are ledger-backed — and that is internal to the facade;
 * {@link jobOwnersOf} presents one owner list, and nothing here decides a plane.
 *
 * Topping the per-person 401(k) elective limit is not an error: contributions stop at the cap
 * and the overflow is paid as taxable income.
 */

import { useMemo, useState } from "react";
import {
  PRIMARY_PERSON_ID,
  dollarsToCents,
  estimateHistoryPayChanges,
  type Job,
  type JobPayChange,
  type Household,
  type Ledger,
  type Plan,
  type Projection,
} from "@finley/engine";
import {
  blankJobDraftFor,
  jobToDraftFor,
  jobPayPathFor,
  jobPaySpanFor,
  jobStartAgeFor,
  jobEndAgeFor,
  ownerAgeAtMonth,
  type JobEditDraft,
  type NewJobDraft,
} from "../../planPeople";
import { jobOwnersOf, type JobOwner } from "../../jobOwners";
import { addJob, editJob, ownedJobsOf, type JobWrite } from "../../jobEditing";
import { commitJobWrites } from "../../jobWrites";
import type { Transact } from "../../hooks/useProjection";
import { firstDeferralLimitCrossing } from "../../deferralLimit";
import { formatDollars } from "../../format";
import { JobForm } from "./jobForm";
import { PayChangeForm, type PayChangeDraft } from "./payChangeForm";
import { PayChart } from "./payChart";
import { PayTimeline } from "./payTimeline";
import styles from "./jobsPanel.module.css";

interface JobsPanelProps {
  budget: Plan;
  /**
   * One transaction per edit, whoever the job belongs to. {@link commitJobWrites} names the
   * facade method for each write; where the job is stored, and what id it gets, are the
   * facade's to decide.
   */
  transact: Transact;
  /** The roster whose members can hold jobs, and the timeline they join and leave on. */
  household: Household;
  ledger: Ledger;
  /**
   * What each job pays and defers, as authored — the two reads this panel makes. Writes go
   * through {@link transact}, so nothing wider than this belongs in a prop.
   */
  projection: Pick<
    Projection,
    "jobMonthlyIncomeCents" | "jobStartingMonthlyIncomeCents" | "jobDeferralFraction"
  >;
}

type Authoring =
  | { kind: "edit"; id: string }
  /** `seedAge` is where the form opens — an age clicked on the chart, else the seam. */
  | { kind: "payChange"; id: string; seedAge?: number }
  /** Explaining what estimating a job's missing history would do, BEFORE it does it. */
  | { kind: "estimate"; id: string }
  | { kind: "new" }
  | null;

/** "from age 18 · open-ended (to retirement)" / "age 30–45" — a job's span in its OWNER's terms. */
function describeSpan(owner: JobOwner, job: Job): string {
  const start = jobStartAgeFor(owner.birthYear, job);
  const end = jobEndAgeFor(owner.birthYear, job);
  return end === null
    ? `from age ${start} · open-ended (to retirement)`
    : `age ${start}–${end}`;
}

/**
 * What to say about pay changes an edit stranded — named, never merely counted, because the
 * point of dropping them loudly is that the user can put back whichever one still applies.
 * `null` when nothing was dropped, which is the overwhelmingly common case.
 */
function strandedNotice(owner: JobOwner, dropped: readonly JobPayChange[]): string | null {
  if (dropped.length === 0) return null;
  const ages = dropped
    .map((c) => `age ${ownerAgeAtMonth(owner.birthYear, c.month)}`)
    .join(", ");
  return `${dropped.length === 1 ? "One pay change" : `${dropped.length} pay changes`} now fell before this job starts, so ${dropped.length === 1 ? "it was" : "they were"} dropped: ${ages}.`;
}

export function JobsPanel({ budget, transact, household, ledger, projection }: JobsPanelProps) {
  const owners = useMemo(() => jobOwnersOf(household, ledger), [household, ledger]);
  // One list across the household in join order, primary person first. Every row carries its
  // owner — whose birth year every age on it reads against — and the label the app names that
  // job by (owner-qualified once a second earner exists).
  const rows = useMemo(() => ownedJobsOf(owners), [owners]);
  const [authoring, setAuthoring] = useState<Authoring>(null);
  /**
   * What the last edit dropped on its way through, in the user's words. An edit that moves a
   * start age forward strands the pay changes now before it — they are dropped rather than
   * clamped onto one month, and losing an authored fact silently is not an option.
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Which dollars the pay charts and timelines are drawn in. Off by default — the PAYCHECK of
   * each month, which is both what the projection pays and what every field on this panel
   * collects: a past salary is authored in the money of its own year. A chart disagreeing with
   * the number just typed into it would be the worse default.
   *
   * On, the whole span is divided back to today's money, so a flat line means flat purchasing
   * power and the past is comparable with today's pay. That reading is derived, never authored.
   *
   * One toggle for the whole panel rather than one per row: two jobs drawn in different money
   * cannot be compared, and comparing them is most of why they are stacked on one axis.
   */
  const [inTodaysDollars, setInTodaysDollars] = useState(false);
  // Per PERSON, not per household: the elective limit belongs to the earner.
  const deferralCrossing = useMemo(
    () => firstDeferralLimitCrossing(owners, budget.inflationPct),
    [owners, budget.inflationPct],
  );
  const severalOwners = owners.length > 1;
  /** The picker's options — the form needs who they are, not where their jobs live. */
  const pickableOwners = useMemo(
    () => owners.map((o) => ({ id: o.id, name: o.name, currentAge: ownerAgeAtMonth(o.birthYear, 0) })),
    [owners],
  );

  /** One transaction per edit, whichever owner it is for ({@link commitJobWrites}). */
  const commit = (writes: readonly JobWrite[]): boolean => commitJobWrites(writes, transact);

  /**
   * Create a job ({@link addJob}). `ownerId` rides the draft because creation is the one moment
   * whose job it is, is still a question; the facade mints the id from a single counter shared
   * by every job in the household.
   */
  function add({ ownerId, ...fields }: NewJobDraft) {
    const result = addJob(owners, ownerId, fields);
    if (result.ok) commit(result.writes);
    setAuthoring(null);
  }

  /**
   * Save an edit ({@link editJob}). The job keeps its owner — derived from whoever holds it,
   * since a {@link JobEditDraft} names none — and its id, so everything the form never shows
   * (overrides, pay changes, employer match) rides along. Nothing is written unless the whole
   * edit resolves.
   */
  function edit(owner: JobOwner, id: string, draft: JobEditDraft) {
    const result = editJob(owners, id, draft);
    if (!result.ok) return setAuthoring(null);
    if (commit(result.writes)) setNotice(strandedNotice(owner, result.strandedPayChanges));
    setAuthoring(null);
  }

  function remove(owner: JobOwner, id: string) {
    commit([{ kind: "remove", owner, jobId: id }]);
    if (authoring?.kind === "edit" && authoring.id === id) setAuthoring(null);
  }

  /**
   * Fill the unstated historical years with pay keeping pace with inflation, as ordinary dated
   * changes marked `estimated`. Explicit and one-shot: nothing here runs during normal editing,
   * and what it writes is editable and removable exactly like a change the user typed.
   */
  function estimateHistory(owner: JobOwner, job: Job) {
    const estimates = estimateHistoryPayChanges(
      job,
      jobPaySpanFor(owner, job),
      budget.inflationPct / 100,
    );
    if (estimates.length > 0) {
      transact((p) => {
        for (const change of estimates) p.addJobPayChange(job.id, change);
      });
    }
    setNotice(
      estimates.length === 0
        ? "There were no unstated years to estimate on this job."
        : `Filled in ${estimates.length} estimated ${estimates.length === 1 ? "year" : "years"} of pay history. They are marked “estimated”, and you can edit or remove any of them.`,
    );
    setAuthoring(null);
  }

  function removePayChange(id: string, month: number) {
    // Addressed by job id alone: an id names one job in the household.
    transact((p) => p.removeJobPayChange(id, month));
  }

  /**
   * The form dates a change by the owner's age; the plan stores a month. `month 0` is the
   * owner's age today, so the offset is whole years from there — and it is NOT floored, because
   * an age already lived is exactly how a pay history is authored: the negative month it
   * produces is what routes the change to the historical reconstruction. The form bounds the
   * age to the job's own span instead, which is the bound that means something.
   */
  function addPayChange(owner: JobOwner, id: string, draft: PayChangeDraft) {
    const month = (draft.age - ownerAgeAtMonth(owner.birthYear, 0)) * 12;
    transact((p) =>
      p.addJobPayChange(id, { month, kind: draft.kind, cents: dollarsToCents(draft.dollars) }),
    );
    setAuthoring(null);
  }

  return (
    <>
      <h2>Jobs &amp; income</h2>
      <p className="hint">
        {severalOwners
          ? "Earned income comes from the household’s jobs — each one belongs to a person. Add as many as you like, and date a raise or a cut on any of them."
          : "Earned income comes from your jobs — add as many as you like, and date a raise or a cut on any of them."}
      </p>

      {rows.length === 0 ? (
        <p className="hint">No jobs yet — add one below. With no income, you’re living off savings.</p>
      ) : (
        <>
          {/* Names the denomination every chart and timeline below is in. Sits above the list,
              because it governs all of them at once. */}
          <label className={styles.denomination}>
            <input
              type="checkbox"
              checked={inTodaysDollars}
              onChange={(e) => setInTodaysDollars(e.target.checked)}
            />
            Show in today’s money (adjust for {budget.inflationPct}% inflation)
          </label>
        <ul className={styles.list}>
          {rows.map(({ owner, job, label }) => {
            const monthlyCents = projection.jobMonthlyIncomeCents(job.id);
            const overrideCount = job.incomeOverrides?.length ?? 0;
            const payChanges = job.payChanges ?? [];
            // The job's whole pay story, both sides of "now" — what the chart draws and the
            // timeline lists, read straight off the two authored anchors. Chart and timeline
            // share ONE path, so the two can never quote different denominations of the same
            // job while the toggle sits above them both.
            const path = jobPayPathFor(owner, job, budget.inflationPct / 100, inTodaysDollars);
            const currentAge = ownerAgeAtMonth(owner.birthYear, 0);
            const startAge = jobStartAgeFor(owner.birthYear, job);
            // The last age the job still pays: its span end is exclusive, so a change dated
            // there would have nothing left to change.
            const lastPaidAge = ownerAgeAtMonth(owner.birthYear, path.span.endMonthExclusive) - 1;
            return (
              <li key={job.id} className={styles.row} aria-label={label}>
                <div className={styles.head}>
                  <span className={styles.name}>{label}</span>
                  {/* A job that is over has no current pay to headline — quoting one would
                      state a figure the engine never reads. What it paid is on the list below,
                      where it belongs: in the past tense. */}
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
                {/* The job's pay across the whole employment, seam and all. Clicking an age
                    seeds a change there — the chart is an input, not a picture. */}
                <PayChart
                  path={path}
                  payChanges={payChanges}
                  birthYear={owner.birthYear}
                  lifeExpectancy={budget.lifeExpectancy}
                  label={label}
                  inTodaysDollars={inTodaysDollars}
                  onPickAge={(age) =>
                    setAuthoring({ kind: "payChange", id: job.id, seedAge: age })
                  }
                />
                <PayTimeline
                  job={job}
                  birthYear={owner.birthYear}
                  path={path}
                  label={label}
                  onRemove={(month) => removePayChange(job.id, month)}
                />
                <div className={styles.actions}>
                  <button
                    type="button"
                    aria-label={`Edit ${label}`}
                    onClick={() =>
                      setAuthoring((a) =>
                        a?.kind === "edit" && a.id === job.id ? null : { kind: "edit", id: job.id },
                      )
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Change pay on ${label}`}
                    onClick={() =>
                      setAuthoring((a) =>
                        a?.kind === "payChange" && a.id === job.id
                          ? null
                          : { kind: "payChange", id: job.id },
                      )
                    }
                  >
                    Change pay
                  </button>
                  {/* Only where there is a past to estimate. Secondary, and never automatic:
                      an assumption about someone's earnings history should be something they
                      chose, not something they discover in a chart. */}
                  {path.span.startMonth < 0 && (
                    <button
                      type="button"
                      aria-label={`Estimate missing pay history on ${label}`}
                      onClick={() =>
                        setAuthoring((a) =>
                          a?.kind === "estimate" && a.id === job.id
                            ? null
                            : { kind: "estimate", id: job.id },
                        )
                      }
                    >
                      Estimate missing pay history
                    </button>
                  )}
                  <button type="button" aria-label={`Delete ${label}`} onClick={() => remove(owner, job.id)}>
                    Delete
                  </button>
                </div>
                {authoring?.kind === "estimate" && authoring.id === job.id && (
                  /* States what it will do, in full, BEFORE it does it — the whole point of
                     making the assumption explicit is that the user reads it and agrees. */
                  <div className={styles.form} role="group" aria-label="Estimate missing pay history">
                    <p className="hint">
                      Estimate the missing years between your starting salary and your current
                      salary by assuming your pay kept pace with inflation ({budget.inflationPct}%
                      a year), except where you have authored pay changes. This creates estimated
                      history to improve projections such as Social&nbsp;Security covered
                      earnings. Your starting salary and your current salary are left exactly as
                      you entered them, and no pay change you authored is overwritten. You can
                      edit or replace the estimate at any time.
                    </p>
                    <div className={styles.formActions}>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => estimateHistory(owner, job)}
                      >
                        Estimate history
                      </button>
                      <button type="button" className="btn" onClick={() => setAuthoring(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {authoring?.kind === "payChange" && authoring.id === job.id && (
                  <PayChangeForm
                    // Floored at the job's START age, not at "now": a change before the job
                    // existed has no baseline to apply to, but one before today does — that is
                    // exactly what authoring a pay history is.
                    minAge={startAge}
                    maxAge={lastPaidAge}
                    // Opens on the clicked age, else on the seam, so the direction stays an
                    // explicit choice instead of a bias baked into the default.
                    defaultAge={authoring.seedAge ?? currentAge}
                    currentAge={currentAge}
                    onSubmit={(draft) => addPayChange(owner, job.id, draft)}
                    onCancel={() => setAuthoring(null)}
                  />
                )}
                {authoring?.kind === "edit" && authoring.id === job.id && (
                  <JobForm
                    initial={jobToDraftFor(projection, owner.birthYear, job)}
                    currentAge={currentAge}
                    submitLabel="Save"
                    // Fixed, and shown as context when there is anyone else it could have
                    // been. The submission type carries no owner at all.
                    ownership="fixed"
                    {...(severalOwners
                      ? { owner: { name: owner.name, isPrimary: owner.id === owners[0].id } }
                      : {})}
                    onSubmit={(draft) => edit(owner, job.id, draft)}
                    onCancel={() => setAuthoring(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
        </>
      )}

      {notice && (
        // Neutral, and dismissible: nothing is wrong, an authored fact simply no longer fits
        // the job it was on.
        <p className="hint" role="status">
          {notice}{" "}
          <button type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}

      {deferralCrossing && (
        <p className="hint">
          {/* The limit is per person: "your jobs" would misattribute a partner's crossing
              and imply the two are pooled. */}
          {deferralCrossing.personId === PRIMARY_PERSON_ID
            ? `Across your jobs, your yearly 401(k) contribution tops the elective limit`
            : `Across ${deferralCrossing.personName}’s jobs, their yearly 401(k) contribution tops the elective limit`}{" "}
          ({formatDollars(deferralCrossing.limitCents)} in {deferralCrossing.year}). Past
          the limit, contributions stop and the rest is paid as taxable income. The limit is
          per person, so each earner is counted on their own. Estimate, not advice.
        </p>
      )}

      {authoring?.kind === "new" && owners.length > 0 ? (
        <JobForm
          // A new job starts on the primary person (first in join order); the picker moves
          // it to a partner before it is added.
          initial={blankJobDraftFor(owners[0].id, ownerAgeAtMonth(owners[0].birthYear, 0))}
          currentAge={ownerAgeAtMonth(owners[0].birthYear, 0)}
          submitLabel="Add"
          // Whose job it is, is settled here and only here.
          ownership="choose"
          owners={pickableOwners}
          onSubmit={add}
          onCancel={() => setAuthoring(null)}
        />
      ) : (
        <button type="button" className="btn" onClick={() => setAuthoring({ kind: "new" })}>
          + Add a job
        </button>
      )}
    </>
  );
}
