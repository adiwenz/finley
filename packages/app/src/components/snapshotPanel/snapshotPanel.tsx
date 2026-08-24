/** Snapshot panel — the household cross-section at the scrubbed month. */

import type { Ledger, ProjectionResult } from "@finley/engine";
import { formatDollars, monthLabel } from "../../format";
import { seriesLabel, splitMarkers } from "../../ledgerView";
import styles from "./snapshotPanel.module.css";

export function SnapshotPanel({
  ledger,
  result,
  month,
  accountLabels,
}: {
  ledger: Ledger;
  result: ProjectionResult;
  month: number;
  /**
   * Account id → the name to show for it, owner-qualified where the household has two people —
   * see `accountLabelsFor`. A dated cross-section is the one place where "whose" is the whole
   * question, so a row here read as `savings-person-8` was naming a person by their internal id.
   */
  accountLabels?: ReadonlyMap<string, string>;
}) {
  const snap = result.snapshot(month);
  const { passed, upcoming } = splitMarkers(ledger, month);

  return (
    <div className={styles.snapshot}>
      <h2>As of {monthLabel(month)}</h2>

      <div className={styles.snapSection}>
        <h3>Balances <span className={`${styles.tag} ${styles.stock}`}>stock</span></h3>
        <ul className={styles.snapList}>
          {snap.balances?.accounts.map((b) => (
            <li key={b.id}>
              {/* An estate account is still the household's money and still in the net worth
                  below it, so it stays on the list — but it is named as what it now is, rather
                  than as a holding of somebody the Household list has already stopped naming. */}
              <span>
                {accountLabels?.get(b.id) ?? b.id}
                {b.inEstate === true && " (inherited)"}
              </span>
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

      {snap.properties.length > 0 && (
        <div className={styles.snapSection}>
          <h3>Property <span className={`${styles.tag} ${styles.stock}`}>stock</span></h3>
          <ul className={styles.snapList}>
            {snap.properties.map((p) => (
              <li key={p.id}>
                <span>{p.id}</span>
                <span>
                  {formatDollars(p.valueCents)}
                  {p.equityCents !== null && ` · ${formatDollars(p.equityCents)} equity`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
