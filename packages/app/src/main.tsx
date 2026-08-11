import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Projection, liabilityKindLabel, planHorizonMonths, SYNTHETIC_CARD_ID } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { NetWorthChart } from "./components/netWorthChart/netWorthChart";
import { NetWorthBreakdownChart } from "./components/netWorthChart/netWorthBreakdownChart";
import { buildNetWorthBreakdown } from "./components/netWorthChart/netWorthBreakdown";
import { timelineMarkers, blockedWarning } from "./ledgerView";
import { BlockedWarning } from "./components/blockedWarning/blockedWarning";
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
import { retirementView } from "./retirementView";
import { OBLIGATION_SURFACE_ANCHORS } from "./components/baseAdjustments/obligationLink";
import { useProjection } from "./hooks/useProjection";
import { DEFAULT_SCRUB_MONTH } from "./planDefaults";
import { PRESETS, presetById, presetState, type Preset } from "./presets";
import { StartingPositionPanel } from "./components/startingPositionPanel/startingPositionPanel";
import { START_YEAR } from "./config";
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
  // The add/edit form's own picker: while an event is open for editing, exclude ITS OWN draw
  // from the pool — otherwise a One-Time Spend (or a down payment) being edited would see its
  // own prior amount as already spent, understating what's available to fund the very edit in
  // progress. Kept separate from `funding` above (which the blocked-projection warning reads)
  // so an in-progress edit never changes what that unrelated banner reports.
  const formFunding = useMemo(
    () => projection.funding(editingId ?? undefined),
    [projection, editingId],
  );
  const { series, household, report } = result;

  // Who's in the household, by id — so a chart can name whose income a band is when the
  // label alone can't (two members' government benefits).
  const personNames = useMemo(
    () => new Map(household.memberships.map((m) => [m.person.id, m.person.name])),
    [household],
  );
  // Markers carry per-event outcomes off the AUTHORED run, not the retirement preview: the timeline
  // is an authoring surface, so a blocked/not-reached indicator must reflect the plan as written.
  const markers = useMemo(() => timelineMarkers(ledger, series), [ledger, series]);
  // The blocked-projection soft warning, off the AUTHORED run for the same reason the markers are:
  // it names the plan as written, never the retirement preview. `null` until something stops, so
  // its mere presence IS the condition holding — persistence and clearing fall out of the render.
  const blocked = useMemo(() => blockedWarning(ledger, series, funding), [ledger, series, funding]);
  // The event the edit surface is bound to, resolved live. Null when nothing is being edited or
  // when the target was removed out from under an open edit — either way the add form is shown.
  const editingEvent = useMemo(
    () => (editingId === null ? null : ledger.events.find((e) => e.id === editingId) ?? null),
    [ledger, editingId],
  );
  const insolventMonth = result.firstInsolventMonth;
  // The retirement panel reasons about the SAME scenario the graph draws — plan plus the
  // live ledger — so "when can we retire?" reflects every event the user added (a child, a
  // new expense, a separation), not the bare plan.
  const retirement = useMemo(
    () => retirementView(projection, usJurisdiction),
    [projection],
  );

  // The "what if everyone stopped working at the solved age" run — the same non-mutating
  // stop-working boundary the solver searched with, surfaced instead of discarded. Computed
  // only when the toggle is actually on AND a feasible headline age exists — an ordinary plan
  // edit re-renders this memo on every keystroke, and the preview toggle is off far more often
  // than it's on, so gating on `previewRetirement` keeps an unused extra projection from
  // running on every edit. Turning the toggle ON is what should pay for the simulation.
  const previewResult = useMemo(
    () =>
      previewRetirement && retirement.headlineAge !== null
        ? projection.runAtStopWorkingAge(usJurisdiction, retirement.headlineAge)
        : null,
    [projection, previewRetirement, retirement.headlineAge],
  );
  // `previewResult` is already gated on `previewRetirement` above, so this collapses to a
  // simple null check — a stale toggle with no feasible age still reports itself off.
  const previewing = previewResult !== null;
  // The series the charts draw — the preview when previewing, the authored run otherwise. The
  // guard narrows `previewResult` here; only the CHARTS swap, every authoring/editing surface
  // below stays on the authored `result`.
  const chartSeries = previewResult ? previewResult.series : series;

  // Chart, timeline, and event picker all span "now" → life expectancy.
  const horizonMonths = planHorizonMonths(budget, START_YEAR);

  // The net-worth *breakdown* chart's data. Names/order come through supported engine seams
  // — account descriptors and the household's liabilities, labelled by kind — never the
  // SimAccount class, so presentation stays off the sim-construction path.
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
      chartSeries,
      { accounts: projection.accountDescriptors(), liabilityLabels },
      // The plan's own span, so this chart ends at the same year as the total above it.
      horizonMonths,
    );
  }, [chartSeries, projection, household, horizonMonths]);

  return (
    <>
      <h1>Your financial life</h1>
      <p className="sub">
        {budget.primary.name || "You"} · outlook to age {budget.primary.lifeExpectancy} · jurisdiction:{" "}
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
              retirementMonth={retirement.headlineMonth}
              horizonMonths={horizonMonths}
            />

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
            {blocked ? <BlockedWarning warning={blocked} /> : null}

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
              funding={formFunding}
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
          payDisplay={(previewResult ?? result).jobPayDisplay}
        />
      </div>

      <div className="card">
        {/* Charts the SAME series the net-worth graph draws — plan plus the live timeline
            — so its spending need counts loan payments and every other event, not just the
            standing budget. Everything rides on that one series (the engine itemizes the
            spending), so there is nothing else to pass. */}
        <BaseAdjustmentsPanel
          plan={budget}
          transact={transact}
          series={chartSeries}
          personNames={personNames}
          household={household}
          ledger={ledger}
          projection={projection}
        />
      </div>

      <div className="card">
        <DebugPanel report={report} budget={budget} month0={series.months[0]!} />
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
