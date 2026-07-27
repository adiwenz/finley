import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  interpretLedger,
  buildHouseholdSimInput,
  simulateHousehold,
  summarizeSimulation,
  createProjectionBase,
  firstInsolventMonth,
  type ProjectionContext,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { NetWorthChart } from "./components/netWorthChart/netWorthChart";
import { timelineMarkers } from "./ledgerView";
import { planHorizonMonths, START_YEAR } from "./config";
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
import { useLedger } from "./hooks/useLedger";
import type { Plan } from "@finley/engine";
import { PLAN_DEFAULTS, DEFAULT_SCRUB_MONTH } from "./planDefaults";
import { PRESETS, presetById, buildPresetLedger, type Preset } from "./presets";
import "./assets/styles/tokens.css";
import "./assets/styles/globals.css";

/**
 * The projection environment: the real US jurisdiction and the frozen "now"
 * (`START_YEAR`). Both are app-supplied constants, so a stable module-level object
 * keeps `createProjectionBase`'s memo keyed on `budget` alone.
 */
const PROJECTION_CTX: ProjectionContext = {
  jurisdiction: usJurisdiction,
  startYear: START_YEAR,
};

export function App() {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [budget, setBudget] = useState<Plan>(PLAN_DEFAULTS);
  const [scrubMonth, setScrubMonth] = useState(DEFAULT_SCRUB_MONTH);

  const base = useMemo(() => createProjectionBase(budget, PROJECTION_CTX), [budget]);
  const { ledger, conflict, recordEvent, reviseEvents, removeEvent, resetLedger } = useLedger(base);

  // Load a starter simulation wholesale: swap in its plan AND its
  // seed timeline together. The new ledger is built against the *incoming* plan's
  // base (computed here, not the memoized one, which still reflects the old plan
  // this render), so a preset's events are replayed against the numbers they were
  // authored for. The scrub cursor snaps back to "now" so the fresh scenario reads
  // from its opening month.
  function loadPreset(preset: Preset) {
    const nextBase = createProjectionBase(preset.plan, PROJECTION_CTX);
    setPresetId(preset.id);
    setBudget(preset.plan);
    resetLedger(buildPresetLedger(nextBase, preset.events));
    setScrubMonth(DEFAULT_SCRUB_MONTH);
  }

  // One replay-derived household feeds both the projection and the snapshot,
  // so the two can never disagree about the ledger's meaning.
  const household = useMemo(() => interpretLedger(ledger, base), [ledger, base]);
  // Build the resolved simulator input once, then simulate — sharing that input
  // lets the debug report reuse the very series the chart draws (no second run).
  const simInput = useMemo(() => buildHouseholdSimInput(household, base), [household, base]);
  const series = useMemo(
    () => simulateHousehold(simInput, usJurisdiction),
    [simInput],
  );
  // Echo the complete authored config (the value-editing surface) into the report's
  // meta, so knobs the engine input compiles away — life expectancy, retirement age,
  // health lines — survive into the debug output and download.
  const report = useMemo(
    () =>
      summarizeSimulation(
        simInput,
        series,
        { plan: budget, jurisdictionId: usJurisdiction.id },
        usJurisdiction,
      ),
    [simInput, series, budget],
  );

  // Who's in the household, by id — so a chart can name whose income a band is when the
  // label alone can't (two members' government benefits).
  const personNames = useMemo(
    () => new Map(household.memberships.map((m) => [m.person.id, m.person.name])),
    [household],
  );
  const markers = useMemo(() => timelineMarkers(ledger), [ledger]);
  const insolventMonth = firstInsolventMonth(series);
  // The retirement panel reasons about the SAME scenario the graph draws — the plan
  // plus the live ledger of timeline events — so "when can we retire?" reflects every
  // event the user has added (a child, a new expense, a separation), not the bare plan.
  const retirement = useMemo(
    () => retirementView({ plan: budget, ledger }, usJurisdiction),
    [budget, ledger],
  );
  // Chart, timeline, and event picker all span "now" → life expectancy.
  const horizonMonths = planHorizonMonths(budget.currentAge, budget.lifeExpectancy);

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

            <Timeline
              markers={markers}
              scrubMonth={scrubMonth}
              horizonMonths={horizonMonths}
              onScrub={setScrubMonth}
              onRemove={removeEvent}
            />

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
            <SnapshotPanel
              ledger={ledger}
              household={household}
              series={series}
              month={scrubMonth}
            />
          </div>
        </div>

        <div className="side-col">
          <div className="card">
            <AddEventForm
              household={household}
              series={series}
              defaultMonth={Math.floor(scrubMonth / 12) * 12}
              nextId={ledger.nextSequenceNumber}
              horizonMonths={horizonMonths}
              onAdd={recordEvent}
            />
          </div>

          <div className="card inputs">
            <BudgetEditor
              budget={budget}
              setBudget={setBudget}
            />
          </div>

          <div className="card">
            <GoalsPanel budget={budget} series={series} setBudget={setBudget} />
          </div>

          <div className="card">
            <RetirementPanel view={retirement} budget={budget} />
          </div>
        </div>
      </div>

      <div className="card">
        <JobsPanel
          budget={budget}
          setBudget={setBudget}
          household={household}
          ledger={ledger}
          onReviseEvents={reviseEvents}
        />
      </div>

      <div className="card">
        {/* The panel charts the SAME series the net-worth graph draws — plan plus the
            live timeline — so its spending need counts loan payments and every other
            event, not just the standing budget. Everything it draws rides on that one
            series (the engine itemizes the spending), so there is nothing else to pass. */}
        <BaseAdjustmentsPanel
          plan={budget}
          setBudget={setBudget}
          series={series}
          personNames={personNames}
          household={household}
          ledger={ledger}
          onReviseEvents={reviseEvents}
        />
      </div>

      <div className="card">
        <DebugPanel report={report} budget={budget} />
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
