/**
 * Which accounts pay for a money-out event, and in what order they drain.
 * Event-neutral: it edits a funding draw's `sourceIds`. Pool and
 * coverage both come from the engine's `fundingLookup`, the function `addEvent` gates on,
 * so the form cannot promise what the engine will refuse.
 *
 * Order is drain order, so selecting APPENDS rather than sorts. An empty account is greyed
 * and unpickable, never dropped: dropping it let an account chosen while funded vanish at a
 * later month with its id still selected, uncheckable yet still counted.
 */

import type { FundingAvailability, FundingSourceBalance } from "@finley/engine";
import { formatDollars } from "../../format";
import styles from "./addEventForm.module.css";

export function FundingSourcePicker({
  pool,
  selected,
  amountCents,
  availability,
  onChange,
  label = "Paid from",
}: {
  /**
   * Every account that could fund the event, with what it holds AT THE EVENT MONTH (possibly
   * nothing), largest first (engine-ordered).
   */
  pool: readonly FundingSourceBalance[];
  /**
   * The chosen ids IN DRAIN ORDER — the value this control edits. Every id must name a pool
   * entry that can pay; the caller drops any that cannot, so no row is ever both checked and
   * disabled.
   */
  selected: readonly string[];
  /** What the event needs, for the coverage line. */
  amountCents: number;
  /** The engine's verdict for `selected` at that month — after capital-gains tax. */
  availability: FundingAvailability;
  onChange: (ids: readonly string[]) => void;
  label?: string;
}) {
  // Selecting APPENDS (drained last); deselecting closes the gap so the numbers stay 1..n
  // with no hole.
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  // Whether ANY listed account can pay at this month — distinct from an empty pool: a plan
  // can own three funding accounts and have all three at $0 by that month.
  const anyFunds = pool.some((source) => source.balanceCents > 0);

  return (
    <div className={styles.sources}>
      <span className="field-label">{label}</span>
      {pool.length === 0 ? (
        <p className="hint">
          This plan has no cash or investment account, so nothing can fund this yet.
        </p>
      ) : (
        <ul className={styles.sourceList}>
          {pool.map((source) => {
            const order = selected.indexOf(source.id);
            const empty = source.balanceCents <= 0;
            return (
              <li key={source.id}>
                <label className={`${styles.sourceRow} ${empty ? styles.sourceRowEmpty : ""}`}>
                  <input
                    type="checkbox"
                    checked={order >= 0}
                    disabled={empty}
                    onChange={() => toggle(source.id)}
                    aria-label={
                      empty
                        ? `${source.label} — nothing available at that time`
                        : `${source.label} — ${formatDollars(source.balanceCents)} available`
                    }
                  />
                  {/* Drain position — an unchosen account has none. */}
                  <span className={styles.sourceOrder} aria-hidden="true">
                    {order >= 0 ? order + 1 : ""}
                  </span>
                  <span className={styles.sourceName}>{source.label}</span>
                  <span className={styles.sourceBalance}>{formatDollars(source.balanceCents)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <Coverage
        amountCents={amountCents}
        availability={availability}
        selected={selected}
        anyFunds={anyFunds}
      />
    </div>
  );
}

/**
 * What the selection buys. `availableCents` is the engine's after-tax figure, so a shortfall
 * here is exactly the one `addEvent` would block on — learned while editing, not after
 * submitting.
 */
function Coverage({
  amountCents,
  availability,
  selected,
  anyFunds,
}: {
  amountCents: number;
  availability: FundingAvailability;
  selected: readonly string[];
  /** Whether anything in the pool holds money at this month. */
  anyFunds: boolean;
}) {
  // Checked first: with every account empty, "choose at least one" is advice the user cannot
  // take.
  if (!anyFunds) {
    return (
      <p className={`hint ${styles.sourceShort}`} role="status">
        No account holds anything at that month, so nothing can fund this yet.
      </p>
    );
  }
  if (selected.length === 0) {
    return <p className="hint">Choose at least one account to pay from.</p>;
  }
  // Selling an appreciated investment realizes a capital gain, so part of the balance goes
  // to tax rather than the purchase — why a balance and an "available" differ.
  const taxNote = availability.taxed
    ? ` (after ${formatDollars(availability.taxCents)} of capital-gains tax on selling the investments)`
    : "";

  if (availability.shortfallCents > 0) {
    return (
      <p className={`hint ${styles.sourceShort}`} role="status">
        Those accounts provide {formatDollars(availability.availableCents)}
        {taxNote} — {formatDollars(availability.shortfallCents)} short of the{" "}
        {formatDollars(amountCents)} needed. Add another account, or the purchase will be
        blocked.
      </p>
    );
  }
  return (
    <p className="hint" role="status">
      Covers the {formatDollars(amountCents)} needed{taxNote}.
    </p>
  );
}
