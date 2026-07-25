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
import type { Job, Household, Ledger, NewLifeEvent, Plan } from "@finley/engine";
import {
  addJobToList,
  updateJobInList,
  removeJobFromList,
  removeJobPayChange,
  blankJobDraftFor,
  jobToDraftFor,
  jobStartAgeFor,
  jobEndAgeFor,
  ownerAgeAtMonth,
  type JobDraft,
} from "../../planPeople";
import { jobOwnersOf, type JobOwner } from "../../jobOwners";
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
  /** Revise a ledger event in place — how a partner's jobs are written back (#118). */
  onUpdateEvent: (id: string, next: NewLifeEvent) => void;
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

export function JobsPanel({ budget, setBudget, household, ledger, onUpdateEvent }: JobsPanelProps) {
  const owners = useMemo(() => jobOwnersOf(household, ledger), [household, ledger]);
  // One list across the household, in join order — the primary person's jobs first, then
  // each partner's. Every row carries its owner, which is what routes its edits.
  const rows = useMemo(
    () => owners.flatMap((owner) => owner.jobs.map((job) => ({ owner, job }))),
    [owners],
  );
  const [authoring, setAuthoring] = useState<Authoring>(null);
  const deferralCrossing = firstDeferralLimitCrossing(budget);
  /** More than one member can earn, so rows name their owner and the form offers a picker. */
  const severalOwners = owners.length > 1;
  /** The picker's options — the form needs only who they are, not where their jobs live. */
  const pickableOwners = useMemo(() => owners.map((o) => ({ id: o.id, name: o.name })), [owners]);

  /**
   * Apply `revise` to a member's job list on whichever plane it is authored on: the
   * standing plan for the primary person, or a revision of the partner's
   * `RelationshipEvent`. The one place the two planes are distinguished — and the plan
   * side revises the LATEST plan (a functional update), so two edits in one tick compose
   * instead of discarding each other.
   */
  function writeJobs(owner: JobOwner, revise: (jobs: readonly Job[]) => readonly Job[]): void {
    if (owner.writeTarget.kind === "plan") {
      setBudget((current) => ({ ...current, jobs: [...revise(current.jobs)] }));
      return;
    }
    const event = owner.writeTarget.event;
    onUpdateEvent(event.id, {
      ...event,
      person: { ...event.person, jobs: [...revise(event.person.jobs)] },
    });
  }

  /** The owner a draft names — where an added or reassigned job is written. */
  const ownerOf = (id: string): JobOwner | undefined => owners.find((o) => o.id === id);

  function add(draft: JobDraft) {
    const target = ownerOf(draft.ownerId);
    if (target) writeJobs(target, (jobs) => addJobToList(jobs, target.birthYear, draft));
    setAuthoring(null);
  }

  /**
   * Save an edit. Picking a different owner *moves* the job: it is dropped from the
   * previous owner's list and rebuilt on the new one's, whose birth year the draft's ages
   * now resolve against (an age means the same thing to whoever holds the job).
   */
  function edit(owner: JobOwner, id: string, draft: JobDraft) {
    const target = ownerOf(draft.ownerId) ?? owner;
    if (target.id === owner.id) {
      writeJobs(owner, (jobs) => updateJobInList(jobs, id, owner.birthYear, draft));
    } else {
      writeJobs(owner, (jobs) => removeJobFromList(jobs, id));
      writeJobs(target, (jobs) => addJobToList(jobs, target.birthYear, draft));
    }
    setAuthoring(null);
  }

  function remove(owner: JobOwner, id: string) {
    writeJobs(owner, (jobs) => removeJobFromList(jobs, id));
    if (authoring?.kind === "edit" && authoring.id === id) setAuthoring(null);
  }

  function removePayChange(owner: JobOwner, id: string, month: number) {
    // Pay changes are authored against the primary earner's jobs (the Base + Adjustments
    // income row), so this stays a plan edit; a partner's job carries none to remove.
    if (owner.writeTarget.kind === "plan") {
      setBudget((current) => removeJobPayChange(current, id, month));
    }
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
          {rows.map(({ owner, job }) => {
            const monthlyCents = Math.round(job.salary.startingSalaryCents / 12);
            // The user's title when they gave one, else positional WITHIN ITS OWNER's jobs
            // — so an unnamed job still reads as "Job 1" rather than exposing its raw id,
            // and each earner's first job is their "Job 1". Once the household has a second
            // earner every row is prefixed with whose job it is; on a single-earner plan
            // that would be noise, so it stays off.
            const title = job.name?.trim() || `Job ${owner.jobs.indexOf(job) + 1}`;
            const label = severalOwners ? `${owner.name} · ${title}` : title;
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
                          onClick={() => removePayChange(owner, job.id, change.month)}
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
          Across your jobs, your yearly 401(k) contribution tops the elective limit
          ({formatDollars(deferralCrossing.limitCents)} in {deferralCrossing.year}). Past
          the limit, contributions stop and the rest is paid as taxable income. Estimate,
          not advice.
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
