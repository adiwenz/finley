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
 * behind the plan, and the surfaces reading it are responsible for not passing an old answer off
 * as the current plan's.
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
}

export function useRetirementSurface({
  projection,
  solvedProjection,
  previewEnabled,
  jurisdiction,
}: {
  /** The live handle over what the user has authored. */
  readonly projection: SolvableProjection;
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

  return { retirement, previewResult, pending };
}
