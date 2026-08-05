/**
 * Retirement panel — **two** answers, kept visibly apart: does the plan the household actually
 * wrote down work, and what is the earliest they could stop all work instead?
 *
 * They are separate because neither implies the other. The solved age is reached under a
 * continuation hypothesis — someone's job modelled as never having ended — so it is not a verdict
 * on the authored plan, and the authored plan's own survival is not something the search ever
 * evaluates (see `RetirementSolution.authoredPlanSurvives`). Printing only the age invited the
 * reading that a feasible age means "your plan is fine", which it does not, and a `null` age the
 * reading that the plan fails, which it also does not.
 *
 * The plan pins no retirement age, so there is no target to score against and no verdict to
 * report on the search either: the solver's age is the only one, and it is either feasible or
 * there is none. What varies is how much the age is worth on its own. An age the authored jobs
 * already pay for is a plain fact and is stated plainly; an age that only arrives because
 * someone's job was modelled as carrying on past its authored end is a CONDITIONAL, and is
 * written as one — see the headline below.
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

/**
 * "when Sam is" / "when you are" — whose clock an age is on, said outright.
 *
 * Every age on a {@link import("@finley/engine").ContinuedJob} is its OWNER's, while the headline
 * beside it is the primary's, and the two differ by however many years apart the two people were
 * born. A bare "through age 71" in a sentence about Sam therefore reads as the household's clock
 * and is wrong by exactly that gap, so whose it is gets said rather than implied.
 *
 * The primary is "you", not their name, to match {@link JobPhrase}: that already calls their work
 * "your Software Engineer job", and "your job continued through when Alex is 66" switches person
 * mid-sentence about one person. Everyone else is named, which is the whole point.
 */
function Whose({ owner }: { owner: { ownerId: string; ownerName: string } }) {
  return owner.ownerId === PRIMARY_PERSON_ID ? (
    <>when you are</>
  ) : (
    <>when {owner.ownerName} is</>
  );
}

/**
 * The horizon age, said as whose it is. The projection runs to the LONGEST-LIVED member's life
 * expectancy, not the household's — a bare "age 90" reads as a guarantee covering everyone when it
 * is one person's own. The primary is "you" (the reader, the voice the panel already speaks in);
 * a partner who outlives them is named, so "the portfolio lasting to Sam's life expectancy" says
 * plainly that the money has to reach the survivor's years, not just the primary's.
 */
function LifeExpectancy({ age, memberName }: { age: number; memberName: string | null }) {
  const whose = memberName === null ? "your" : `${memberName}’s`;
  return (
    <>
      {whose} life expectancy (age {age})
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
  // A blocked projection has no computable retirement age at all — the money question can't be
  // asked past the block. Report that and the age it stopped at, and suppress the headline and
  // on-track lines: both would state a survival verdict the truncated projection cannot support.
  if (view.blocked) {
    return (
      <>
        <h2>Retirement</h2>
        <p className="alert alert-red" role="status">
          Can’t compute a retirement age — your projection is{" "}
          <strong>blocked at age {view.blockedAtAge}</strong>. Fund the blocking obligation
          differently to see how far your plan reaches.
        </p>
      </>
    );
  }

  return (
    <>
      <h2>Retirement</h2>

      {/* The plan as WRITTEN, answered on its own terms and first, because it is the one the
          household is actually living. Nothing here is solved: the stop age is a read of the
          authored job ends, and the survival line is one run of the plan with no boundary
          applied at all. The solved age below is a different question and gets its own heading
          rather than being appended to this one as a qualification. */}
      <h3>Current plan</h3>
      <p className="hint">
        {view.plannedWorkStopAge === null ? (
          <>Your plan holds no jobs, so it earns nothing from work.</>
        ) : (
          <>
            Every job in your plan is scheduled to end by the time you turn{" "}
            <strong>{view.plannedWorkStopAge}</strong>.
          </>
        )}{" "}
        {view.authoredPlanSurvives ? (
          <>
            This plan succeeds through <LifeExpectancy age={view.horizonAge} memberName={view.horizonMemberName} />.
          </>
        ) : (
          <>
            This plan runs out of money before <LifeExpectancy age={view.horizonAge} memberName={view.horizonMemberName} />.
          </>
        )}
      </p>

      <h3>Earliest you could stop all work</h3>

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
      {/* ONE headline sentence, in whichever of three forms the answer actually takes.
          It used to be two: the age asserted flatly, then a second sentence walking it back with
          the jobs it had assumed. That states the conclusion before its premise and overclaims in
          between — a reader who stops after the first line has been told they can retire at 71
          when what was solved is that they could IF a job they may never have picked ran five
          years past its authored end. An assumption that changes what the number means belongs
          in the sentence that gives the number, so the conditional case is written as a
          conditional. Only the overlap disclosure below stays separate: it qualifies the
          assumption, not the age. */}
      {view.headlineAge === null ? (
        <p className="alert alert-red" role="status">
          On these numbers the money never lasts to{" "}
          <LifeExpectancy age={view.horizonAge} memberName={view.horizonMemberName} /> — no retirement age is feasible.
          Structural changes are required.
        </p>
      ) : view.continuedJobs.length === 0 ? (
        <p className="hint">
          You can retire at{" "}
          <strong aria-label="Earliest feasible retirement age">{view.headlineAge}</strong> and
          have the portfolio last to <LifeExpectancy age={view.horizonAge} memberName={view.horizonMemberName} />.
        </p>
      ) : (
        <p className="hint" role="status">
          You could stop working at{" "}
          <strong aria-label="Earliest feasible retirement age">{view.headlineAge}</strong> if{" "}
          {view.continuedJobs.map((c, i) => (
            // A fragment, not a span: this is one sentence, and a wrapper element around each
            // clause would put element boundaries inside it for no reason.
            <Fragment key={c.jobId}>
              {i > 0 && (i === view.continuedJobs.length - 1 ? " and " : ", ")}
              <JobPhrase job={c} /> continued through <Whose owner={c} /> {c.throughAge} (
              {c.throughYear})
            </Fragment>
          ))}
          {/* The survival claim rides the same sentence rather than repeating the age, so two
              continued jobs read as one list and not as two sentences fighting over the number. */}
          , with the portfolio lasting to <LifeExpectancy age={view.horizonAge} memberName={view.horizonMemberName} />.
        </p>
      )}

      {/* The one thing about a continued job a reader would not predict: it never ended, so it
          now runs THROUGH the jobs that were authored to follow it, and both pay. Its own
          sentence, because it qualifies the ASSUMPTION rather than the age — folding it into the
          headline would bury the condition it is a footnote to. Named with its years, because
          that is the window where the income is doubled up. */}
      {view.continuedJobs.flatMap((c) =>
        c.overlaps.map((o) => (
          <p className="hint" key={`${c.jobId}-${o.jobId}`}>
            This scenario assumes <JobPhrase job={c} /> continued alongside{" "}
            <JobPhrase job={{ ...o, ownerId: c.ownerId, ownerName: c.ownerName }} /> from{" "}
            <Whose owner={c} /> {o.fromAge} to {o.toAge} ({o.fromYear}–{o.toYear}).
          </p>
        )),
      )}

      {view.earlyRetireeHealth.flagged && (
        <p className="alert alert-amber" role="status">
          Retiring at {view.headlineAge} means{" "}
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
