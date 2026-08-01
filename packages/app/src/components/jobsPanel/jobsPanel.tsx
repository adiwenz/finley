/**
 * Every household member's {@link Job}s; none is privileged — there is no "career job".
 *
 * A job's permanent pay changes are listed, added and removed here, beside the employment
 * they belong to — a raise is a fact about a job, and looking for one anywhere else means
 * knowing in advance which month it lands in. The headline is *current* pay — the month-0
 * anchor the projection actually starts from — qualified with "now" once a change exists, so
 * the headline and the dated changes below it never contradict each other.
 * Base + Adjustments still authors the same thing from the other direction (a month is
 * already selected there), and single-month perturbations only from there.
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
  type Job,
  type Household,
  type Ledger,
  type Plan,
  type Projection,
} from "@finley/engine";
import {
  jobInputFromDraft,
  blankJobDraftFor,
  jobToDraftFor,
  jobStartAgeFor,
  jobEndAgeFor,
  ownerAgeAtMonth,
  type JobDraft,
} from "../../planPeople";
import { jobOwnersOf, type JobOwner } from "../../jobOwners";
import { editJob, ownedJobsOf, type JobWrite } from "../../jobEditing";
import { commitJobWrites } from "../../jobWrites";
import type { Transact } from "../../hooks/useProjection";
import { firstDeferralLimitCrossing } from "../../deferralLimit";
import { formatDollars } from "../../format";
import { JobForm } from "./jobForm";
import { PayChangeForm, type PayChangeDraft } from "./payChangeForm";
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
  projection: Pick<Projection, "jobMonthlyIncomeCents" | "jobDeferralFraction">;
}

type Authoring =
  | { kind: "edit"; id: string }
  | { kind: "payChange"; id: string }
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

/** "Pay set to $0/mo from age 35" / "Pay cut $500/mo from age 40" — a permanent pay change. */
function describePayChange(owner: JobOwner, change: NonNullable<Job["payChanges"]>[number]): string {
  const at = `from age ${ownerAgeAtMonth(owner.birthYear, change.month)}`;
  if (change.kind === "setTo") return `Pay set to ${formatDollars(change.cents)}/mo ${at}`;
  const verb = change.cents < 0 ? "cut" : "raised";
  return `Pay ${verb} ${formatDollars(Math.abs(change.cents))}/mo ${at}`;
}

export function JobsPanel({ budget, transact, household, ledger, projection }: JobsPanelProps) {
  const owners = useMemo(() => jobOwnersOf(household, ledger), [household, ledger]);
  // One list across the household in join order, primary person first. Every row carries its
  // owner — whose birth year every age on it reads against — and the label the app names that
  // job by (owner-qualified once a second earner exists).
  const rows = useMemo(() => ownedJobsOf(owners), [owners]);
  const [authoring, setAuthoring] = useState<Authoring>(null);
  // Per PERSON, not per household: the elective limit belongs to the earner.
  const deferralCrossing = useMemo(
    () => firstDeferralLimitCrossing(owners, budget.inflationPct),
    [owners, budget.inflationPct],
  );
  const severalOwners = owners.length > 1;
  /** The picker's options — the form needs who they are, not where their jobs live. */
  const pickableOwners = useMemo(() => owners.map((o) => ({ id: o.id, name: o.name })), [owners]);

  /** One transaction per edit, whichever owner it is for ({@link commitJobWrites}). */
  const commit = (writes: readonly JobWrite[]): boolean => commitJobWrites(writes, transact);

  function add(draft: JobDraft) {
    const target = owners.find((o) => o.id === draft.ownerId);
    // No id: the facade mints one, from a single counter shared by every job in the household.
    if (target) commit([{ kind: "add", owner: target, job: jobInputFromDraft(target.birthYear, draft) }]);
    setAuthoring(null);
  }

  /**
   * Save an edit — fields and owner together, as one operation ({@link editJob}). Picking a
   * different owner *moves* the job: same id, overrides, pay changes and employer match,
   * its ages now read against the new owner's birth year. Nothing is written unless the
   * whole edit resolves.
   */
  function edit(owner: JobOwner, id: string, draft: JobDraft) {
    const result = editJob(owners, owner.id, id, draft);
    if (result.ok) commit(result.writes);
    setAuthoring(null);
  }

  function remove(owner: JobOwner, id: string) {
    commit([{ kind: "remove", owner, jobId: id }]);
    if (authoring?.kind === "edit" && authoring.id === id) setAuthoring(null);
  }

  function removePayChange(id: string, month: number) {
    // Addressed by job id alone: an id names one job in the household.
    transact((p) => p.removeJobPayChange(id, month));
  }

  /**
   * The form dates a change by the owner's age; the plan stores a month. `month 0` is the
   * owner's age today, so the offset is whole years from there — floored at 0, since a change
   * cannot take effect before "now".
   */
  function addPayChange(owner: JobOwner, id: string, draft: PayChangeDraft) {
    const month = Math.max(0, (draft.age - ownerAgeAtMonth(owner.birthYear, 0)) * 12);
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
        <ul className={styles.list}>
          {rows.map(({ owner, job, label }) => {
            const monthlyCents = projection.jobMonthlyIncomeCents(job.id);
            const overrideCount = job.incomeOverrides?.length ?? 0;
            // Permanent pay changes, oldest first — listed in full, not just counted.
            const payChanges = [...(job.payChanges ?? [])].sort((a, b) => a.month - b.month);
            return (
              <li key={job.id} className={styles.row} aria-label={label}>
                <div className={styles.head}>
                  <span className={styles.name}>{label}</span>
                  <span className={styles.salary} title="Current pay — see pay changes below">
                    {formatDollars(monthlyCents)}/mo{payChanges.length > 0 ? " now" : ""}
                  </span>
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
                  <button type="button" aria-label={`Delete ${label}`} onClick={() => remove(owner, job.id)}>
                    Delete
                  </button>
                </div>
                {authoring?.kind === "payChange" && authoring.id === job.id && (
                  <PayChangeForm
                    currentAge={ownerAgeAtMonth(owner.birthYear, 0)}
                    onSubmit={(draft) => addPayChange(owner, job.id, draft)}
                    onCancel={() => setAuthoring(null)}
                  />
                )}
                {authoring?.kind === "edit" && authoring.id === job.id && (
                  <JobForm
                    initial={jobToDraftFor(projection, owner.birthYear, job)}
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
