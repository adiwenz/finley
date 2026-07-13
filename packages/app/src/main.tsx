import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { interpretLedger, buildProjection } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { NetWorthChart } from "./components/netWorthChart/netWorthChart";
import { timelineMarkers } from "./ledgerView";
import { createProjectionBase, firstInsolventMonth } from "./projectionBase";
import { monthLabel } from "./format";
import { AddEventForm } from "./components/addEventForm/addEventForm";
import { Timeline } from "./components/timeline/timeline";
import { SnapshotPanel } from "./components/snapshotPanel/snapshotPanel";
import { BudgetEditor } from "./components/budgetEditor/budgetEditor";
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
  const series = useMemo(
    () => buildProjection(household, base, usJurisdiction),
    [household, base],
  );

  const markers = useMemo(() => timelineMarkers(ledger), [ledger]);
  const insolventMonth = firstInsolventMonth(series);

  return (
    <>
      <h1>Your financial life</h1>
      <p className="sub">
        {budget.name || "You"} · 30-year outlook · jurisdiction: {usJurisdiction.id}
      </p>

      <div className="layout">
        <div className="main-col">
          <div className="card">
            <NetWorthChart series={series} />

            <Timeline
              markers={markers}
              scrubMonth={scrubMonth}
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
        </div>
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
