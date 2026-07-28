/**
 * The ordered funding-source picker — which accounts pay for a money-out event, and in
 * what order they are drained.
 *
 * Deliberately event-neutral: it edits the `sourceIds` of a funding draw, so the
 * Home Purchase down payment uses it today and a one-time spend uses the same control
 * for the same question. It renders no policy of its own — the pool it lists and the
 * coverage it states both come from the engine's `fundingLookup`, the very function
 * `addEvent` gates on, so the form can never promise what the engine will refuse.
 *
 * Order is the drain order: the first selected account empties before the next is touched,
 * which is why selecting appends rather than sorting. That makes the numbered badge the
 * control's real content — a checkbox says *whether*, the number says *when*.
 *
 * An account with nothing in it is shown, greyed and unpickable, rather than dropped from the
 * list. Dropping it made the pool's membership move with the month, so an account chosen when
 * it held money could disappear from the list at a later month while its id stayed in the
 * selection — no row rendered as checked, yet the coverage line and the submitted event were
 * still counting it. Every account the pool knows about is on screen, and what changes between
 * months is only whether a row can be picked.
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
   * Every account that could fund the event, with what it holds AT THE EVENT MONTH — possibly
   * nothing — largest first (engine-ordered). The empty ones are rendered unpickable, not hidden.
   */
  pool: readonly FundingSourceBalance[];
  /**
   * The chosen ids IN DRAIN ORDER — the value this control edits. Every id here must name a
   * pool entry that can actually pay; the caller drops any that cannot, so this control never
   * has to render a checked row it also has to disable.
   */
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

  // Whether ANY listed account can pay at this month. Distinct from an empty pool: a plan can
  // own three funding accounts and have all three at $0 by the month in question.
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
            // Nothing in it, nothing to take from it. Muted and disabled rather than absent, so
            // the reason a selection went away at this month is on screen instead of implied.
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
 * What the selection actually buys. `availableCents` is the engine's own after-tax figure, so
 * a shortfall here is exactly the shortfall `addEvent` would block on — the user learns it
 * while editing rather than from a red alert after submitting.
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
  /** Whether anything in the pool holds money at this month — see the picker. */
  anyFunds: boolean;
}) {
  // Checked first: with every account empty, "choose at least one" is advice the user cannot
  // take. Say what is actually wrong — the money isn't there yet at this month.
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
