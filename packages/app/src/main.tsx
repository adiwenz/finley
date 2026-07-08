import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  simulateHousehold,
  CashFlowSeries,
  Account,
  Liability,
  dollarsToCents,
  type HouseholdSimInput,
  type Person,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { NetWorthChart } from "./netWorthChart";

const HORIZON_MONTHS = 12 * 30;
const INFLATION = 0.03;

function buildInput(
  name: string,
  monthlyIncomeDollars: number,
  monthlyExpenseDollars: number,
  openingBalanceDollars: number,
  annualReturnPct: number,
  mortgageBalanceDollars: number,
  mortgageAprPct: number,
  mortgageTermYears: number,
): HouseholdSimInput {
  const person: Person = { id: "p1", name };
  const income = new CashFlowSeries(
    1,
    dollarsToCents(monthlyIncomeDollars),
    { type: "fixed" },
    { baselineUnit: "monthly" },
  );
  const expense = new CashFlowSeries(
    1,
    dollarsToCents(monthlyExpenseDollars),
    { type: "fixed" },
    { baselineUnit: "monthly" },
  );
  const account = new Account({
    id: "savings",
    ownerId: "p1",
    liquid: true,
    taxTreatment: "taxable",
    openingBalanceCents: dollarsToCents(openingBalanceDollars),
    initialAnnualRate: annualReturnPct / 100,
  });

  const liabilities: Liability[] = [];
  if (mortgageBalanceDollars > 0) {
    liabilities.push(
      new Liability({
        id: "mortgage",
        ownerId: "p1",
        kind: "mortgage",
        openingBalanceCents: dollarsToCents(mortgageBalanceDollars),
        apr: mortgageAprPct / 100,
        termMonths: mortgageTermYears * 12,
      }),
    );
  }

  return {
    horizonMonths: HORIZON_MONTHS,
    annualInflationRate: INFLATION,
    startYear: 2026,
    persons: [person],
    accounts: [account],
    incomeSeries: [{ series: income, ownerId: "p1" }],
    expenseSeries: [{ series: expense, ownerId: "p1" }],
    liabilities,
  };
}

function firstInsolventMonth(series: ProjectionSeries): number | null {
  for (const m of series.months) {
    if (m.isInsolvent) return m.month;
  }
  return null;
}

function peakCreditDebt(series: ProjectionSeries): { cents: number; month: number } | null {
  let peak = 0;
  let peakMonth = 0;
  for (const m of series.months) {
    const total = Object.entries(m.liabilityBalancesCents)
      .filter(([id]) => id !== "mortgage")
      .reduce((s, [, v]) => s + v, 0);
    if (total > peak) {
      peak = total;
      peakMonth = m.month;
    }
  }
  return peak > 0 ? { cents: peak, month: peakMonth } : null;
}

function formatDollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function NumInput({
  label,
  value,
  onChange,
  prefix,
  suffix,
  min,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input-wrap">
        {prefix && <span className="field-affix">{prefix}</span>}
        <input
          type="number"
          value={value}
          min={min ?? 0}
          step={step ?? 1}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {suffix && <span className="field-affix">{suffix}</span>}
      </span>
    </label>
  );
}

