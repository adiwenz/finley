/**
 * @vitest-environment jsdom
 *
 * The rule the deferred solve stands on: the stop-working preview runs on the projection that
 * produced the age, never on the one the user has since edited into.
 *
 * Tested here rather than through `App` because the window this is about — the frames after an
 * edit commits and before the deferred solve lands — is React's to schedule, and no test can sit
 * inside it. The hook takes the two handles as arguments, so "the solve is a plan behind" is an
 * input a test can simply state, and the assertions are about the answer rather than about
 * timing. `App` wires `useDeferredValue` to those arguments and nothing else.
 *
 * The fixtures are two real presets whose answers disagree in the way that makes the hazard
 * visible, observed in the REPL and pinned below: `student-loan` solves to 62, `default` to 76,
 * and BOTH are solvent at their own age — while `default` run at 62 runs out of money in month
 * 329. So a hybrid does not merely show a slightly-off number; it shows an insolvency that is
 * true of no plan the user has.
 */

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { Projection } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { presetById, presetState } from "../presets";
import { useRetirementSurface, type SolvableProjection } from "./useRetirementSurface";

const handleFor = (presetId: string): Projection =>
  Projection.fromState(presetState(presetById(presetId)), usJurisdiction);

/** Solves to 62. */
const PLAN_A = handleFor("student-loan");
/** Solves to 76 — and is insolvent at month 329 if run at PLAN_A's age instead of its own. */
const PLAN_B = handleFor("default");

const HYBRID_INSOLVENT_MONTH = 329;

function renderSurface(initial: {
  projection: SolvableProjection;
  solvedProjection: SolvableProjection;
  previewEnabled: boolean;
}) {
  return renderHook(
    (props: typeof initial) => useRetirementSurface({ ...props, jurisdiction: usJurisdiction }),
    { initialProps: initial },
  );
}

describe("useRetirementSurface — the age and its preview come off one projection", () => {
  it("pins the fixtures the hazard depends on", () => {
    // If either age moves, the tests below stop testing the thing they are named for — so the
    // disagreement is asserted directly rather than assumed from the preset ids.
    expect(PLAN_A.retirement(usJurisdiction).solution.fullRetirementAge).toBe(62);
    expect(PLAN_B.retirement(usJurisdiction).solution.fullRetirementAge).toBe(76);
    expect(PLAN_A.runAtStopWorkingAge(usJurisdiction, 62).firstInsolventMonth).toBeNull();
    expect(PLAN_B.runAtStopWorkingAge(usJurisdiction, 76).firstInsolventMonth).toBeNull();
    // The hybrid: plan B at plan A's age. An answer belonging to neither.
    expect(PLAN_B.runAtStopWorkingAge(usJurisdiction, 62).firstInsolventMonth).toBe(
      HYBRID_INSOLVENT_MONTH,
    );
  });

  it("never previews the edited plan at the previous plan's age", () => {
    const { result, rerender } = renderSurface({
      projection: PLAN_A,
      solvedProjection: PLAN_A,
      previewEnabled: true,
    });

    expect(result.current.pending).toBe(false);
    expect(result.current.retirement.headlineAge).toBe(62);
    expect(result.current.previewResult?.firstInsolventMonth).toBeNull();

    // The edit commits. The solve has not caught up: `useDeferredValue` still hands back the
    // handle it solved, which is the whole window this hook exists to make safe.
    rerender({ projection: PLAN_B, solvedProjection: PLAN_A, previewEnabled: true });

    expect(result.current.pending).toBe(true);
    // The retained answer is plan A's, whole: its age AND a preview run on plan A.
    expect(result.current.retirement.headlineAge).toBe(62);
    expect(result.current.previewResult?.firstInsolventMonth).toBeNull();
    // The bug this file is named for: plan B simulated at 62 would report the insolvency above.
    expect(result.current.previewResult?.firstInsolventMonth).not.toBe(HYBRID_INSOLVENT_MONTH);

    // The solve lands. Both halves move together — never the age without the preview.
    rerender({ projection: PLAN_B, solvedProjection: PLAN_B, previewEnabled: true });

    expect(result.current.pending).toBe(false);
    expect(result.current.retirement.headlineAge).toBe(76);
    expect(result.current.previewResult?.firstInsolventMonth).toBeNull();
    expect(result.current.previewResult?.series.months.length).toBe(
      PLAN_B.runAtStopWorkingAge(usJurisdiction, 76).series.months.length,
    );
  });

  it("holds the whole previous answer, not just the age, while it is behind", () => {
    const { result, rerender } = renderSurface({
      projection: PLAN_A,
      solvedProjection: PLAN_A,
      previewEnabled: true,
    });
    const solved = result.current.retirement;
    const preview = result.current.previewResult;

    rerender({ projection: PLAN_B, solvedProjection: PLAN_A, previewEnabled: true });

    // Identity, not equality. Keyed on the deferred handle alone, so an unsolved edit re-runs
    // neither the search nor the preview — which is both the point of deferring and the
    // guarantee that what is on screen is the earlier answer intact rather than a fresh mixture.
    expect(result.current.retirement).toBe(solved);
    expect(result.current.previewResult).toBe(preview);
  });

  it("reports a replaced scenario as pending rather than as the new scenario's answer", () => {
    // A preset swap replaces plan and timeline wholesale — the largest possible edit, and the
    // one where a retained age is most likely to be read as the new scenario's.
    const { result, rerender } = renderSurface({
      projection: PLAN_A,
      solvedProjection: PLAN_A,
      previewEnabled: false,
    });
    expect(result.current.retirement.headlineAge).toBe(62);

    rerender({ projection: PLAN_B, solvedProjection: PLAN_A, previewEnabled: false });
    // The old age is still readable — and flagged, which is what stops it being presented as
    // the new preset's answer.
    expect(result.current.pending).toBe(true);
    expect(result.current.retirement.headlineAge).toBe(62);

    rerender({ projection: PLAN_B, solvedProjection: PLAN_B, previewEnabled: false });
    expect(result.current.pending).toBe(false);
    expect(result.current.retirement.headlineAge).toBe(76);
  });

  it("costs nothing when the preview is off", () => {
    const { result } = renderSurface({
      projection: PLAN_A,
      solvedProjection: PLAN_A,
      previewEnabled: false,
    });
    expect(result.current.previewResult).toBeNull();
  });
});
