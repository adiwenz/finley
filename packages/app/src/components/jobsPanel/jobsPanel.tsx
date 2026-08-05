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
  jobPayPath,
  type Job,
  type JobPayChange,
  type Household,
  type JobPaySpan,
  type ResolvedJobPayDisplay,
  type Ledger,
  type Plan,
  type Projection,
} from "@finley/engine";
import {
  blankJobDraftFor,
  jobToDraftFor,
  ownerAgeAtMonth,
  type JobEditDraft,
  type NewJobDraft,
} from "../../planPeople";
import { jobOwnersOf, type JobOwner } from "../../jobOwners";
import { addJob, editJob, ownedJobsOf, type JobWrite } from "../../jobEditing";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { commitJobWrites } from "../../jobWrites";
import type { Transact } from "../../hooks/useProjection";
import { formatDollars } from "../../format";
import { JobForm } from "./jobForm";
import { JobCard, type JobCardAuthoring } from "./jobCard";
import { ContinuationPicker } from "./continuationPicker";
import { type PayChangeDraft } from "./payChangeForm";
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
    | "jobMonthlyIncomeCents"
    | "jobStartingMonthlyIncomeCents"
    | "jobDeferralFraction"
    | "continuationJobOf"
    | "deferralLimitCrossing"
  >;
  /**
   * How to draw one job: its employment, and which stretches of it are not this household's
   * income — {@link ResolvedJobPayDisplay}, read off whichever run the charts are showing.
   *
   * A function rather than a household, because the resolution is the ENGINE's and the choice of
   * which run to read is the caller's. While the Retirement panel previews a stop-working age,
   * the caller passes the preview run's, and every job here is drawn as that hypothesis resolved
   * it — the one job its owner named as continuing may run PAST its authored end to reach the
   * previewed age, every other job is only ever capped by it, and a job the run never reaches
   * draws nothing at all. Nothing about that boundary is re-derived on this side.
   *
   * Editing (Edit, Change pay, Delete) always reads and writes the authored `job` regardless:
   * this panel is the authoring surface, so its forms stay on the real plan even while its
   * charts show a hypothesis.
   */
  payDisplay: (jobId: string) => ResolvedJobPayDisplay | null;
}

type Authoring =
  | { kind: "edit"; id: string }
  /** `seedAge` is where the form opens — an age clicked on the chart, else the seam. */
  | { kind: "payChange"; id: string; seedAge?: number }
  | { kind: "new" }
  | null;

/**
 * The answer for a job no run resolved — nothing employed, nothing paid, nothing to disclaim.
 * Unreachable for a job read off this household's roster; it exists so the row can render at all
 * rather than making every field below optional for a case that never happens.
 */
const EMPTY_DISPLAY: ResolvedJobPayDisplay = {
  employmentSpan: { startMonth: 0, endMonthExclusive: 0 },
  paidSpan: null,
  uncountedSpans: [],
};

/**
 * What a job's chart says about one uncounted stretch — read off where the gap sits relative to
 * the paid window, with the person named.
 *
 * Geometry rather than a code carried alongside it: a gap that ends where the paid months begin
 * is one the household was not yet there for, and a gap that starts where they end is one it had
 * left before. The engine states the spans; only the app knows what this surface calls anybody,
 * and a reason string travelling beside the spans would be a second copy of a fact they already
 * carry, free to drift from them.
 *
 * With no paid window at all there is no before and no after — the job simply never was this
 * household's — so the sentence says that and nothing it cannot support.
 */
