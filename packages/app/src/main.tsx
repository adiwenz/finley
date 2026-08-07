import { StrictMode, useCallback, useDeferredValue, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Projection, liabilityKindLabel, planHorizonMonths, SYNTHETIC_CARD_ID } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { NetWorthChart } from "./components/netWorthChart/netWorthChart";
import { NetWorthBreakdownChart } from "./components/netWorthChart/netWorthBreakdownChart";
import { buildNetWorthBreakdown } from "./components/netWorthChart/netWorthBreakdown";
import { timelineMarkers } from "./ledgerView";
import { monthLabel } from "./format";
import { AddEventForm } from "./components/addEventForm/addEventForm";
import { EDITABLE_EVENT_TYPES } from "./components/addEventForm/editEventForm";
import { Timeline } from "./components/timeline/timeline";
import { SnapshotPanel } from "./components/snapshotPanel/snapshotPanel";
import { BudgetEditor } from "./components/budgetEditor/budgetEditor";
import { GoalsPanel } from "./components/goalsPanel/goalsPanel";
import { CollapsibleCard } from "./components/collapsibleCard/collapsibleCard";
import { RetirementPanel } from "./components/retirementPanel/retirementPanel";
import { DebugPanel } from "./components/debugPanel/debugPanel";
import { BaseAdjustmentsPanel } from "./components/baseAdjustments/baseAdjustmentsPanel";
import { JobsPanel } from "./components/jobsPanel/jobsPanel";
import { useRetirementSurface } from "./hooks/useRetirementSurface";
import { OBLIGATION_SURFACE_ANCHORS } from "./components/baseAdjustments/obligationLink";
import { useProjection } from "./hooks/useProjection";
import { DEFAULT_SCRUB_MONTH } from "./planDefaults";
import { PRESETS, presetById, presetState, type Preset } from "./presets";
import { StartingPositionPanel } from "./components/startingPositionPanel/startingPositionPanel";
import "./assets/styles/tokens.css";
import "./assets/styles/globals.css";

/**
 * The state a fresh session opens on — the first preset's plan with no timeline. Built once
 * at module load, so every render starts from the same immutable {@link ProjectionState}.
 */
const INITIAL_STATE = presetState(PRESETS[0]);

