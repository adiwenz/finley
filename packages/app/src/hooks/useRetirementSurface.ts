/**
 * The retirement answer and its preview, kept on ONE projection.
 *
 * The solve is deferred (see `main.tsx`), so at any moment there are two handles in play: the
 * `projection` the user is editing, and the `solvedProjection` the answer on screen was computed
 * from. Everything the solve produces — the headline age, the chart's reference month, the
 * "what if everyone stopped working then" preview — has to come off the SAME one, or the screen
 * shows a result belonging to no plan at all.
 *
 * That hybrid is not hypothetical. Running the *current* plan at an age solved from the
 * *previous* one is a plausible-looking mistake, and its output is worse than a stale answer:
 * plan A solves to 65, the user edits it into plan B (which solves to 72), and for the frames
 * before the new solve lands the charts draw plan B stopped at 65 — insolvent, and true of
 * nothing. Plan A at 65 is a real answer that is a moment old. Plan B at 65 is not an answer.
 *
 * So the rule is simple, and this module exists to hold it in one place rather than as a
 * convention three `useMemo` calls in `App` have to keep: **the preview runs on the projection
 * that produced the age.** {@link RetirementSurface.pending} then says outright that the pair is
 * behind the plan.
 *
 * The second rule follows from where a surface sits rather than from what it draws. A stale
 * preview is honest on a READ-ONLY overlay — a real answer, one edit old, and labelled as
 * recalculating. It is not honest on an AUTHORING surface, where the rows, names and controls
 * beside it come off the live plan: the user would be editing plan B while reading plan A's
 * numbers, and any label the live plan supplies (an account's new name, an obligation it no
 * longer has) would be attached to balances that never belonged to it. So this module hands out
 * the two results by SURFACE — {@link RetirementSurface.chartResult} for the overlays,
 * {@link RetirementSurface.authoringResult} for anything editable or labelled from the live
 * projection — rather than leaving each caller to re-derive the distinction from `pending`.
 */

import { useMemo } from "react";
import type { Jurisdiction, Projection, ProjectionResult } from "@finley/engine";
import { retirementView, type RetirementView } from "../retirementView";

/**
 * What this needs of a projection: the solve, and the preview run at a solved age. Narrow so a
 * test can state two distinct handles without building two whole apps — which is also the only
 * way to observe the pending window deterministically, since React decides when a deferred value
 * catches up and no test can sit inside that decision.
 */
export type SolvableProjection = Pick<Projection, "retirement" | "runAtStopWorkingAge">;

export interface RetirementSurface {
  /** The solved answer — always read off {@link pending}'s older projection when one exists. */
  readonly retirement: RetirementView;
  /**
   * The stop-working preview run, or `null` when the toggle is off or no age is feasible. Built
   * from the same projection as {@link retirement}, never from the live one.
   */
  readonly previewResult: ProjectionResult | null;
  /**
   * The answer above describes an EARLIER plan than the one being edited. Callers must not
   * present it as the current plan's: say it is recalculating, and do not let it drive a write
   * or open a new preview until it catches up.
   */
  readonly pending: boolean;
  /**
   * What the READ-ONLY overlays draw: the preview while previewing, the authored run otherwise.
   * May be a plan behind — internally consistent, but say so ({@link pending}) rather than
   * letting it read as the plan the user just typed.
   */
  readonly chartResult: ProjectionResult;
  /**
   * What every EDITABLE surface draws, and what anything labelled from the live projection is
   * paired with: the same preview once it has caught up, the authored run while it has not.
   * Never a series from one plan beside rows, names or controls from another.
   */
  readonly authoringResult: ProjectionResult;
}

export function useRetirementSurface({
  projection,
  authoredResult,
  solvedProjection,
  previewEnabled,
  jurisdiction,
}: {
  /** The live handle over what the user has authored. */
  readonly projection: SolvableProjection;
  /**
   * `projection.run(jurisdiction)` — the authored plan, no search involved, so it is current on
   * the render the edit commits. It is what the two results below fall back to.
   */
  readonly authoredResult: ProjectionResult;
  /** The handle the solve is allowed to lag on — `useDeferredValue(projection)` in the app. */
  readonly solvedProjection: SolvableProjection;
  readonly previewEnabled: boolean;
  readonly jurisdiction: Jurisdiction;
}): RetirementSurface {
  // Identity, not equality: `useDeferredValue` hands back the PREVIOUS value itself while it is
  // behind, so the two are the same object exactly when the solve is current.
  const pending = solvedProjection !== projection;

  // Keyed on the deferred handle alone, which is the point of deferring: an edit that has not
  // been solved yet must not invalidate this, or the search runs on the render it was moved off.
  const retirement = useMemo(
    () => retirementView(solvedProjection, jurisdiction),
    [solvedProjection, jurisdiction],
  );

  // Gated on the toggle as well as the age: an ordinary edit re-renders this on every keystroke,
  // and the preview is off far more often than on, so turning it ON is what pays for the extra
  // simulation. `solvedProjection` here is the whole point — see the module doc.
  const previewResult = useMemo(
    () =>
      previewEnabled && retirement.headlineAge !== null
        ? solvedProjection.runAtStopWorkingAge(jurisdiction, retirement.headlineAge)
        : null,
    [solvedProjection, previewEnabled, retirement.headlineAge, jurisdiction],
  );

  // The two surfaces, split on where the caller sits rather than on what it draws — see the
  // module doc. `pending` is the only difference between them, and it is spent here so no caller
  // has to remember to spend it: an authoring surface that forgets looks exactly like one that
  // didn't, until the day the two plans disagree.
  const chartResult = previewResult ?? authoredResult;
  const authoringResult = pending ? authoredResult : chartResult;

  return { retirement, previewResult, pending, chartResult, authoringResult };
}
