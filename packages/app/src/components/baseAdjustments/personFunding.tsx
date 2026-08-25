/**
 * **Funded by**, in a household of more than one — who owed what this month, and what covered it.
 *
 * Replaces the per-line waterfall (`FundingAttribution`) for a partnered month, and only for the
 * obligations the shared cascade funded. See {@link buildPersonFunding} for why: with two people
 * the per-line reading names an owner, and a name is the one part of a derived interpretation that
 * can be flatly wrong rather than merely arbitrary. Every figure below is one the engine decided —
 * an authored share, the take-home that reached it, the balances that fell, and whose they were.
 *
 * Amounts are cumulative-rounded twice ({@link dollarParts}): each person's share against the
 * household total, then each row's own sources against the share it just printed. So the rows add
 * up to the total and each row adds up to itself, at the dollar the reader is actually shown.
 */

import { useMemo } from "react";
import type { FinancialObligation, ResolvedFunding } from "@finley/engine";
import { dollarParts, formatWholeDollars } from "../../format";
import {
  buildPersonFunding,
  type PersonFundingNaming,
  type PersonFundingRow,
  type PersonMonthFigures,
} from "../../personFundingView";
import baseStyles from "./baseAdjustments.module.css";
import styles from "./fundingAttribution.module.css";

/** One "what covered it" line beneath a person — the same shape whatever the money was. */
interface CoverageLine {
  readonly key: string;
  readonly label: string;
  readonly amountCents: number;
  readonly short?: boolean;
}

/**
 * A row's coverage, in the order the cascade reached for it: their own pay, their own accounts,
 * a partner's, the card, and last what nothing reached at all. A zero line is dropped — "from
 * income $0" is noise on a row whose whole story is that no income arrived.
 */
function coverageLines(row: PersonFundingRow): CoverageLine[] {
  return [
    { key: "income", label: "From their income", amountCents: row.fromIncomeCents },
    ...row.fromOwnAccounts.map((draw) => ({
      key: `own:${draw.accountId}`,
      label: `From ${draw.label}`,
      amountCents: draw.amountCents,
    })),
    ...row.assistance.map((help) => ({
      key: `help:${help.fromPersonId}`,
      // Named as help rather than as an account, because that is the fact: the split did not
      // move, somebody else's money covered a share that is still this person's.
      label: `From ${help.fromName} (assistance)`,
      amountCents: help.amountCents,
    })),
    // An account this roster cannot name an owner for. Named as the household's rather than
    // guessed at: the one thing this view must not do is put a name on money it cannot place.
    { key: "unattributed", label: "From household funds", amountCents: row.fromUnattributedCents },
    { key: "credit", label: "On credit", amountCents: row.onCreditCents },
    { key: "short", label: "Not covered", amountCents: row.shortfallCents, short: true },
  ].filter((line) => line.amountCents > 0);
}

export interface PersonFundingProps {
  readonly figures: PersonMonthFigures;
  readonly resolvedFunding: readonly ResolvedFunding[];
  readonly obligations: readonly FinancialObligation[];
  readonly naming: PersonFundingNaming;
}

export function PersonFunding({ figures, resolvedFunding, obligations, naming }: PersonFundingProps) {
  const view = useMemo(
    () => buildPersonFunding(figures, resolvedFunding, obligations, naming),
    [figures, resolvedFunding, obligations, naming],
  );
  const totalDollars = Math.round(view.totalCents / 100);
  const shareDollars = dollarParts(view.rows.map((r) => r.shareCents), totalDollars);
  if (view.rows.length === 0) return null;

  return (
    <section>
      <h4 className={baseStyles.groupHeading}>Funded by</h4>
      <p className="hint">
        Each person’s authored share of the month’s spending, and what covered it. The split is a
        number the household wrote; the accounts are personally owned, so one partner’s money
        covering the other’s share is help — not a change to the split.
      </p>
      {view.rows.map((row, i) => {
        const lines = coverageLines(row);
        const lineDollars = dollarParts(lines.map((l) => l.amountCents), shareDollars[i]!);
        return (
          <div key={row.personId} className={styles.entry} data-person={row.personId}>
            <div className={styles.obligation}>
              <span>{row.name}</span>
              <span className={styles.amount}>{formatWholeDollars(shareDollars[i]!)}</span>
            </div>
            <ul className={styles.sources}>
              {lines.map((line, j) => (
                <li key={line.key} className={styles.source}>
                  <span className={line.short === true ? styles.shortfall : undefined}>{line.label}</span>
                  <span className={styles.sourceAmount}>{formatWholeDollars(lineDollars[j]!)}</span>
                </li>
              ))}
              {row.leftOverCents > 0 && (
                <li className={styles.source}>
                  {/* Outside the arithmetic above: what the month did not consume, not a source
                      that paid for anything. */}
                  <span className={styles.assist}>Left over</span>
                  <span className={styles.sourceAmount}>{formatWholeDollars(Math.round(row.leftOverCents / 100))}</span>
                </li>
              )}
            </ul>
          </div>
        );
      })}
      {/* The figure the rows were rounded against, printed so the reader can add them up and get
          it — which is the whole reason the rounding is cumulative rather than per row. */}
      <div className={styles.obligation} data-person-total="">
        <span>Household spending</span>
        <span className={styles.amount}>{formatWholeDollars(totalDollars)}</span>
      </div>
    </section>
  );
}