export function App() {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [scrubMonth, setScrubMonth] = useState(DEFAULT_SCRUB_MONTH);
  // Whether the charts show the "if everyone stopped working at the solved age" preview rather
  // than the authored plan. A pure view flag — it never touches the state the app authors.
  const [previewRetirement, setPreviewRetirement] = useState(false);
  // Which timeline event is open for editing, by id — the add-event card reopens pre-filled on
  // it. Held by id, not by value, so it always resolves against the live ledger and a revision
  // that moved the event is reflected without re-seeding.
  const [editingId, setEditingId] = useState<string | null>(null);
  const { state, conflict, transact, removeEvent, loadState } = useProjection(INITIAL_STATE);
  const budget = state.scenario.plan;
  const ledger = state.scenario.ledger;

  // Load a starter simulation wholesale: plan AND seed timeline together, floored on the way
  // in by the facade. The scrub cursor snaps back to "now", the preview drops back to the
  // authored view — a fresh scenario is shown as authored, not through the last one's hypothesis
  // — and any open edit is abandoned, since its event belongs to the timeline being replaced.
  function loadPreset(preset: Preset) {
    setPresetId(preset.id);
    loadState(presetState(preset));
    setScrubMonth(DEFAULT_SCRUB_MONTH);
    setPreviewRetirement(false);
    setEditingId(null);
  }

  // Commit an event revision, then close the edit surface. Only on success — a refused revision
  // (returns `undefined`) leaves the surface open with the conflict shown, so the user's in-flight
  // edits survive. The sentinel disambiguates success from a write that returns nothing of its own.
  const reviseEvent = useCallback(
    (write: (p: Projection) => void): void => {
      const ok =
        transact((p) => {
          write(p);
          return true as const;
        }) === true;
      if (ok) setEditingId(null);
    },
    [transact],
  );

  // One handle over the current state answers every read: the graph, snapshot roster, and debug
  // report come off a single `run`, and the funding picker off the same handle's `funding` — so
  // the picker shows the numbers the §4.5 gate will decide on. Keyed on `state`, so scrubbing
  // (which touches no state) recomputes nothing.
  const projection = useMemo(() => Projection.fromState(state, usJurisdiction), [state]);
  const result = useMemo(() => projection.run(usJurisdiction), [projection]);
  const funding = useMemo(() => projection.funding(), [projection]);
  const { household, report } = result;

  // Who's in the household, by id — so a chart can name whose income a band is when the
  // label alone can't (two members' government benefits).
  const personNames = useMemo(
    () => new Map(household.memberships.map((m) => [m.person.id, m.person.name])),
    [household],
  );
  const markers = useMemo(() => timelineMarkers(ledger), [ledger]);
  // The event the edit surface is bound to, resolved live. Null when nothing is being edited or
  // when the target was removed out from under an open edit — either way the add form is shown.
  const editingEvent = useMemo(
    () => (editingId === null ? null : ledger.events.find((e) => e.id === editingId) ?? null),
    [ledger, editingId],
  );
  const insolventMonth = result.firstInsolventMonth;
  /**
   * The retirement solve is a SEARCH, not a pass: a binary search over candidate stop-working
   * ages, each a full simulation to life expectancy, plus one run of the authored plan — seven
   * simulations against the default plan, ~5× the cost of the graph's single `run` above.
   *
   * So it is deferred rather than computed on the render that commits an edit. React paints the
   * charts, the editor and the snapshot from the fresh `projection` immediately, then re-renders
   * this memo against the new one in the background; until it lands, every surface below reads
   * the previous solve. Without this, each committed keystroke waited on the whole search before
   * anything could paint.
   *
   * Deferred rather than GATED on the retirement panel being open, which was the obvious move
   * and is wrong: the solved age is not panel-local. It dates the graph's retirement reference
   * line and is what `previewResult` simulates at, both visible with the panel untouched.
   *
   * The current authored plan is what every EDITABLE surface shows, always — editing never
   * blocks and never falls back to a stale plan. Only the retirement ANSWER — the headline age
   * and its own preview run, both a search — is allowed to lag, and only labelled as such. So the
   * lag is confined by three rules, and everything below is one of them:
   *
   * - **Nothing WRITES from it.** The Base + Adjustments quickstart used to bound its savings
   *   line at `retirement.plannedWorkStopAge`, which made a deferred value an input to a budget
   *   edit; it reads `projection.plannedWorkStopAge` below instead — the same figure, no search,
   *   off the live handle.
   * - **The preview graph never shows a mid-transition mixture.** With the toggle ON, a retained
   *   preview run at the previous solve's age is a real, complete answer — just a moment old —
   *   so `chartResult` KEEPS showing it, dimmed on the reference line, for the whole pending
   *   window, then swaps straight to the new preview when the solve lands. What it must never do
   *   is fall back to the live authored plan in between: that would make the graph visibly change
   *   twice per edit (old preview → authored → new preview) instead of once. With the toggle OFF
   *   there is no preview to hold onto, so `chartResult` is just the live authored run, and the
   *   reference line — which would have nowhere honest to point — is dropped rather than redrawn
   *   early. The preview TOGGLE itself is never touched either way: it keeps recording the user's
   *   intent and stays interactive throughout, per `RetirementPanel`.
   * - **Nothing EDITABLE reads it, ever.** Base + Adjustments, the jobs' pay figures and the
   *   breakdown's balances sit beside rows, names and controls from the live plan, so they take
   *   `authoringResult` — the live authored run, unconditionally, whether or not the toggle is on
   *   and whether or not a solve is behind. `useRetirementSurface` holds this.
   */
  const solvedProjection = useDeferredValue(projection);
  /**
   * The retirement panel reasons about the SAME scenario the graph draws — plan plus the live
   * ledger — so "when can we retire?" reflects every event the user added (a child, a new
   * expense, a separation), not the bare plan.
   *
   * The answer and its stop-working preview come back paired, off ONE handle, and
   * `retirementPending` says when that pair is a plan behind — see `useRetirementSurface`, which
   * holds the reasoning and the hazard the pairing exists to prevent.
   */
  const {
    retirement,
    pending: retirementPending,
    chartResult,
    authoringResult,
  } = useRetirementSurface({
    projection,
    authoredResult: result,
    solvedProjection,
    previewEnabled: previewRetirement,
    jurisdiction: usJurisdiction,
  });

  /**
   * Where the Base + Adjustments quickstart stops its savings line. Read off the LIVE handle,
   * not the solve: it is a plain read of when the authored jobs stop paying — no search — and it
   * is an authoring input, since the quickstart writes a budget bounded by it. A deferred value
   * is fine to draw with and not fine to write from.
   */
  const plannedWorkStopAge = useMemo(
    () => projection.plannedWorkStopAge(usJurisdiction),
    [projection],
  );
  // The toggle's own intent, not a read of whether a preview happens to be on screen right now:
  // it stays exactly what the user last set it to through a recalculation, per `RetirementPanel`
  // — the charts, not this flag, are what fall back while the solve is behind.
  const previewing = previewRetirement;
  // What the main net-worth graph draws: the preview (even a stale one, labelled below) while
  // toggled on, the authored run otherwise. `authoringSeries` is every EDITABLE surface's series
  // instead — the live authored run, unconditionally — see `useRetirementSurface`.
  const chartSeries = chartResult.series;
  const authoringSeries = authoringResult.series;

  // Chart, timeline, and event picker all span "now" → life expectancy.
  const horizonMonths = planHorizonMonths(budget);

  // The net-worth *breakdown* chart's data. Names/order come through supported engine seams
  // — account descriptors and the household's liabilities, labelled by kind — never the
  // SimAccount class, so presentation stays off the sim-construction path.
  //
  // Those names come off the LIVE projection, so the balances they label have to as well: this
  // reads `authoringSeries`, not `chartSeries`. A renamed account or a discharged mortgage would
  // otherwise relabel a preview that predates the rename — the account's new name over the old
  // plan's balances, which is not a stale answer but a fabricated one.
  const breakdown = useMemo(() => {
    // The engine's synthetic last-resort borrowing is a revolving credit card in the model,
    // so it charts as "Credit card" debt below zero: a plan living on borrowed money (or one
    // running dry in late retirement) shows that debt rather than the composition stopping.
    const liabilityLabels: Record<string, string> = {
      [SYNTHETIC_CARD_ID]: liabilityKindLabel("creditCard"),
    };
    for (const liability of household.liabilities) {
      liabilityLabels[liability.id] = liabilityKindLabel(liability.kind);
    }
    return buildNetWorthBreakdown(
      authoringSeries,
      { accounts: projection.accountDescriptors(), liabilityLabels },
      // The plan's own span, so this chart ends at the same year as the total above it.
      horizonMonths,
    );
  }, [authoringSeries, projection, household, horizonMonths]);

  return (
    <>
      <h1>Your financial life</h1>
      <p className="sub">
        {budget.name || "You"} · outlook to age {budget.lifeExpectancy} · jurisdiction:{" "}
        {usJurisdiction.id}
      </p>

      <label className="field preset-picker">
        <span className="field-label">Start from a scenario</span>
        <select
          value={presetId}
          onChange={(e) => loadPreset(presetById(e.target.value))}
        >
          {PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        <span className="preset-desc">{presetById(presetId).description}</span>
      </label>

      <div className="layout">
        <div className="main-col">
          <div className="card">
            {/* The plan's own span, so the axis reaches life expectancy even when the projection
                stopped early — a blocked series is truncated at the block. */}
            <NetWorthChart
              series={chartSeries}
              // With the toggle OFF, `chartSeries` is the live authored run, so a month solved
              // from the previous plan would land somewhere arbitrary on it — dropped while
              // pending, same as before. With the toggle ON, `chartSeries` IS the preview that
              // produced this month (see `useRetirementSurface.chartResult`), so the line stays
              // paired with it and only dims — see `retirementMonthMuted` below.
              retirementMonth={
                retirementPending && !previewing ? null : retirement.headlineMonth
              }
              retirementMonthMuted={retirementPending && previewing}
              horizonMonths={horizonMonths}
            />

            {/* The toggle is on, and the graph above is still showing the LAST complete preview
                — not the current plan, and not a mixture — while the new one solves. Said
                outright so a reader sees why the boundary looks a little stale rather than
                reading it as broken. The graph moves old preview -> new preview in one step once
                the solve lands; it never shows the authored plan in between. */}
            {retirementPending && previewing && (
              <p className="hint" role="status">
                Recalculating your stop-working age — still showing your last preview.
              </p>
            )}

            {/* Deep-link target for a read-only obligation whose fact lives on the timeline —
                an event-spawned expense or a loan payment (see Base + Adjustments). */}
            <div id={OBLIGATION_SURFACE_ANCHORS.timeline}>
              <Timeline
                markers={markers}
                scrubMonth={scrubMonth}
                horizonMonths={horizonMonths}
                editableTypes={EDITABLE_EVENT_TYPES}
                onScrub={setScrubMonth}
                onEdit={setEditingId}
                onRemove={removeEvent}
              />
            </div>

            {conflict && (
              <div className="alert alert-red">Can’t do that yet: {conflict}</div>
            )}
            {insolventMonth !== null && (
              <div className="alert alert-red">
                Plan becomes unfinanceable at {monthLabel(insolventMonth)}. Credit
                is exhausted — structural changes required.
              </div>
            )}

            <p className="disclaimer">
              Estimates include federal income tax for a single filer only — no state
              or payroll tax. Not a licensed financial advisor. Jurisdiction:{" "}
              {usJurisdiction.id}.
            </p>

            {report.assumptions.length > 0 && (
              <details className="assumptions">
                <summary>Assumptions &amp; simplifications</summary>
                <ul>
                  {report.assumptions.map((a) => (
                    <li key={a.id}>{a.text}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <div className="card">
            <SnapshotPanel ledger={ledger} result={result} month={scrubMonth} />
          </div>
        </div>

        <div className="side-col">
          <div className="card">
            <AddEventForm
              result={result}
              funding={funding}
              defaultMonth={Math.floor(scrubMonth / 12) * 12}
              horizonMonths={horizonMonths}
              onAdd={transact}
              editing={
                editingEvent
                  ? { event: editingEvent, onRevise: reviseEvent, onCancel: () => setEditingId(null) }
                  : undefined
              }
            />
          </div>

          <div className="card">
            <StartingPositionPanel onAdd={transact} />
          </div>

          {/* Standing settings rather than a live readout: both start collapsed, so the
              panels that answer "what is happening" keep the column. */}
          <CollapsibleCard title="Budget & accounts" className="inputs">
            <BudgetEditor budget={budget} transact={transact} />
          </CollapsibleCard>

          <CollapsibleCard title="Goals">
            <GoalsPanel
              budget={budget}
              result={result}
              projection={projection}
              transact={transact}
            />
          </CollapsibleCard>

          <div className="card">
            <RetirementPanel
              view={retirement}
              budget={budget}
              previewing={previewing}
              pending={retirementPending}
              onTogglePreview={setPreviewRetirement}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <JobsPanel
          budget={budget}
          transact={transact}
          household={household}
          ledger={ledger}
          projection={projection}
          // The job LIST beside these figures is the live plan's, so the figures have to be too:
          // `authoringResult` is the live authored run unconditionally, never the retirement
          // preview — a pay display looked up from a hypothetical "everyone stopped working"
          // scenario is either about a job the user never chose to stop or missing outright.
          payDisplay={authoringResult.jobPayDisplay}
        />
      </div>

      <div className="card">
        {/* Charts `authoringSeries`, not the net-worth graph's `chartSeries` — this panel edits
            the plan it charts, and its rows, jobs and accounts come off the live handles beside
            it, so it needs the live authored series, plus the live timeline (so its spending need
            counts loan payments and every other event, not just the standing budget) — never the
            retirement preview, which `chartSeries` alone may be showing. */}
        <BaseAdjustmentsPanel
          plan={budget}
          transact={transact}
          series={authoringSeries}
          personNames={personNames}
          household={household}
          ledger={ledger}
          projection={projection}
          plannedWorkStopAge={plannedWorkStopAge}
        />
      </div>

      <div className="card">
        <DebugPanel report={report} budget={budget} projection={projection} />
      </div>

      <div className="card">
        <NetWorthBreakdownChart data={breakdown} />
      </div>
    </>
  );
}

const rootEl = document.getElementById("app");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
