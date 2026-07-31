import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Projection, liabilityKindLabel, SYNTHETIC_CARD_ID } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { NetWorthChart } from "./components/netWorthChart/netWorthChart";
import { NetWorthBreakdownChart } from "./components/netWorthChart/netWorthBreakdownChart";
import { buildNetWorthBreakdown } from "./components/netWorthChart/netWorthBreakdown";
import { timelineMarkers } from "./ledgerView";
import { planHorizonMonths } from "./config";
import { monthLabel } from "./format";
import { AddEventForm } from "./components/addEventForm/addEventForm";
import { Timeline } from "./components/timeline/timeline";
import { SnapshotPanel } from "./components/snapshotPanel/snapshotPanel";
import { BudgetEditor } from "./components/budgetEditor/budgetEditor";
import { GoalsPanel } from "./components/goalsPanel/goalsPanel";
import { RetirementPanel } from "./components/retirementPanel/retirementPanel";
import { DebugPanel } from "./components/debugPanel/debugPanel";
import { BaseAdjustmentsPanel } from "./components/baseAdjustments/baseAdjustmentsPanel";
import { JobsPanel } from "./components/jobsPanel/jobsPanel";
import { retirementView } from "./retirementView";
import { OBLIGATION_SURFACE_ANCHORS } from "./components/baseAdjustments/obligationLink";
import { useProjection } from "./hooks/useProjection";
import { DEFAULT_SCRUB_MONTH } from "./planDefaults";
import { PRESETS, presetById, presetState, type Preset } from "./presets";
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
  const { state, conflict, transact, removeEvent, loadState } = useProjection(INITIAL_STATE);
  const budget = state.scenario.plan;
  const ledger = state.scenario.ledger;

  // Load a starter simulation wholesale: plan AND seed timeline together, floored on the way
  // in by the facade. The scrub cursor snaps back to "now".
  function loadPreset(preset: Preset) {
    setPresetId(preset.id);
    loadState(presetState(preset));
    setScrubMonth(DEFAULT_SCRUB_MONTH);
  }

  // One handle over the current state answers every read: the graph, snapshot roster, and debug
  // report come off a single `run`, and the funding picker off the same handle's `funding` — so
  // the picker shows the numbers the §4.5 gate will decide on. Keyed on `state`, so scrubbing
  // (which touches no state) recomputes nothing.
  const projection = useMemo(() => Projection.fromState(state, usJurisdiction), [state]);
  const result = useMemo(() => projection.run(usJurisdiction), [projection]);
  const funding = useMemo(() => projection.funding(), [projection]);
  const { series, household, report } = result;

  // Who's in the household, by id — so a chart can name whose income a band is when the
  // label alone can't (two members' government benefits).
  const personNames = useMemo(
    () => new Map(household.memberships.map((m) => [m.person.id, m.person.name])),
    [household],
  );
  const markers = useMemo(() => timelineMarkers(ledger), [ledger]);
  const insolventMonth = result.firstInsolventMonth;
  // The retirement panel reasons about the SAME scenario the graph draws — plan plus the
  // live ledger — so "when can we retire?" reflects every event the user added (a child, a
  // new expense, a separation), not the bare plan.
  const retirement = useMemo(
    () => retirementView(projection, usJurisdiction),
    [projection],
  );
  // Chart, timeline, and event picker all span "now" → life expectancy.
  const horizonMonths = planHorizonMonths(budget.currentAge, budget.lifeExpectancy);

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
    return buildNetWorthBreakdown(series, {
      accounts: projection.accountDescriptors(),
      liabilityLabels,
    });
  }, [series, projection, household]);

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
            <NetWorthChart series={series} retirementMonth={retirement.headlineMonth} />

            {/* Deep-link target for a read-only obligation whose fact lives on the timeline —
                an event-spawned expense or a loan payment (see Base + Adjustments). */}
            <div id={OBLIGATION_SURFACE_ANCHORS.timeline}>
              <Timeline
                markers={markers}
                scrubMonth={scrubMonth}
                horizonMonths={horizonMonths}
                onScrub={setScrubMonth}
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
            />
          </div>

          {/* Deep-link target for the read-only health obligation, authored here as a plan
              input rather than a budget line (see Base + Adjustments). */}
          <div className="card inputs" id={OBLIGATION_SURFACE_ANCHORS.plan}>
            <BudgetEditor budget={budget} transact={transact} />
          </div>

          <div className="card">
            <GoalsPanel
              budget={budget}
              result={result}
              projection={projection}
              transact={transact}
            />
          </div>

          <div className="card">
            <RetirementPanel view={retirement} budget={budget} />
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
          series={series}
          personNames={personNames}
          household={household}
          ledger={ledger}
          projection={projection}
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
