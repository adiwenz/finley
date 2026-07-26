/**
 * Jobs panel (§6, issue #72) — the single authoring surface for earned income. Lists
 * **every household member's** {@link Job}s and lets the user add, edit, and delete them,
 * each re-running the projection so net worth and the retirement solver move live. A
 * person may hold any number of jobs, several possibly open-ended; none is privileged —
 * there is no "career job". Dated changes — a one-off single month (a bonus, or $0 for a
 * missed paycheck) and a permanent pay change (a raise or a cut) — are authored against the
 * income graph in Base + Adjustments, where a month is selected. This panel is standing job
 * data, but it *lists* each job's permanent pay changes (which move what the job pays,
 * unlike the headline starting salary) and lets them be removed here.
 *
 * **Two planes, one list (issue #118).** The primary person's jobs are standing plan data
 * (a value-plane edit, §10.3 — never a timeline event); a partner's ride the
 * `RelationshipEvent` that brought them into the household, so editing those revises that
 * event ({@link import("@finley/engine").updateEvent}). {@link jobOwnersOf} hides the
 * difference behind one owner list, and each row's owner decides which plane its edit is
 * written to. Without this a partner's jobs were write-once: authored at the moment they
 * joined and unchangeable short of removing the partner outright.
 *
 * The 401(k) elective-limit nudge lives here now (it left the Budget editor with the
 * deferral): a deferral summed across jobs that tops the year's IRS limit is not an
 * error — contributions stop at the cap and the overflow is paid as taxable income. The
 * limit is per person, so the nudge speaks for the primary earner's own jobs.
 */

import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { PRIMARY_PERSON_ID, type Job, type Household, type Ledger, type Plan } from "@finley/engine";
import {
  addJobToList,
  removeJobFromList,
  withoutPayChange,
  blankJobDraftFor,
  jobToDraftFor,
  jobStartAgeFor,
  jobEndAgeFor,
  ownerAgeAtMonth,
  type JobDraft,
} from "../../planPeople";
import { jobOwnersOf, type JobOwner } from "../../jobOwners";
import { editJob, ownedJobsOf, reviseJob, type JobListWrite } from "../../jobEditing";
import { commitJobWrites } from "../../jobWrites";
import type { EventRevision } from "../../hooks/useLedger";
import { firstDeferralLimitCrossing } from "../../deferralLimit";
import { formatDollars } from "../../format";
import { JobForm } from "./jobForm";
import styles from "./jobsPanel.module.css";

interface JobsPanelProps {
  budget: Plan;
  setBudget: Dispatch<SetStateAction<Plan>>;
  /** The interpreted household — the roster whose members can hold jobs (§3, §8). */
  household: Household;
  /** The ledger, where a partner's jobs live (on their `RelationshipEvent`). */
  ledger: Ledger;
  /**
   * Revise ledger events in one all-or-nothing write — how a partner's jobs are written
   * back (#118). Returns `false` if the revision was rejected (§6.1), in which case the
   * ledger is untouched and the panel writes nothing else either.
   */
  onReviseEvents: (revisions: readonly EventRevision[]) => boolean;
}

/** Which authoring form, if any, is disclosed: a job id (edit), "new" (add), or none. */
type Authoring = { kind: "edit"; id: string } | { kind: "new" } | null;

/** "from age 18 · open-ended (to retirement)" / "age 30–45" — a job's span in its OWNER's terms. */
function describeSpan(owner: JobOwner, job: Job): string {
  const start = jobStartAgeFor(owner.birthYear, job);
  const end = jobEndAgeFor(owner.birthYear, job);
  return end === null
    ? `from age ${start} · open-ended (to retirement)`
    : `age ${start}–${end}`;
}

/** "Pay set to $0/mo from age 35" / "Pay cut $500/mo from age 40" — a permanent pay change. */
function describePayChange(owner: JobOwner, change: NonNullable<Job["payChanges"]>[number]): string {
  const at = `from age ${ownerAgeAtMonth(owner.birthYear, change.month)}`;
  if (change.kind === "setTo") return `Pay set to ${formatDollars(change.cents)}/mo ${at}`;
  const verb = change.cents < 0 ? "cut" : "raised";
  return `Pay ${verb} ${formatDollars(Math.abs(change.cents))}/mo ${at}`;
}

