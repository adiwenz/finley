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
 *
 * The second describe is the other half of the rule, and it now splits in two: `chartResult` (the
 * retirement preview graph) DOES keep drawing the retained preview through the pending window —
 * that is the point, a complete stale answer beats a mid-transition mixture — while
 * `authoringResult` (every editable surface) never does, falling back to the live authored run
 * unconditionally. The presets are chosen so the two plans disagree about what exists, not only
 * about how much — `student-loan` carries a loan the `default` plan does not — because that is
 * what would turn a stale number into a false one if `authoringResult` still drew it.
 */

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  dollarsToCents,
  liabilityKindLabel,
  planHorizonMonths,
  Projection,
  ref,
  SYNTHETIC_CARD_ID,
  type ProjectionResult,
  type ProjectionSeries,
  type ScenarioInput,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { presetById, presetState } from "../presets";
import { DEFAULT_INPUT } from "../planDefaults";
import { buildNetWorthBreakdown } from "../components/netWorthChart/netWorthBreakdown";
import { useRetirementSurface, type SolvableProjection } from "./useRetirementSurface";

const handleFor = (presetId: string): Projection =>
  Projection.fromState(presetState(presetById(presetId)), usJurisdiction);

/** Solves to 62. Carries a student loan — the obligation the edited plan below no longer has. */
const PLAN_A = handleFor("student-loan");
/** Solves to 76 — and is insolvent at month 329 if run at PLAN_A's age instead of its own. */
const PLAN_B = handleFor("default");

const RUN_A = PLAN_A.run(usJurisdiction);
const RUN_B = PLAN_B.run(usJurisdiction);

const HYBRID_INSOLVENT_MONTH = 329;

function renderSurface(initial: {
  projection: SolvableProjection;
  authoredResult: ProjectionResult;
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
      authoredResult: RUN_A,
      solvedProjection: PLAN_A,
      previewEnabled: true,
    });

    expect(result.current.pending).toBe(false);
    expect(result.current.retirement.headlineAge).toBe(62);
    expect(result.current.previewResult?.firstInsolventMonth).toBeNull();

    // The edit commits. The solve has not caught up: `useDeferredValue` still hands back the
    // handle it solved, which is the whole window this hook exists to make safe.
    rerender({
      projection: PLAN_B,
      authoredResult: RUN_B,
      solvedProjection: PLAN_A,
      previewEnabled: true,
    });

    expect(result.current.pending).toBe(true);
    // The retained answer is plan A's, whole: its age AND a preview run on plan A.
    expect(result.current.retirement.headlineAge).toBe(62);
    expect(result.current.previewResult?.firstInsolventMonth).toBeNull();
    // The bug this file is named for: plan B simulated at 62 would report the insolvency above.
    expect(result.current.previewResult?.firstInsolventMonth).not.toBe(HYBRID_INSOLVENT_MONTH);

    // The solve lands. Both halves move together — never the age without the preview.
    rerender({
      projection: PLAN_B,
      authoredResult: RUN_B,
      solvedProjection: PLAN_B,
      previewEnabled: true,
    });

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
      authoredResult: RUN_A,
      solvedProjection: PLAN_A,
      previewEnabled: true,
    });
    const solved = result.current.retirement;
    const preview = result.current.previewResult;

    rerender({
      projection: PLAN_B,
      authoredResult: RUN_B,
      solvedProjection: PLAN_A,
      previewEnabled: true,
    });

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
      authoredResult: RUN_A,
      solvedProjection: PLAN_A,
      previewEnabled: false,
    });
    expect(result.current.retirement.headlineAge).toBe(62);

    rerender({
      projection: PLAN_B,
      authoredResult: RUN_B,
      solvedProjection: PLAN_A,
      previewEnabled: false,
    });
    // The old age is still readable — and flagged, which is what stops it being presented as
    // the new preset's answer.
    expect(result.current.pending).toBe(true);
    expect(result.current.retirement.headlineAge).toBe(62);

    rerender({
      projection: PLAN_B,
      authoredResult: RUN_B,
      solvedProjection: PLAN_B,
      previewEnabled: false,
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.retirement.headlineAge).toBe(76);
  });

  it("costs nothing when the preview is off", () => {
    const { result } = renderSurface({
      projection: PLAN_A,
      authoredResult: RUN_A,
      solvedProjection: PLAN_A,
      previewEnabled: false,
    });
    expect(result.current.previewResult).toBeNull();
  });
});

