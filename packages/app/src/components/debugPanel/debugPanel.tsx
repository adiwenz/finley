/**
 * Debug panel — raw inspector over the engine's {@link SimulationReport}: every configuration
 * knob, the accumulation table (ages, balances, cash flows incl. Social Security, per period),
 * and a JSON download of the whole run. A pure consumer that derives nothing about the
 * simulation, so it can never disagree with the engine. The full authored config rides in the
 * report's `meta`, so the download stands alone.
 */

import { useMemo, useState, type ReactNode } from "react";
import { PRIMARY_PERSON_ID } from "@finley/engine";
import type { Plan, Projection, SimulationReport } from "@finley/engine";

/** The two figures this inspector reads through the facade rather than re-deriving. */
type PlanFigures = Pick<Projection, "personMonthlyIncomeCents" | "personDeferralFraction">;
import { primaryJobs } from "../../planPeople";
import { formatDollars } from "../../format";
import { debugExportFilename } from "../../debugExport";
import styles from "./debugPanel.module.css";

const pct = (whole: number) => `${whole}%`;

/**
 * The plan's authored monthly general spend: the base amount of every literal expense budget
 * line, before price growth, spans or dated overrides. Contribution lines (account targets)
 * and non-literal amounts are not spend, so they are excluded.
 */