export function JobsPanel({ budget, setBudget, household, ledger, onReviseEvents }: JobsPanelProps) {
  const owners = useMemo(() => jobOwnersOf(household, ledger), [household, ledger]);
  // One list across the household, in join order — the primary person's jobs first, then
  // each partner's. Every row carries its owner, which is what routes its edits, and the
  // label the whole app names that job by (owner-qualified once a second earner exists).
  const rows = useMemo(() => ownedJobsOf(owners), [owners]);
  const [authoring, setAuthoring] = useState<Authoring>(null);
  // Per PERSON, not per household: the elective limit belongs to the earner (§5.4).
  const deferralCrossing = useMemo(
    () => firstDeferralLimitCrossing(owners, budget.inflationPct),
    [owners, budget.inflationPct],
  );
  /** More than one member can earn, so the form offers an owner picker. */
  const severalOwners = owners.length > 1;
  /** The picker's options — the form needs only who they are, not where their jobs live. */
  const pickableOwners = useMemo(() => owners.map((o) => ({ id: o.id, name: o.name })), [owners]);

  /** Route every rewrite to its owner's plane, atomically ({@link commitJobWrites}). */
  const commit = (writes: readonly JobListWrite[]): boolean =>
    commitJobWrites(writes, { setBudget, onReviseEvents });

  /** Rewrite one member's job list — the single-owner shorthand for {@link commit}. */
  function write(owner: JobOwner, revise: (jobs: readonly Job[]) => readonly Job[]): boolean {
    return commit([{ owner, revise }]);
  }

  function add(draft: JobDraft) {
    const target = owners.find((o) => o.id === draft.ownerId);
    if (target) write(target, (jobs) => addJobToList(jobs, target.birthYear, draft));
    setAuthoring(null);
  }

  /**
   * Save an edit — fields and owner together, as one operation ({@link editJob}). Picking a
   * different owner *moves* the job: the same job, keeping its id, its one-month overrides,
   * its pay changes and its employer match, leaves one member's list and joins the other's,
   * its ages now read against the new owner's birth year (an age means the same thing to
   * whoever holds the job). Nothing is written unless the whole edit resolves.
   */
  function edit(owner: JobOwner, id: string, draft: JobDraft) {
    const result = editJob(owners, owner.id, id, draft);
    if (result.ok) commit(result.writes);
    setAuthoring(null);
  }

  function remove(owner: JobOwner, id: string) {
    write(owner, (jobs) => removeJobFromList(jobs, id));
    if (authoring?.kind === "edit" && authoring.id === id) setAuthoring(null);
  }

  function removePayChange(id: string, month: number) {
    // Any member's job can carry one now that the Base + Adjustments pay-change control
    // reaches every earner (#118), so this routes by owner like every other job write.
    const result = reviseJob(owners, id, (job) => withoutPayChange(job, month));
    if (result.ok) commit(result.writes);
  }

  return (
    <>
      <h2>Jobs &amp; income</h2>
      <p className="hint">
        {severalOwners
          ? "Earned income comes from the household’s jobs — each one belongs to a person. Add as many as you like. A “from here forward” raise is just editing a job (or adding a new one)."
          : "Earned income comes from your jobs — add as many as you like. A “from here forward” raise is just editing a job (or adding a new one)."}
      </p>

      {rows.length === 0 ? (
        <p className="hint">No jobs yet — add one below. With no income, you’re living off savings.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map(({ owner, job, label }) => {
            const monthlyCents = Math.round(job.salary.startingSalaryCents / 12);
            const overrideCount = job.incomeOverrides?.length ?? 0;
            // Permanent pay changes, oldest first — listed in full below (not just counted),
            // since a raise/cut moves what the job actually pays and the headline shows only
            // the STARTING salary.
            const payChanges = [...(job.payChanges ?? [])].sort((a, b) => a.month - b.month);
            return (
              <li key={job.id} className={styles.row} aria-label={label}>
                <div className={styles.head}>
                  <span className={styles.name}>{label}</span>
                  <span className={styles.salary} title="Starting salary — see pay changes below">
                    {formatDollars(monthlyCents)}/mo{payChanges.length > 0 ? " to start" : ""}
                  </span>
                </div>
                <div className={styles.meta}>{describeSpan(owner, job)}</div>
                {(job.deferral || overrideCount > 0) && (
                  <div className={styles.meta}>
                    {job.deferral
                      ? `${Math.round(job.deferral.deferralFraction * 100)}% to 401(k)`
                      : ""}
                    {job.deferral && overrideCount > 0 ? " · " : ""}
                    {overrideCount > 0
                      ? `${overrideCount} one-off (single-month) adjustment${overrideCount === 1 ? "" : "s"}`
                      : ""}
                  </div>
                )}
                {payChanges.length > 0 && (
                  <ul className={styles.payChanges} aria-label={`Pay changes on ${label}`}>
                    {payChanges.map((change) => (
                      <li key={change.month} className={styles.payChange}>
                        <span>{describePayChange(owner, change)}</span>
                        <button
                          type="button"
                          aria-label={`Remove pay change at age ${ownerAgeAtMonth(owner.birthYear, change.month)} on ${label}`}
                          onClick={() => removePayChange(job.id, change.month)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
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
                  <button type="button" aria-label={`Delete ${label}`} onClick={() => remove(owner, job.id)}>
                    Delete
                  </button>
                </div>
                {authoring?.kind === "edit" && authoring.id === job.id && (
                  <JobForm
                    initial={jobToDraftFor(owner.birthYear, job)}
                    submitLabel="Save"
                    owners={pickableOwners}
                    onSubmit={(draft) => edit(owner, job.id, draft)}
                    onCancel={() => setAuthoring(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {deferralCrossing && (
        <p className="hint">
          {/* Whose limit it is, once the household has a second earner: the limit is per
              person, so "your jobs" would misattribute a partner's crossing to the user —
              and imply the two are pooled, which they are not (§5.4). */}
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
          // A new job starts on the primary person (first in join order); the picker
          // above moves it to a partner before it is added.
          initial={blankJobDraftFor(owners[0].id, ownerAgeAtMonth(owners[0].birthYear, 0))}
          submitLabel="Add"
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