function App() {
  const [name, setName] = useState("Alex");
  const [income, setIncome] = useState(5000);
  const [expense, setExpense] = useState(3500);
  const [openingBalance, setOpeningBalance] = useState(10000);
  const [returnPct, setReturnPct] = useState(7);
  const [mortgageBalance, setMortgageBalance] = useState(0);
  const [mortgageApr, setMortgageApr] = useState(6.5);
  const [mortgageTerm, setMortgageTerm] = useState(30);

  const series = simulateHousehold(
    buildInput(name, income, expense, openingBalance, returnPct, mortgageBalance, mortgageApr, mortgageTerm),
    usJurisdiction,
  );

  const insolventMonth = firstInsolventMonth(series);
  const peakDebt = peakCreditDebt(series);

  return (
    <>
      <style>{`
        :root { color-scheme: light; }
        body { margin: 0; font-family: ui-serif, Georgia, "Times New Roman", serif;
               background: #f4efe1; color: #1f3a2e; }
        #app { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
        h1 { font-size: 22px; margin: 0 0 4px; }
        p.sub { margin: 0 0 20px; color: #6b6552; font-size: 14px; }
        .layout { display: grid; grid-template-columns: 1fr 260px; gap: 20px; align-items: start; }
        .card { background: #fbf8ef; border: 1px solid #e3dcc6;
                border-radius: 8px; padding: 20px; }
        .legend { display: flex; gap: 20px; margin-top: 12px; font-size: 13px; }
        .legend span { display: inline-flex; align-items: center; gap: 6px; }
        .swatch { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
        .disclaimer { margin-top: 16px; font-size: 12px; color: #8a8368; }
        .inputs { display: flex; flex-direction: column; gap: 12px; }
        .inputs h2 { font-size: 14px; font-weight: 600; margin: 0 0 4px;
                     color: #1f3a2e; letter-spacing: 0.02em; }
        .field { display: flex; flex-direction: column; gap: 3px; }
        .field-label { font-size: 12px; color: #6b6552; }
        .field-input-wrap { display: flex; align-items: center; border: 1px solid #d4cbb0;
                            border-radius: 4px; background: #fff; overflow: hidden; }
        .field-affix { padding: 0 6px; font-size: 13px; color: #8a8368;
                       background: #f4efe1; border-right: 1px solid #d4cbb0; }
        .field-affix:last-child { border-right: none; border-left: 1px solid #d4cbb0; }
        .field-input-wrap input { flex: 1; border: none; outline: none; padding: 5px 8px;
                                  font: inherit; font-size: 13px; background: transparent; }
        input[type=text] { width: 100%; }
        .name-field input { border: 1px solid #d4cbb0; border-radius: 4px; padding: 5px 8px;
                            font: inherit; font-size: 13px; background: #fff; }
        .divider { border: none; border-top: 1px solid #e3dcc6; margin: 4px 0; }
        .alert { margin-top: 12px; padding: 10px 14px; border-radius: 6px; font-size: 13px; }
        .alert-red { background: #fde8e8; border: 1px solid #e8a0a0; color: #7a1a1a; }
        .alert-amber { background: #fef3e2; border: 1px solid #e8c870; color: #6b4800; }
      `}</style>

      <h1>Net-worth projection</h1>
      <p className="sub">
        {name || "You"} · 30-year outlook · jurisdiction: {usJurisdiction.id}
      </p>

      <div className="layout">
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

          {insolventMonth !== null && (
            <div className="alert alert-red">
              Plan becomes unfinanceable at month {insolventMonth} (year {Math.round(insolventMonth / 12)}).
              Credit is exhausted — structural changes required.
            </div>
          )}

          {peakDebt !== null && insolventMonth === null && (
            <div className="alert alert-amber">
              Peak credit card debt: {formatDollars(peakDebt.cents)} at month {peakDebt.month}.
              Shortfall is financed by borrowing.
            </div>
          )}

          <p className="disclaimer">
            Estimates exclude taxes. Not a licensed financial advisor. Jurisdiction: {usJurisdiction.id}.
          </p>
        </div>

        <div className="card inputs">
          <h2>Person</h2>
          <label className="field name-field">
            <span className="field-label">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <hr className="divider" />
          <h2>Income &amp; expenses</h2>

          <NumInput
            label="Monthly income"
            value={income}
            onChange={setIncome}
            prefix="$"
          />
          <NumInput
            label="Monthly expenses"
            value={expense}
            onChange={setExpense}
            prefix="$"
          />

          <hr className="divider" />
          <h2>Savings / investment account</h2>

          <NumInput
            label="Opening balance"
            value={openingBalance}
            onChange={setOpeningBalance}
            prefix="$"
            step={1000}
          />
          <NumInput
            label="Annual return"
            value={returnPct}
            onChange={setReturnPct}
            suffix="%"
            min={0}
            step={0.5}
          />

          <hr className="divider" />
          <h2>Mortgage (optional)</h2>

          <NumInput
            label="Remaining balance"
            value={mortgageBalance}
            onChange={setMortgageBalance}
            prefix="$"
            step={10000}
          />
          {mortgageBalance > 0 && (
            <>
              <NumInput
                label="APR"
                value={mortgageApr}
                onChange={setMortgageApr}
                suffix="%"
                min={0}
                step={0.125}
              />
              <NumInput
                label="Remaining term"
                value={mortgageTerm}
                onChange={setMortgageTerm}
                suffix="yr"
                min={1}
                step={1}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