function expenseLinesSummary(budget: Plan): { count: number; monthlyCents: number } {
  const lines = budget.budgetLines.filter(
    (l) => l.target.kind === "expense" && l.amountSource.kind === "literal",
  );
  const monthlyCents = lines.reduce(
    (sum, l) => sum + (l.amountSource.kind === "literal" ? l.amountSource.monthlyCents : 0),
    0,
  );
  return { count: lines.length, monthlyCents };
}
/** A rate held as a FRACTION (0.03) rendered as a percentage ("3%"). */
const ratePct = (fraction: number) => `${+(fraction * 100).toFixed(2)}%`;
const yesNo = (b: boolean) => (b ? "yes" : "no");
const targetDate = (d: number | "asap") => (d === "asap" ? "ASAP" : `month ${d}`);

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** One labelled group of config rows. */
function ConfigGroup({ title, rows }: { title: string; rows: readonly [string, ReactNode][] }) {
  return (
    <div className={styles.configGroup}>
      <h4 className={styles.configTitle}>{title}</h4>
      <dl className={styles.configList}>
        {rows.map(([label, value]) => (
          <div key={label} className={styles.configRow}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Every per-series growth rate the run RESOLVED — the income "raise rate" and each expense
 * line's escalation. Only the report has these: the plan carries no raise-rate field (income
 * inherits CPI), and its single `healthInflationPct` compiles into a separate expense series
 * with its own rate and mid-run step at Medicare age. So this is the only place the rates the
 * engine actually applied are visible.
 */
function growthRows(inputs: SimulationReport["inputs"]): [string, ReactNode][] {
  const describe = (s: {
    annualGrowthRate: number;
    growthSchedule: readonly { annualRate: number }[];
  }): ReactNode => {
    // Annotate only when the RATE changes over the run. The health line has two segments
    // purely because its AMOUNT steps down at Medicare age; its rate never moves.
    const rates = new Set(s.growthSchedule.map((g) => g.annualRate));
    return rates.size > 1
      ? `${ratePct(s.annualGrowthRate)} → ${ratePct([...rates].pop() ?? 0)}`
      : ratePct(s.annualGrowthRate);
  };
  const rows: [string, ReactNode][] = [
    ...inputs.incomeSources.map((s, i): [string, ReactNode] => [s.label ?? `Income ${i + 1}`, describe(s)]),
    ...inputs.expenseSources.map((s, i): [string, ReactNode] => [s.label ?? `Expense ${i + 1}`, describe(s)]),
  ];
  return rows.length > 0 ? rows : [["—", "no series"]];
}

/** Every configurable knob, grouped — the authored plan plus resolved run facts. */
function Configuration({
  budget,
  projection,
  inputs,
  jurisdictionId,
}: {
  budget: Plan;
  /** Standing pay and the blended deferral are read through the facade, not re-derived here. */
  projection: PlanFigures;
  inputs: SimulationReport["inputs"];
  jurisdictionId: string;
}) {
  const expenseLines = expenseLinesSummary(budget);
  return (
    <div className={styles.config}>
      <ConfigGroup
        title="Identity & horizon"
        rows={[
          ["Name", budget.name || "You"],
          ["Current age", budget.currentAge],
          ["Retirement age", budget.retirementAge],
          ["Life expectancy", budget.lifeExpectancy],
          ["Jurisdiction", jurisdictionId],
          ["Horizon", `${inputs.horizonYears} yr (${inputs.horizonMonths} mo)`],
          ["Years", `${inputs.startYear}–${inputs.endYear}`],
        ]}
      />
      <ConfigGroup
        title="Monthly cash flow"
        rows={[
          [
            `Income (${primaryJobs(budget).length} job${primaryJobs(budget).length === 1 ? "" : "s"})`,
            formatDollars(projection.personMonthlyIncomeCents(PRIMARY_PERSON_ID)),
          ],
          ["Expenses (budget lines)", formatDollars(expenseLines.monthlyCents)],
          ["Opening balance", formatDollars(budget.openingBalanceCents)],
          ["Budget expense lines", `${expenseLines.count}`],
        ]}
      />
      <ConfigGroup
        title="Accounts & returns"
        rows={[
          ["Savings ROI", pct(budget.savingsReturnPct)],
          ["Retirement ROI", pct(budget.retirementReturnPct)],
          ["Brokerage ROI", pct(budget.brokerageReturnPct)],
          ["Retirement deferral (blended)", pct(Math.round(projection.personDeferralFraction(PRIMARY_PERSON_ID) * 100))],
        ]}
      />
      <ConfigGroup
        title="Retirement & Social Security"
        rows={[["SS claiming age", budget.benefitClaimingAge]]}
      />
      <ConfigGroup
        title="Health care"
        rows={[
          ["Pre-65 monthly", formatDollars(budget.healthMonthlyCents)],
          ["Post-Medicare monthly", formatDollars(budget.postCoverageHealthMonthlyCents)],
          ["Enrolls in Medicare", yesNo(budget.enrollsInPublicHealthCoverage)],
          ["Health inflation", pct(budget.healthInflationPct)],
        ]}
      />
      <ConfigGroup
        title="Inflation & levers"
        rows={[
          ["Inflation (CPI)", pct(budget.inflationPct)],
          [
            "SS COLA",
            `${ratePct(inputs.benefitColaRate)}${inputs.benefitColaRateIsExplicit ? "" : " (from CPI)"}`,
          ],
          ["Shared scheme", budget.sharedScheme],
          ["Leftover cash", "idle in savings"],
        ]}
      />
      <ConfigGroup title="Growth rates (resolved)" rows={growthRows(inputs)} />
      <ConfigGroup
        title={`Goals (${budget.goals.length})`}
        rows={
          budget.goals.length === 0
            ? [["—", "no goals"]]
            : budget.goals.map((g, i): [string, ReactNode] => [
                `${i + 1}. ${g.name}`,
                `${formatDollars(g.targetCents)} · ${targetDate(g.targetDate)} · ${g.disposition} · ${pct(
                  g.annualReturnPct,
                )}`,
              ])
        }
      />
    </div>
  );
}

export function DebugPanel({
  report,
  budget,
  projection,
}: {
  report: SimulationReport;
  budget: Plan;
  projection: PlanFigures;
}) {
  const [everyMonth, setEveryMonth] = useState(false);
  const { columns, months, inputs } = report;
  const jurisdictionId = String((report.meta?.jurisdictionId as string | undefined) ?? "—");

  // The table is naturally annual; hundreds of monthly rows are opt-in so the default view
  // stays readable. Yearly rows are the year boundaries (0, 12, 24, …) plus the final month,
  // so the horizon shows.
  const rows = useMemo(() => {
    if (everyMonth) return months;
    const lastMonth = months.length - 1;
    return months.filter((m) => m.month % 12 === 0 || m.month === lastMonth);
  }, [months, everyMonth]);

  // Age of the primary person (first roster member with a birth year), for the axis.
  const agePersonId = columns.personIds[0];

  function onDownload() {
    downloadJson(debugExportFilename(), report);
  }

  return (
    <details className={styles.debug}>
      <summary>Debug · simulation data</summary>

      <div className={styles.toolbar}>
        <button type="button" className="btn primary" onClick={onDownload}>
          Download JSON
        </button>
        <span className={styles.grow} />
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={everyMonth}
            onChange={(e) => setEveryMonth(e.target.checked)}
          />
          Show every month
        </label>
      </div>

      <p className={styles.meta}>
        {months.length} months · {inputs.startYear}–{inputs.startYear + Math.floor((months.length - 1) / 12)} ·
        inflation {(inputs.annualInflationRate * 100).toFixed(1)}% ·{" "}
        {inputs.persons
          .map((p) => `${p.name} (SS claim ${p.benefitClaimingAge ?? "—"})`)
          .join(", ")}
      </p>

      <Configuration
        budget={budget}
        projection={projection}
        inputs={inputs}
        jurisdictionId={jurisdictionId}
      />

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.rowhead}>Month</th>
              <th>Year</th>
              {agePersonId && <th>Age</th>}
              <th className={styles.group}>Net worth (real)</th>
              <th>Net worth (nom.)</th>
              {columns.accountIds.map((id) => (
                <th key={`a-${id}`} className={styles.group}>
                  {id}
                </th>
              ))}
              {columns.liabilityIds.map((id) => (
                <th key={`l-${id}`} className={styles.group}>
                  {id}
                </th>
              ))}
              {columns.propertyIds.map((id) => (
                <th key={`p-${id}`} className={styles.group}>
                  {id}
                </th>
              ))}
              <th className={styles.group}>Income</th>
              <th>SS income</th>
              <th>Tax</th>
              <th>Expenses</th>
              <th>Debt pmts</th>
              <th>Insolvent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.month} className={m.isInsolvent ? styles.insolvent : undefined}>
                <td className={styles.rowhead}>{m.month}</td>
                <td>{m.year}</td>
                {agePersonId && <td>{m.ageByPerson[agePersonId] ?? "—"}</td>}
                <td className={styles.group}>
                  {m.netWorthRealCents === null ? "—" : formatDollars(m.netWorthRealCents)}
                </td>
                <td>
                  {m.netWorthNominalCents === null ? "—" : formatDollars(m.netWorthNominalCents)}
                </td>
                {columns.accountIds.map((id) => (
                  <td key={`a-${id}`} className={styles.group}>
                    {formatDollars(m.accountBalancesCents[id] ?? 0)}
                  </td>
                ))}
                {columns.liabilityIds.map((id) => {
                  const bal = m.liabilityBalancesCents[id] ?? 0;
                  return (
                    <td key={`l-${id}`} className={`${styles.group} ${bal > 0 ? styles.owed : ""}`}>
                      {bal > 0 ? `−${formatDollars(bal)}` : formatDollars(0)}
                    </td>
                  );
                })}
                {columns.propertyIds.map((id) => (
                  <td key={`p-${id}`} className={styles.group}>
                    {formatDollars(m.propertyValuesCents[id] ?? 0)}
                  </td>
                ))}
                <td className={styles.group}>{formatDollars(m.totalIncomeCents)}</td>
                <td>{formatDollars(m.governmentRetirementBenefitCents)}</td>
                <td>{formatDollars(m.taxCents)}</td>
                <td>{formatDollars(m.expensesCents)}</td>
                <td>{formatDollars(m.liabilityPaymentsCents)}</td>
                <td className={m.isInsolvent ? styles.flag : undefined}>
                  {m.isInsolvent ? "⚠" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
