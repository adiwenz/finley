/**
 * The ordered funding-source picker — which accounts pay for a money-out event, and in
 * what order they are drained.
 *
 * Deliberately event-neutral (#156): it edits the `sourceIds` of a funding draw, so the
 * Home Purchase down payment uses it today and One-Time Spend (#154) uses the same control
 * for the same question. It renders no policy of its own — the pool it lists and the
 * coverage it states both come from the engine's `fundingLookup`, the very function
 * `addEvent` gates on, so the form can never promise what the engine will refuse.
 *
 * Order is the drain order: the first selected account empties before the next is touched,
 * which is why selecting appends rather than sorting. That makes the numbered badge the
 * control's real content — a checkbox says *whether*, the number says *when*.
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
  /** Every account holding something at the event month, largest first (engine-ordered). */
  pool: readonly FundingSourceBalance[];
  /** The chosen ids IN DRAIN ORDER — the value this control edits. */
  selected: readonly string[];
  /** What the event needs, for the coverage line. */
  amountCents: number;
  /** The engine's verdict for `selected` at that month — after capital-gains tax. */
  availability: FundingAvailability;
  onChange: (ids: readonly string[]) => void;
  label?: string;
}) {
  // Selecting APPENDS (it becomes the last to be drained); deselecting closes the gap, so the
  // remaining numbers stay 1..n with no hole. Order is meaning here, not presentation.
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div className={styles.sources}>
      <span className="field-label">{label}</span>
      {pool.length === 0 ? (
        <p className="hint">
          No account holds anything at that month, so nothing can fund this yet.
        </p>
      ) : (
        <ul className={styles.sourceList}>
          {pool.map((source) => {
            const order = selected.indexOf(source.id);
            return (
              <li key={source.id}>
                <label className={styles.sourceRow}>
                  <input
                    type="checkbox"
                    checked={order >= 0}
                    onChange={() => toggle(source.id)}
                    aria-label={`${source.label} — ${formatDollars(source.balanceCents)} available`}
                  />
                  {/* The drain position, shown only once chosen — an unchosen account has none. */}
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
      <Coverage amountCents={amountCents} availability={availability} selected={selected} />
    </div>
  );
}

/**
 * What the selection actually buys. `availableCents` is the engine's own after-tax figure, so
 * a shortfall here is exactly the shortfall `addEvent` would block on — the user learns it
 * while editing rather than from a red alert after submitting.
 */
function Coverage({
  amountCents,
  availability,
  selected,
}: {
  amountCents: number;
  availability: FundingAvailability;
  selected: readonly string[];
}) {
  if (selected.length === 0) {
    return <p className="hint">Choose at least one account to pay from.</p>;
  }
  // Selling an appreciated investment realizes a capital gain, so part of what the account
  // holds goes to tax rather than to the purchase. Naming the amount is the whole reason a
  // balance and an "available" can differ.
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