function uncountedNote(
  span: JobPaySpan,
  paidSpan: JobPaySpan | null,
  ownerName: string,
): string {
  if (paidSpan === null) return "Hatched: this pay is not household income during this period.";
  if (span.endMonthExclusive <= paidSpan.startMonth) {
    return `Hatched: this pay is not household income because ${ownerName} was not yet part of the household.`;
  }
  return `Hatched: this pay is not household income because ${ownerName} was no longer part of the household.`;
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

export function JobsPanel({
  budget,
  transact,
  household,
  ledger,
  projection,
  payDisplay,
}: JobsPanelProps) {
  const owners = useMemo(() => jobOwnersOf(household, ledger), [household, ledger]);
  // One list across the household in join order, primary person first. Every row carries its
  // owner — whose birth year every age on it reads against — and the label the app names that
  // job by (owner-qualified once a second earner exists).
  const rows = useMemo(() => ownedJobsOf(owners), [owners]);
  /**
   * What this panel calls each job, keyed by id — so the continuation picker offers the same
   * names the cards above it carry. Owner-unqualified: the question already names whose it is.
   */
  const titleOf = useMemo(
    () => new Map(rows.map((r) => [r.job.id, r.title])),
    [rows],
  );
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
  // Per PERSON, not per household: the elective limit belongs to the earner. The whole scan is
  // the engine's — which years are worked, which of them belong to the household, and what the
  // pay is in each are the projection's own three answers, and this panel only shows the result.
  const deferralCrossing = useMemo(
    () => projection.deferralLimitCrossing(usJurisdiction),
    [projection],
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
    if (authoring && authoring.kind !== "new" && authoring.id === id) setAuthoring(null);
  }

  function removePayChange(jobId: string, payChangeId: string) {
    // Addressed by job id alone: an id names one job in the household.
    transact((p) => p.removeJobPayChange(jobId, payChangeId));
  }

  /**
   * The other list on a job: a single month's bonus or missed paycheck, not a salary state.
   *
   * By the adjustment's own id, not its month — several may share a month, and a month would
   * name the whole stack.
   */
  function removeIncomeOverride(jobId: string, overrideId: string) {
    transact((p) => p.removeJobIncomeOverride(jobId, overrideId));
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
            // The job's whole pay story, both sides of "now" — what the chart draws and the
            // timeline lists, read straight off the two authored anchors. Chart and timeline
            // share ONE path, so the two can never quote different denominations of the same
            // job while the toggle sits above them both.
            //
            // WHAT to draw and WHICH OF IT COUNTS are both the engine's, resolved under this
            // run's own scope — so a preview and an authored pass answer the same question the
            // same way and this panel never has to know which it is looking at. Every job the
            // household holds has one; the fallback is for an id nothing resolved, which cannot
            // happen for a job read off this household's own roster.
            const display = payDisplay(job.id) ?? EMPTY_DISPLAY;
            const path = jobPayPath(job, display.employmentSpan, {
              inflationRate: budget.inflationPct / 100,
              denomination: inTodaysDollars ? "todaysDollars" : "paycheck",
            });
            // The whole employment is drawn, including the stretches this household is not paid
            // for: a partner who joins at 45 and separates at 55 still WORKED 35 to 65, and
            // shortening the line to the paid middle would say they did not. Each gap is
            // hatched and named instead. There may be two of them, one at either end.
            const uncounted = display.uncountedSpans.map((span) => ({
              ...span,
              note: uncountedNote(span, display.paidSpan, owner.name),
            }));
            // Narrow the panel's authoring state to this one card, so nothing but its own open
            // panel reaches it.
            const cardAuthoring: JobCardAuthoring =
              authoring !== null && authoring.kind !== "new" && authoring.id === job.id
                ? authoring.kind === "payChange"
                  ? { kind: "payChange", ...(authoring.seedAge !== undefined ? { seedAge: authoring.seedAge } : {}) }
                  : { kind: authoring.kind }
                : null;
            return (
              <JobCard
                key={job.id}
                owner={owner}
                job={job}
                label={label}
                monthlyCents={projection.jobMonthlyIncomeCents(job.id)}
                initialEditDraft={jobToDraftFor(projection, owner.birthYear, job)}
                path={path}
                uncounted={uncounted}
                lifeExpectancy={budget.lifeExpectancy}
                inTodaysDollars={inTodaysDollars}
                severalOwners={severalOwners}
                isPrimaryOwner={owner.id === owners[0].id}
                authoring={cardAuthoring}
                onEdit={() =>
                  setAuthoring((a) =>
                    a?.kind === "edit" && a.id === job.id ? null : { kind: "edit", id: job.id },
                  )
                }
                onDelete={() => remove(owner, job.id)}
                onSaveEdit={(draft) => edit(owner, job.id, draft)}
                onCancel={() => setAuthoring(null)}
                onStartPayChange={() =>
                  setAuthoring((a) =>
                    a?.kind === "payChange" && a.id === job.id ? null : { kind: "payChange", id: job.id },
                  )
                }
                onPickAge={(age) => setAuthoring({ kind: "payChange", id: job.id, seedAge: age })}
                onSubmitPayChange={(draft) => addPayChange(owner, job.id, draft)}
                onRemovePayChange={(payChangeId) => removePayChange(job.id, payChangeId)}
                onRemoveOverride={(overrideId) => removeIncomeOverride(job.id, overrideId)}
              />
            );
          })}
        </ul>
        {/* One question per earner, under the jobs it is asked about. Only for a member who has
            any: there is nothing to continue otherwise, and an empty picker would ask a question
            with one possible answer. */}
        {owners
          .filter((o) => o.jobs.length > 0)
          .map((owner) => (
            <ContinuationPicker
              key={owner.id}
              owner={owner}
              selected={projection.continuationJobOf(owner.id)}
              jobTitleOf={(job) => titleOf.get(job.id) ?? job.id}
              nowYear={START_YEAR}
              onChange={(jobId) => transact((p) => p.setContinuationJob(owner.id, jobId))}
            />
          ))}
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