/**
 * A saver whose goal fund is a NAMED account carrying a real balance — the only account a user
 * can rename, and the one the breakdown's metadata therefore speaks for. Pay is high enough that
 * a contribution leaves the plan solvent and feasible, so the two variants below differ in what
 * the fund holds rather than in whether an answer exists at all.
 */
function saverWithFund(goalName: string, contributionDollars: number): Projection {
  const job = DEFAULT_INPUT.jobs![0];
  const input: ScenarioInput = {
    ...DEFAULT_INPUT,
    jobs: [
      {
        ...job,
        salary: {
          ...job.salary!,
          startingSalaryCents: dollarsToCents(8_000) * 12,
          currentSalaryCents: dollarsToCents(8_000) * 12,
        },
      },
    ],
    // One goal, named by ref so the contribution line below can target the fund account the
    // engine derives for it — that account's LABEL is the goal's name, which is what a rename
    // moves and what the breakdown reads off the live projection.
    goals: [{ ...DEFAULT_INPUT.goals![0], ref: ref("fund"), name: goalName }],
    budgetLines: [
      ...DEFAULT_INPUT.budgetLines!,
      {
        label: goalName,
        target: { kind: "account", accountRef: ref("fund"), taxTreatment: "postTax" },
        amountSource: { kind: "literal", monthlyCents: dollarsToCents(contributionDollars) },
        category: "savings",
      },
    ],
  };
  const built = Projection.fromInput(input, usJurisdiction);
  if (!built.ok) throw new Error(`fixture is not a valid ScenarioInput: ${built.error.reason}`);
  return built.projection;
}

/** The fund account both variants below hold, whatever it is called at the time. */
const FUND_ACCOUNT_ID = "fund-goal-1";
/** Far enough in that the two contribution rates have visibly diverged. */
const A_LATER_MONTH = 120;

/** "Emergency fund", $300/mo into it. Solves to 62. */
const BEFORE_RENAME = saverWithFund("Emergency fund", 300);
/** The same plan after a rename and a bigger contribution — same account id. Solves to 65. */
const AFTER_RENAME = saverWithFund("House deposit", 1_000);

const RUN_BEFORE_RENAME = BEFORE_RENAME.run(usJurisdiction);
const RUN_AFTER_RENAME = AFTER_RENAME.run(usJurisdiction);

/**
 * The breakdown metadata exactly as `App` builds it: names and order off the LIVE projection,
 * liabilities labelled by kind off the live run's household. Every band a series carries is
 * described by this and by nothing else — which is why the series paired with it has to be the
 * live plan's too.
 */
function liveBreakdownMeta(projection: Projection, run: ProjectionResult) {
  const liabilityLabels: Record<string, string> = {
    [SYNTHETIC_CARD_ID]: liabilityKindLabel("creditCard"),
  };
  for (const liability of run.household.liabilities) {
    liabilityLabels[liability.id] = liabilityKindLabel(liability.kind);
  }
  return { accounts: projection.accountDescriptors(), liabilityLabels };
}

/** Bands the metadata cannot name — a balance from a plan other than the one doing the naming. */
function unlabelledLiabilityBands(
  series: ProjectionSeries,
  meta: ReturnType<typeof liveBreakdownMeta>,
): readonly string[] {
  return buildNetWorthBreakdown(series, meta)
    .bands.filter((band) => band.kind === "liability")
    .map((band) => band.id)
    .filter((id) => meta.liabilityLabels[id] === undefined);
}

function fundBalanceAt(
  series: ProjectionSeries,
  meta: ReturnType<typeof liveBreakdownMeta>,
  month: number,
): number | undefined {
  const data = buildNetWorthBreakdown(series, meta);
  return data.rows.find((row) => row.month === month)?.centsById[FUND_ACCOUNT_ID];
}

