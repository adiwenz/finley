/**
 * Jobs panel (§6, issue #72) — the single authoring surface for earned income. Lists
 * the primary person's {@link Job}s and lets the user add, edit, and delete them
 * directly (value-plane edits, §10.3 — never a timeline event), each re-running the
 * projection so net worth and the retirement solver move live. A person may hold any
 * number of jobs, several possibly open-ended; none is privileged — there is no "career
 * job". Dated changes — a one-off single month (a bonus, or $0 for a missed paycheck) and a
 * permanent pay change (a raise or a cut) — are authored against the income graph in Base +
 * Adjustments, where a month is selected. This panel is standing job data, but it *lists*
 * each job's permanent pay changes (which move what the job pays, unlike the headline
 * starting salary) and lets them be removed here.
 *
 * The 401(k) elective-limit nudge lives here now (it left the Budget editor with the
 * deferral): a deferral summed across jobs that tops the year's IRS limit is not an
 * error — contributions stop at the cap and the overflow is paid as taxable income.
 */

import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Plan } from "@finley/engine";
import {
  primaryJobs,
  addJobFromDraft,
  updateJobFromDraft,
  removeJob,
  removeJobPayChange,
  blankJobDraft,
  jobToDraft,
  jobStartAge,
  jobEndAge,
  type JobDraft,
} from "../../planPeople";
import { firstDeferralLimitCrossing } from "../../deferralLimit";
import { formatDollars } from "../../format";
import { JobForm } from "./jobForm";
import styles from "./jobsPanel.module.css";

interface JobsPanelProps {
  budget: Plan;
  setBudget: Dispatch<SetStateAction<Plan>>;
}

/** Which authoring form, if any, is disclosed: a job id (edit), "new" (add), or none. */
type Authoring = { kind: "edit"; id: string } | { kind: "new" } | null;

/** "from age 18 · open-ended (to retirement)" / "age 30–45" — a job's span in the user's terms. */
function describeSpan(budget: Plan, job: Plan["jobs"][number]): string {
  const start = jobStartAge(budget, job);
  const end = jobEndAge(budget, job);
  return end === null
    ? `from age ${start} · open-ended (to retirement)`
    : `age ${start}–${end}`;
}

/** The age the owner reaches in a given simulation month (for a pay change's "from age N"). */
function ageAtMonth(budget: Plan, month: number): number {
  return budget.currentAge + Math.floor(month / 12);
}

/** "Pay set to $0/mo from age 35" / "Pay cut $500/mo from age 40" — a permanent pay change. */
function describePayChange(budget: Plan, change: NonNullable<Plan["jobs"][number]["payChanges"]>[number]): string {
  const at = `from age ${ageAtMonth(budget, change.month)}`;
  if (change.kind === "setTo") return `Pay set to ${formatDollars(change.cents)}/mo ${at}`;
  const verb = change.cents < 0 ? "cut" : "raised";
  return `Pay ${verb} ${formatDollars(Math.abs(change.cents))}/mo ${at}`;
}

export function JobsPanel({ budget, setBudget }: JobsPanelProps) {
  const jobs = primaryJobs(budget);
  const [authoring, setAuthoring] = useState<Authoring>(null);
  const deferralCrossing = firstDeferralLimitCrossing(budget);

  function add(draft: JobDraft) {
    setBudget((current) => addJobFromDraft(current, draft));
    setAuthoring(null);
  }

  function edit(id: string, draft: JobDraft) {
    setBudget((current) => updateJobFromDraft(current, id, draft));
    setAuthoring(null);
  }

  function remove(id: string) {
    setBudget((current) => removeJob(current, id));
    if (authoring?.kind === "edit" && authoring.id === id) setAuthoring(null);
  }

  function removePayChange(id: string, month: number) {
    setBudget((current) => removeJobPayChange(current, id, month));
  }

  return (
    <>
      <h2>Jobs &amp; income</h2>
      <p className="hint">
        Earned income comes from your jobs — add as many as you like. A “from here
        forward” raise is just editing a job (or adding a new one).
      </p>

      {jobs.length === 0 ? (
        <p className="hint">No jobs yet — add one below. With no income, you’re living off savings.</p>
      ) : (
        <ul className={styles.list}>
          {jobs.map((job, i) => {
            const monthlyCents = Math.round(job.salary.startingSalaryCents / 12);
            const label = `Job ${i + 1}`;
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
                <div className={styles.meta}>{describeSpan(budget, job)}</div>
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
                        <span>{describePayChange(budget, change)}</span>
                        <button
                          type="button"
                          aria-label={`Remove pay change at age ${ageAtMonth(budget, change.month)} on ${label}`}
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
                  <button type="button" aria-label={`Delete ${label}`} onClick={() => remove(job.id)}>
                    Delete
                  </button>
                </div>
                {authoring?.kind === "edit" && authoring.id === job.id && (
                  <JobForm
                    initial={jobToDraft(budget, job)}
                    submitLabel="Save"
                    onSubmit={(draft) => edit(job.id, draft)}
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

      {authoring?.kind === "new" ? (
        <JobForm
          initial={blankJobDraft(budget)}
          submitLabel="Add"
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
