/** Snapshot panel (§10.8) — the household cross-section at the scrubbed month. */

import {
  buildSnapshot,
  type Ledger,
  type ProjectionSeries,
  type ReplayedHousehold,
} from "@finley/engine";
import { formatDollars, monthLabel } from "../../format";
import { seriesLabel, splitMarkers } from "../../ledgerView";
import styles from "./snapshotPanel.module.css";

export function SnapshotPanel({
  ledger,
  household,
  series,
  month,
}: {
  ledger: Ledger;
  household: ReplayedHousehold;
  series: ProjectionSeries;
  month: number;
}) {
  const snap = buildSnapshot(household, month, series);
  const { passed, upcoming } = splitMarkers(ledger, month);

  return (
    <div className={styles.snapshot}>
      <h2>As of {monthLabel(month)}</h2>

      <div className={styles.snapSection}>
        <h3>Balances <span className={`${styles.tag} ${styles.stock}`}>stock</span></h3>
        <ul className={styles.snapList}>
          {snap.balances?.accounts.map((b) => (
            <li key={b.id}>
              <span>{b.id}</span>
              <span>{formatDollars(b.balanceCents)}</span>
            </li>
          ))}
          {snap.balances?.liabilities.map((b) => (
            <li key={b.id} className={styles.owed}>
              <span>{b.id} (owed)</span>
              <span>−{formatDollars(b.balanceCents)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.snapSection}>
        <h3>Monthly flows <span className={`${styles.tag} ${styles.flow}`}>rate</span></h3>
        <ul className={styles.snapList}>
          {snap.income.map((s) => (
            <li key={s.id}>
              <span>{seriesLabel(s)}</span>
              <span>{formatDollars(s.monthlyCents)}/mo</span>
            </li>
          ))}
          {snap.expenses.map((s) => (
            <li key={s.id}>
              <span>{seriesLabel(s)}</span>
              <span>−{formatDollars(s.monthlyCents)}/mo</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.snapSection}>
        <h3>Household</h3>
        <ul className={styles.snapList}>
          {snap.persons.map((p) => (
            <li key={p.id}>
              <span>{p.name}</span>
              <span>{p.id === "p1" ? "you" : "partner"}</span>
            </li>
          ))}
          {snap.children.map((c) => (
            <li key={c.id}>
              <span>{c.name}</span>
              <span>{Math.floor(c.ageMonths / 12)} yr old</span>
            </li>
          ))}
        </ul>
      </div>

      {passed.length > 0 && (
        <p className={styles.snapNote}>
          Changed by: {passed.map((m) => m.label).join(", ")}.
        </p>
      )}
      {upcoming.length > 0 && (
        <p className={`${styles.snapNote} ${styles.futureNote}`}>
          Ahead: {upcoming[0].label} in {monthLabel(upcoming[0].month)}.
        </p>
      )}
    </div>
  );
}
