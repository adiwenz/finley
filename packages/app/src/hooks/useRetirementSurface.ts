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
 * The second rule is about what each surface is allowed to show while a solve is behind, and the
 * two kinds of surface answer it differently:
 *
 * - **Editable surfaces** (Base + Adjustments, the jobs list, the account breakdown) draw the
 *   plan the user is actually authoring. {@link RetirementSurface.authoringResult} is simply the
 *   live `authoredResult` — always, whether or not the preview toggle is on and whether or not a
 *   solve is in flight. There is no version of "editing the plan" that should show a hypothetical
 *   instead of what was typed.
 * - **The retirement preview graph** treats "preview on" as a complete snapshot rather than a
 *   live readout: {@link RetirementSurface.chartResult} shows `previewResult` — which, because it
 *   is keyed on `solvedProjection`, already IS the last COMPLETE preview during the pending
 *   window, paired with the age that produced it — right up until the new solve lands, then
 *   switches straight to the new one. It never passes through the live authored plan in between;
 *   doing so would mean the graph visibly changes twice per edit (old preview → authored → new
 *   preview) instead of once (old preview → new preview). With the toggle off there is no preview
 *   to hold onto, so `chartResult` is just the live authored run, same as `authoringResult`.
 *
 * Only the headline age and its own preview run ({@link RetirementSurface.retirement},
 * {@link RetirementSurface.previewResult}) are allowed to lag, because there is no live
 * substitute for a search that has not finished — and callers that show them say so via
 * {@link RetirementSurface.pending} rather than presenting them as current.
 */

import { useMemo } from "react";
import { planHorizonMonths } from "@finley/engine";
import type { Jurisdiction, Projection, ProjectionResult } from "@finley/engine";
import { retirementView, type RetirementView } from "../retirementView";

/**
 * What this needs of a projection: the solve, the preview run at a solved age, and the plan
 * scalars `retirementView` and the chart's horizon read off the same handle. Narrow so a
 * test can state two distinct handles without building two whole apps — which is also the only
 * way to observe the pending window deterministically, since React decides when a deferred value
 * catches up and no test can sit inside that decision.
 */
export type SolvableProjection = Pick<
  Projection,
  "retirement" | "runAtStopWorkingAge" | "plan"
>;

export interface RetirementSurface {
  /** The solved answer — always read off {@link pending}'s older projection when one exists. */
  readonly retirement: RetirementView;
  /**
   * The stop-working preview run, or `null` when the toggle is off or no age is feasible. Built
   * from the same projection as {@link retirement}, never from the live one.
   */
  readonly previewResult: ProjectionResult | null;
  /**
   * The headline age and {@link previewResult} above describe an EARLIER plan than the one being
   * edited. Callers must not present either as the current plan's: say the answer is
   * recalculating, and do not let it drive a write until it catches up.
   */
  readonly pending: boolean;
  /**
   * What the retirement PREVIEW graph draws: the last complete {@link previewResult} while the
   * toggle is on — stale during {@link pending}, but a real, internally-consistent snapshot, never
   * swapped for the live authored plan in between — or the live authored run while the toggle is
   * off. See the module doc for why this must NOT fall back to the authored run mid-solve.
   */
  readonly chartResult: ProjectionResult;
  /**
   * The horizon {@link chartResult} was produced against — paired with it exactly the way
   * {@link retirement} is paired with the projection that solved it. While a stale preview is
   * retained mid-solve, its axis must stay the horizon IT was drawn against, or the chart resizes
   * once when the edit commits and again when the new preview lands, for a graph that never
   * moved. See the module doc's rule for {@link chartResult}; this is the same rule for the span
   * that decorates it.
   */
  readonly chartHorizonMonths: number;
  /**
   * What every EDITABLE surface draws: the live authored run, unconditionally. Never the preview,
   * whether or not the toggle is on and whether or not a solve is in flight — see the module doc.
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

  // The preview graph: `previewResult` while the toggle is on, `pending` or not — it is already
  // the last COMPLETE preview during the pending window (see the module doc), so this is how the
  // graph moves old preview -> new preview in one step rather than through the live plan between
  // them. Falls back to the authored run only when there is no preview to show at all: the
  // toggle is off, or no age is feasible.
  const chartResult = previewEnabled ? (previewResult ?? authoredResult) : authoredResult;

  // Paired with `chartResult` by the same condition that picks it: when the graph is drawing
  // `previewResult`, the horizon has to be the plan `previewResult` was solved against
  // (`solvedProjection`, which does not move during the pending window) — never the live plan's,
  // or the axis would resize on the render an edit commits and again when the new preview lands.
  const chartHorizonMonths =
    previewEnabled && previewResult !== null
      ? planHorizonMonths(solvedProjection.plan)
      : planHorizonMonths(projection.plan);

  // Every editable surface draws the plan being authored, full stop — never the hypothetical.
  const authoringResult = authoredResult;

  return {
    retirement,
    previewResult,
    pending,
    chartResult,
    chartHorizonMonths,
    authoringResult,
  };
}
