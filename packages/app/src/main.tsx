import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  interpretLedger,
  buildHouseholdSimInput,
  simulateHousehold,
  summarizeSimulation,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { NetWorthChart } from "./components/netWorthChart/netWorthChart";
import { timelineMarkers } from "./ledgerView";
import { createProjectionBase, firstInsolventMonth } from "./projectionBase";
import { planHorizonMonths } from "./config";
import { monthLabel } from "./format";
import { AddEventForm } from "./components/addEventForm/addEventForm";
import { Timeline } from "./components/timeline/timeline";
import { SnapshotPanel } from "./components/snapshotPanel/snapshotPanel";
import { BudgetEditor } from "./components/budgetEditor/budgetEditor";
import { GoalsPanel } from "./components/goalsPanel/goalsPanel";
import { RetirementPanel } from "./components/retirementPanel/retirementPanel";
import { DebugPanel } from "./components/debugPanel/debugPanel";
import { retirementView } from "./retirementView";
import { useLedger } from "./hooks/useLedger";
import type { BudgetValues } from "./planTypes";
import { PLAN_DEFAULTS, DEFAULT_SCRUB_MONTH } from "./planDefaults";
import "./assets/styles/tokens.css";
import "./assets/styles/globals.css";

export function App() {
  const [budget, setBudget] = useState<BudgetValues>(PLAN_DEFAULTS);
  const [scrubMonth, setScrubMonth] = useState(DEFAULT_SCRUB_MONTH);

  const base = useMemo(() => createProjectionBase(budget), [budget]);
  const { ledger, conflict, recordEvent, undoEvent } = useLedger(base);

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
  const report = useMemo(() => summarizeSimulation(simInput, series), [simInput, series]);

  const markers = useMemo(() => timelineMarkers(ledger), [ledger]);
  const insolventMonth = firstInsolventMonth(series);
  const retirement = useMemo(() => retirementView(budget, usJurisdiction), [budget]);
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
              onUndo={undoEvent}
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
              Estimates exclude taxes. Not a licensed financial advisor.
              Jurisdiction: {usJurisdiction.id}.
            </p>
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
              scrubMonth={scrubMonth}
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
        <DebugPanel report={report} />
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