describe("useRetirementSurface — the preview graph and the editable surfaces answer differently while pending", () => {
  it("pins the rename fixtures", () => {
    expect(BEFORE_RENAME.retirement(usJurisdiction).solution.fullRetirementAge).toBe(62);
    expect(AFTER_RENAME.retirement(usJurisdiction).solution.fullRetirementAge).toBe(65);
    // Same account, different name, different balance — the three facts the rename case needs.
    expect(BEFORE_RENAME.accountDescriptors()).toContainEqual(
      expect.objectContaining({ id: FUND_ACCOUNT_ID, label: "Emergency fund" }),
    );
    expect(AFTER_RENAME.accountDescriptors()).toContainEqual(
      expect.objectContaining({ id: FUND_ACCOUNT_ID, label: "House deposit" }),
    );
    const before = RUN_BEFORE_RENAME.series.months[A_LATER_MONTH].accountBalancesCents;
    const after = RUN_AFTER_RENAME.series.months[A_LATER_MONTH].accountBalancesCents;
    expect(after[FUND_ACCOUNT_ID]).not.toBe(before[FUND_ACCOUNT_ID]);
  });

  it("keeps the preview graph on the retained preview while the editable surfaces move on", () => {
    const { result, rerender } = renderSurface({
      projection: PLAN_A,
      authoredResult: RUN_A,
      solvedProjection: PLAN_A,
      previewEnabled: true,
    });
    // While the solve is current, the preview graph charts the preview; editable surfaces always
    // chart the live authored run — the two agree in VALUE here only because plan A's authored
    // run and its own preview happen to be distinct objects the assertions below don't conflate.
    expect(result.current.chartResult).toBe(result.current.previewResult);
    expect(result.current.authoringResult).toBe(RUN_A);

    // The user deletes the loan — plan B. The solve has not caught up.
    rerender({
      projection: PLAN_B,
      authoredResult: RUN_B,
      solvedProjection: PLAN_A,
      previewEnabled: true,
    });

    // The toggle is still on, so the preview graph keeps showing plan A's retained preview — a
    // complete, real answer, just a moment old — rather than jumping to the live plan and back.
    // The editable surfaces, meanwhile, already show plan B: the loan is gone.
    expect(result.current.pending).toBe(true);
    expect(result.current.chartResult).toBe(result.current.previewResult);
    expect(result.current.chartResult).not.toBe(RUN_B);
    expect(result.current.authoringResult).toBe(RUN_B);
    expect(result.current.authoringResult.household.liabilities).toEqual([]);

    // The solve lands. The graph swaps straight to plan B's own preview — never through RUN_B in
    // between.
    rerender({
      projection: PLAN_B,
      authoredResult: RUN_B,
      solvedProjection: PLAN_B,
      previewEnabled: true,
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.chartResult).toBe(result.current.previewResult);
  });

  it("never puts a renamed account's label over the previous plan's balances on the editable surfaces", () => {
    const { result, rerender } = renderSurface({
      projection: BEFORE_RENAME,
      authoredResult: RUN_BEFORE_RENAME,
      solvedProjection: BEFORE_RENAME,
      previewEnabled: true,
    });

    // The user renames the fund and raises the contribution. The solve is a plan behind.
    rerender({
      projection: AFTER_RENAME,
      authoredResult: RUN_AFTER_RENAME,
      solvedProjection: BEFORE_RENAME,
      previewEnabled: true,
    });
    expect(result.current.pending).toBe(true);

    const meta = liveBreakdownMeta(AFTER_RENAME, RUN_AFTER_RENAME);
    const authored = fundBalanceAt(result.current.authoringResult.series, meta, A_LATER_MONTH);

    // Under the label "House deposit", the balance the live plan actually holds there — the
    // editable surface, which never draws the previous plan's retained preview.
    expect(authored).toBe(
      RUN_AFTER_RENAME.series.months[A_LATER_MONTH].accountBalancesCents[FUND_ACCOUNT_ID],
    );
    // `authoringResult` is always the live authored run — the account metadata built off it
    // therefore never goes unlabelled on it, pending or not.
    expect(unlabelledLiabilityBands(result.current.authoringResult.series, meta)).toEqual([]);
  });

  it("resumes the preview graph once the solve lands, while the editable surface stays live throughout", () => {
    const { result, rerender } = renderSurface({
      projection: BEFORE_RENAME,
      authoredResult: RUN_BEFORE_RENAME,
      solvedProjection: BEFORE_RENAME,
      previewEnabled: true,
    });
    rerender({
      projection: AFTER_RENAME,
      authoredResult: RUN_AFTER_RENAME,
      solvedProjection: BEFORE_RENAME,
      previewEnabled: true,
    });
    rerender({
      projection: AFTER_RENAME,
      authoredResult: RUN_AFTER_RENAME,
      solvedProjection: AFTER_RENAME,
      previewEnabled: true,
    });

    expect(result.current.pending).toBe(false);
    // The preview graph is back on the new plan's own preview, at the age solved from it.
    expect(result.current.retirement.headlineAge).toBe(65);
    expect(result.current.chartResult).toBe(result.current.previewResult);
    // The editable surface was never behind to begin with — it is the live authored run before,
    // during and after the solve.
    expect(result.current.authoringResult).toBe(RUN_AFTER_RENAME);
  });

  it("draws the authored run everywhere when the preview is off", () => {
    const { result, rerender } = renderSurface({
      projection: PLAN_A,
      authoredResult: RUN_A,
      solvedProjection: PLAN_A,
      previewEnabled: false,
    });
    expect(result.current.chartResult).toBe(RUN_A);
    expect(result.current.authoringResult).toBe(RUN_A);

    // Nothing to be a plan behind ON: with no preview, both surfaces already draw the live run.
    rerender({
      projection: PLAN_B,
      authoredResult: RUN_B,
      solvedProjection: PLAN_A,
      previewEnabled: false,
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.chartResult).toBe(RUN_B);
    expect(result.current.authoringResult).toBe(RUN_B);
  });
});

/**
 * A life-expectancy change is the case that made the hazard visible: the plan's span itself
 * moves, so a chart that kept the OLD preview series but adopted the NEW horizon would resize
 * once when the edit commits (to the new life expectancy) and again when the new preview lands
 * (as the series catches up) — two visible moves for one edit. `chartHorizonMonths` exists so the
 * axis is paired with `chartResult` exactly the way `retirement` is paired with the projection
 * that solved it.
 */
function projectionWithLifeExpectancy(lifeExpectancy: number): Projection {
  const input: ScenarioInput = { ...DEFAULT_INPUT, lifeExpectancy };
  const built = Projection.fromInput(input, usJurisdiction);
  if (!built.ok) throw new Error(`fixture is not a valid ScenarioInput: ${built.error.reason}`);
  return built.projection;
}

/** Life expectancy 85. */
const YOUNGER_HORIZON = projectionWithLifeExpectancy(85);
/** Life expectancy 95 — a later horizon than {@link YOUNGER_HORIZON}. */
const OLDER_HORIZON = projectionWithLifeExpectancy(95);

const RUN_YOUNGER_HORIZON = YOUNGER_HORIZON.run(usJurisdiction);
const RUN_OLDER_HORIZON = OLDER_HORIZON.run(usJurisdiction);

describe("useRetirementSurface — the preview horizon stays paired with the preview series", () => {
  it("keeps the OLD horizon beside the retained preview while a life-expectancy edit is pending", () => {
    const { result, rerender } = renderSurface({
      projection: YOUNGER_HORIZON,
      authoredResult: RUN_YOUNGER_HORIZON,
      solvedProjection: YOUNGER_HORIZON,
      previewEnabled: true,
    });
    expect(result.current.chartHorizonMonths).toBe(planHorizonMonths(YOUNGER_HORIZON.plan));

    // The user raises life expectancy to 95. The solve has not caught up.
    rerender({
      projection: OLDER_HORIZON,
      authoredResult: RUN_OLDER_HORIZON,
      solvedProjection: YOUNGER_HORIZON,
      previewEnabled: true,
    });

    expect(result.current.pending).toBe(true);
    // The series is still the OLD preview...
    expect(result.current.chartResult).toBe(result.current.previewResult);
    expect(result.current.chartResult).not.toBe(RUN_OLDER_HORIZON);
    // ...and the axis must still be the horizon THAT preview was drawn against, not the live
    // plan's — otherwise the chart would show age-85 data plotted against a 95-year axis.
    expect(result.current.chartHorizonMonths).toBe(planHorizonMonths(YOUNGER_HORIZON.plan));
    expect(result.current.chartHorizonMonths).not.toBe(planHorizonMonths(OLDER_HORIZON.plan));

    // The solve lands. Series and horizon switch together, in one step.
    rerender({
      projection: OLDER_HORIZON,
      authoredResult: RUN_OLDER_HORIZON,
      solvedProjection: OLDER_HORIZON,
      previewEnabled: true,
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.chartResult).toBe(result.current.previewResult);
    expect(result.current.chartHorizonMonths).toBe(planHorizonMonths(OLDER_HORIZON.plan));
  });

  it("tracks the live horizon immediately when the preview toggle is off", () => {
    // With no preview to retain, `chartResult` already falls back to the live authored run (see
    // "draws the authored run everywhere when the preview is off" above) — the horizon follows
    // the same live plan, even while a solve is pending.
    const { result, rerender } = renderSurface({
      projection: YOUNGER_HORIZON,
      authoredResult: RUN_YOUNGER_HORIZON,
      solvedProjection: YOUNGER_HORIZON,
      previewEnabled: false,
    });
    rerender({
      projection: OLDER_HORIZON,
      authoredResult: RUN_OLDER_HORIZON,
      solvedProjection: YOUNGER_HORIZON,
      previewEnabled: false,
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.chartHorizonMonths).toBe(planHorizonMonths(OLDER_HORIZON.plan));
  });
});
