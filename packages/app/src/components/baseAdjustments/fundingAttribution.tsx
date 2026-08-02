/**
 * **Funded by** — what covered each obligation at the selected month. Read-only: it makes the
 * month's funding walk visible so a stretch quietly running on credit shows up here rather than
 * only later, as a bend in the net-worth line.
 *
 * A DERIVED interpretation, never authored (see CONTEXT.md, "Funding attribution"): the engine
 * imposes "this line went on credit, that one came from income" by consuming a fungible pool in
 * priority order. Framed accordingly — "funded by", not "paid with".
 *
 * One entry per {@link ResolvedFunding} record, keyed by `obligationId` — never `sourceId` — so
 * two explicit purchases sharing a reporting purpose in one month each get their own entry. Any
 * aggregation is a deliberate choice a caller could make on `sourceId`, not one this view performs.
 */

import { useMemo } from "react";
import type { FinancialObligation, ResolvedFunding } from "@finley/engine";
import { formatDollars } from "../../format";
import { buildFundingAttribution, type FundingSourceLine } from "../../fundingView";
import baseStyles from "./baseAdjustments.module.css";
import styles from "./fundingAttribution.module.css";

/** The account withdrawal breakdown as one muted line; only a liquidated source carries it. */
function WithdrawalDetail({ withdrawal }: { readonly withdrawal: NonNullable<FundingSourceLine["withdrawal"]> }) {
  return (
    <span className={styles.withdrawal}>
      {formatDollars(withdrawal.grossWithdrawnCents)} gross ·{" "}
      {formatDollars(withdrawal.principalCents)} basis ·{" "}
      {formatDollars(withdrawal.realizedGainCents)} gain ·{" "}
      {formatDollars(withdrawal.taxCents)} tax ·{" "}
      {formatDollars(withdrawal.netDeliveredCents)} net
    </span>
  );
}

function SourceRow({ source }: { readonly source: FundingSourceLine }) {
  return (
    <li className={styles.source}>
      <span>{source.label}</span>
      <span className={styles.sourceAmount}>{formatDollars(source.amountCents)}</span>
      {source.withdrawal !== undefined && <WithdrawalDetail withdrawal={source.withdrawal} />}
    </li>
  );
}

export interface FundingAttributionProps {
  /** The selected month's per-obligation attribution — `flows.resolvedFunding`. */
  readonly resolvedFunding: readonly ResolvedFunding[];
  /** The month's automatic obligations, for their authored labels; explicit draws are absent here. */
  readonly obligations: readonly FinancialObligation[];
  /** Account id → friendly name, so an account source reads as its label rather than its id. */
  readonly accountLabels?: ReadonlyMap<string, string>;
}

export function FundingAttribution({ resolvedFunding, obligations, accountLabels }: FundingAttributionProps) {
  const rows = useMemo(
    () => buildFundingAttribution(resolvedFunding, obligations, accountLabels),
    [resolvedFunding, obligations, accountLabels],
  );
  if (rows.length === 0) return null;

  return (
    <section>
      <h4 className={baseStyles.groupHeading}>Funded by</h4>
      <p className="hint">
        How the month covered each obligation, in the order it drew on its money. A derived view of a
        fungible pool, not an authored fact — reordering priorities would reassign which line was financed.
      </p>
      {rows.map((row) => (
        <div key={row.obligationId} className={styles.entry} data-obligation={row.obligationId}>
          <div className={styles.obligation}>
            <span>
              {row.label}
              {!row.fullyFunded && (
                <span className={styles.shortfall}> · {formatDollars(row.shortfallCents)} short</span>
              )}
            </span>
            <span className={styles.amount}>{formatDollars(row.fundedCents)}</span>
          </div>
          <ul className={styles.sources}>
            {row.sources.map((source, i) => (
              <SourceRow key={`${source.kind}:${source.label}:${i}`} source={source} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
