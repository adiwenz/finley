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
import { retirementView } from "./retirementView";
import { useLedger } from "./hooks/useLedger";
import type { Plan } from "@finley/engine";
import { PLAN_DEFAULTS, DEFAULT_SCRUB_MONTH } from "./planDefaults";
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
  const [budget, setBudget] = useState<Plan>(PLAN_DEFAULTS);
  const [scrubMonth, setScrubMonth] = useState(DEFAULT_SCRUB_MONTH);

  const base = useMemo(() => createProjectionBase(budget, PROJECTION_CTX), [budget]);
  const { ledger, conflict, recordEvent, removeEvent } = useLedger(base);

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
    () => summarizeSimulation(simInput, series, { plan: budget, jurisdictionId: usJurisdiction.id }),
    [simInput, series, budget],
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
  // Chart, timeline, and event picker all span "now" → life expectancy (§7).
  const horizonMonths = planHorizonMonths(budget.currentAge, budget.lifeExpectancy);

  return (
    <>
      <h1>Your financial life</h1>
      <p className="sub">
        {budget.name || "You"} · outlook to age {budget.lifeExpectancy} · jurisdiction:{" "}
        {usJurisdiction.id}
      </p>

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
        <BaseAdjustmentsPanel plan={budget} setBudget={setBudget} />
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
