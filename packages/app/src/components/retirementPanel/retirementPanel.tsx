/**
 * Retirement panel — the Mode-1 headline age ("when can we retire?") and, for the pinned
 * retirement age, the target-mode on-track % plus the nearest feasible age when the pin is
 * unreachable. Single-person for now, so Mode 1 and per-person Mode 2 coincide; the
 * per-person click-through arrives with a second household member.
 */

import { Fragment } from "react";
import { PRIMARY_PERSON_ID, type Plan } from "@finley/engine";
import type { RetirementView } from "../../retirementView";
import { formatDollars } from "../../format";

/**
 * How a sentence refers to one job — "your **Software Engineer** job", or just "**Alex's job**"
 * for one with no title of its own.
 *
 * Two phrasings because a job with no name has no bare title to slot into "your X job"; the
 * engine's fallback label is already a whole noun phrase, so it stands alone. Whose it is comes
 * from the label in that case and from `ownerName` in the other, which is what keeps a partner's
 * continued job from reading as the reader's own.
 */
function JobPhrase({
  job,
}: {
  job: { jobLabel: string; jobName: string | null; ownerId: string; ownerName: string };
}) {
  if (job.jobName === null) return <strong>{job.jobLabel}</strong>;
  // The reader is the primary, so their own job is "your"; anyone else's is named.
  const whose = job.ownerId === PRIMARY_PERSON_ID ? "your" : `${job.ownerName}’s`;
  return (
    <>
      {whose} <strong>{job.jobName}</strong> job
    </>
  );
}

export function RetirementPanel({
  view,
  budget,
  previewing,
  onTogglePreview,
}: {
  view: RetirementView;
  budget: Plan;
  /** Whether the net-worth and income charts are currently showing the stop-working preview. */
  previewing: boolean;
  /** Flip the preview on or off. The parent owns the state; the panel only reports the intent. */
  onTogglePreview: (next: boolean) => void;
}) {
  return (
    <>
      <h2>Retirement</h2>

      {/* Offered only when a feasible headline age exists: with none, capping work any earlier is
          strictly worse, so there is no hypothetical worth drawing. Toggles the CHARTS, not the
          plan — the underlying scenario is never touched.
          `runAtStopWorkingAge` reads `headlineAge` as the PRIMARY's own age and turns it into one
          household-wide calendar boundary no job pays past — a fixed-term job or a partner's own
          job can already end BEFORE that boundary (the boundary only ever caps them, never
          extends them out to it — see `resolvedJobEndMonth`), so "everyone stopped working WHEN
          Alex turns 76" would overclaim simultaneity as well as age. "By the time" says only what
          is actually guaranteed: nobody is still earning past that point. */}
      {view.headlineAge !== null ? (
        <label className="preview-toggle">
          <input
            type="checkbox"
            checked={previewing}
            onChange={(e) => onTogglePreview(e.target.checked)}
          />
          <span>
            Preview the charts as if everyone stopped working by the time{" "}
            {budget.name ? (
              <>
                {budget.name} turns <strong>{view.headlineAge}</strong>
              </>
            ) : (
              <>
                you turn <strong>{view.headlineAge}</strong>
              </>
            )}
          </span>
        </label>
      ) : null}
      {view.headlineAge === null ? (
        <p className="alert alert-red" role="status">
          On these numbers the money never lasts to age {budget.lifeExpectancy} — no
          retirement age is feasible. Structural changes are required.
        </p>
      ) : (
        <p className="hint">
          You can retire at{" "}
          <strong aria-label="Earliest feasible retirement age">{view.headlineAge}</strong> and
          have the portfolio last to age {budget.lifeExpectancy}.
        </p>
      )}

      {/* The premise behind the age, stated whenever there is one. An answer that only works
          because a job ran on past what was written down is a different answer, and the
          household may never have opened the picker that chose which job that was — so the
          assumption is disclosed rather than left for them to find. Nothing is said when the age
          needed no extra work, because then nothing was assumed. */}
      {view.headlineAge !== null && view.continuedJobs.length > 0 && (
        <>
          <p className="hint" role="status">
            You could stop working at {view.headlineAge} if{" "}
            {view.continuedJobs.map((c, i) => (
              // A fragment, not a span: this is one sentence, and a wrapper element around each
              // clause would put element boundaries inside it for no reason.
              <Fragment key={c.jobId}>
                {i > 0 && (i === view.continuedJobs.length - 1 ? " and " : ", ")}
                <JobPhrase job={c} />
              </Fragment>
            ))}{" "}
            continued through age {view.headlineAge}.
          </p>
          {/* The one thing about a continued job a reader would not predict: it never ended, so
              it now runs THROUGH the jobs that were authored to follow it, and both pay. Named
              with its years, because that is the window where the income is doubled up. */}
          {view.continuedJobs.flatMap((c) =>
            c.overlaps.map((o) => (
              <p className="hint" key={`${c.jobId}-${o.jobId}`}>
                This scenario assumes <JobPhrase job={c} /> continued alongside{" "}
                <JobPhrase job={{ ...o, ownerId: c.ownerId, ownerName: c.ownerName }} /> from age{" "}
                {o.fromAge} to{" "}
                {o.toAge}.
              </p>
            )),
          )}
        </>
      )}

      <p className="hint">
        Your target is age {budget.retirementAge}:{" "}
        {view.target.feasible ? (
          <strong>on track (100%)</strong>
        ) : (
          <>
            <strong>{view.targetOnTrackPct}% of the way there</strong>
            {view.target.nearestFeasibleAge !== null && (
              <> — the nearest feasible age is {view.target.nearestFeasibleAge}.</>
            )}
          </>
        )}
      </p>

      {view.earlyRetireeHealth.flagged && (
        <p className="alert alert-amber" role="status">
          Retiring at {budget.retirementAge} means{" "}
          <strong>{view.earlyRetireeHealth.gapYears} years</strong> of self-funded
          health coverage before Medicare at 65. Your health budget looks about{" "}
          <strong>{formatDollars(view.earlyRetireeHealth.shortfallMonthlyCents)}/mo</strong>{" "}
          short of a typical pre-65 cost. Estimate, not advice.
        </p>
      )}

      {/* No Medicare readout: the plan no longer steps health down at 65, because it holds no
          health figure of its own to step. Whatever the budget's health line says is what the
          projection charges, for as long as the line runs — the user changes it in
          Base + Adjustments like any other expense. The pre-65 gap check above survives, since
          it reads the authored line and synthesises no cost. */}
    </>
  );
}
