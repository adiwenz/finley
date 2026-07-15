/**
 * Debug panel (§10) — a raw inspector over the engine's {@link SimulationReport}.
 * It renders the accumulation table (ages, balances, and cash flows incl. Social
 * Security, per period) and downloads the whole run — the resolved report plus the
 * raw plan — as JSON. Pure consumer of the engine output: it derives nothing about
 * the simulation itself, so it can never disagree with what the engine computed.
 */

import { useMemo, useState } from "react";
import type { SimulationReport } from "@finley/engine";
import { formatDollars } from "../../format";
import { debugExportFilename } from "../../debugExport";
import styles from "./debugPanel.module.css";

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DebugPanel({ report }: { report: SimulationReport }) {
  const [everyMonth, setEveryMonth] = useState(false);
  const { columns, months, inputs } = report;

  // The accumulation table is naturally annual; showing every one of hundreds of
  // months is opt-in so the default view stays readable. Yearly rows are the
  // year-boundary months (0, 12, 24, …) plus the final month so the horizon shows.
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
          .map((p) => `${p.name} (SS claim ${p.ssClaimingAge ?? "—"})`)
          .join(", ")}
      </p>

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
                <td className={styles.group}>{formatDollars(m.netWorthRealCents)}</td>
                <td>{formatDollars(m.netWorthNominalCents)}</td>
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
                <td>{formatDollars(m.socialSecurityCents)}</td>
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
