import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { simulate, dollarsToCents, type SimulationInput } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { NetWorthChart } from "./netWorthChart";

/**
 * Slice 0 walking skeleton: a HARDCODED projection input, run through the public
 * engine (with the `rules` jurisdiction), rendered into a Recharts chart.
 * Proves the full engine → rules → app wire before any real inputs/UI land.
 * Slice 3b (issue #5) makes the inputs user-editable.
 */
const demoInput: SimulationInput = {
  horizonMonths: 12 * 30,
  openingNetWorthCents: dollarsToCents(-25000), // e.g. student loans > savings
  monthlyNetFlowCents: dollarsToCents(900),
  annualInflationRate: 0.03,
  startYear: 2026,
};

const series = simulate(demoInput, usJurisdiction);

function App() {
  return (
    <>
      <style>{`
        :root { color-scheme: light; }
        body { margin: 0; font-family: ui-serif, Georgia, "Times New Roman", serif;
               background: #f4efe1; color: #1f3a2e; }
        #app { max-width: 820px; margin: 0 auto; padding: 32px 24px; }
        h1 { font-size: 22px; margin: 0 0 4px; }
        p.sub { margin: 0 0 20px; color: #6b6552; font-size: 14px; }
        .card { background: #fbf8ef; border: 1px solid #e3dcc6;
                border-radius: 8px; padding: 20px; }
        .legend { display: flex; gap: 20px; margin-top: 12px; font-size: 13px; }
        .legend span { display: inline-flex; align-items: center; gap: 6px; }
        .swatch { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
        .disclaimer { margin-top: 16px; font-size: 12px; color: #8a8368; }
      `}</style>
      <h1>Net-worth projection</h1>
      <p className="sub">
        Walking skeleton — hardcoded inputs through <code>@finley/engine</code>{" "}
        (jurisdiction: {usJurisdiction.id})
      </p>
      <div className="card">
        <NetWorthChart series={series} />
        <div className="legend">
          <span>
            <i className="swatch" style={{ background: "#1f3a2e" }} />
            Nominal
          </span>
          <span>
            <i className="swatch" style={{ background: "#b5761f" }} />
            Real (today's dollars)
          </span>
        </div>
      </div>
      <p className="disclaimer">
        Estimates exclude taxes. Not a licensed financial advisor.
      </p>
    </>
  );
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
