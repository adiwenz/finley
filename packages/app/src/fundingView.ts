/**
 * Presentation of per-line funding attribution — what covered each obligation in a month.
 *
 * A DERIVED interpretation, never a ledger fact (see CONTEXT.md, "Funding attribution"): the
 * engine imposes it by consuming a fungible pool in priority order. This layer only turns the
 * engine's {@link ResolvedFunding} records into display rows; it moves no money and decides
 * nothing. Pure — no React, no I/O — so it unit-tests in node beside the other `*View` modules.
 *
 * The one invariant it exists to protect: a record's identity is its `obligationId`, never its
 * `sourceId`. Two explicit purchases in one month may share a reporting `sourceId`
 * ("downpayment"), so this NEVER keys, dedupes or merges by `sourceId` — one record in, one row
 * out, in order. Aggregating purchases that share a purpose is a deliberate choice a caller can
 * make on `sourceId` afterward, not a collapse this layer performs for it.
 */

import type { FinancialObligation, FundingSourceKind, ResolvedFunding } from "@finley/engine";

/** One source that paid an obligation, resolved to a human label from its `kind` (never its id). */
export interface FundingSourceLine {
  readonly kind: FundingSourceKind;
  readonly label: string;
  readonly amountCents: number;
  /**
   * The resolver's withdrawal breakdown, present only for a liquidated account source (an explicit
   * draw or automatic decumulation) — absent for income, credit and the cash-buffer drawdown,
   * which realize nothing. `amountCents` equals `netDeliveredCents` when present.
   */
  readonly withdrawal?: ResolvedFundingSource["withdrawal"];
}

/** What covered one obligation this month — one row per {@link ResolvedFunding} record. */
export interface FundingAttributionRow {
  /** The obligation's identity and this row's stable key — never `sourceId`. */
  readonly obligationId: string;
  /** The obligation's reporting namespace; two purchases may share it, so it never keys a row. */
  readonly sourceId: string;
  readonly label: string;
  readonly requestedCents: number;
  readonly fundedCents: number;
  readonly shortfallCents: number;
  readonly fullyFunded: boolean;
  readonly sources: readonly FundingSourceLine[];
}

/** Import needs the source type for the `withdrawal` field; re-declared here to avoid a barrel. */
type ResolvedFundingSource = ResolvedFunding["sources"][number];

/** Fixed labels for the pooled non-account layers — neither names an account to look up. */
const KIND_LABEL: Record<Exclude<FundingSourceKind, "account">, string> = {
  income: "Income",
  credit: "Credit",
};

/**
 * A friendly label for an obligation the month never listed automatically — an explicit draw
 * (a home down payment) lives only in `resolvedFunding`, not in `obligations`. Strip the engine's
 * `draw:` prefix so the reporting purpose and its per-purchase disambiguator both show
 * ("downpayment:home-1"), keeping two same-purpose purchases legible and distinct.
 */
function explicitLabel(record: ResolvedFunding): string {
  return record.obligationId.startsWith("draw:")
    ? record.obligationId.slice("draw:".length)
    : record.obligationId;
}

function sourceLine(
  source: ResolvedFundingSource,
  accountLabels: ReadonlyMap<string, string>,
): FundingSourceLine {
  const label =
    source.kind === "account"
      ? accountLabels.get(source.sourceId) ?? source.sourceId
      : KIND_LABEL[source.kind];
  return source.withdrawal !== undefined
    ? { kind: source.kind, label, amountCents: source.amountCents, withdrawal: source.withdrawal }
    : { kind: source.kind, label, amountCents: source.amountCents };
}

/**
 * Turn a month's attribution records into display rows — one per record, in engine order, joined
 * to the obligation's authored label where one exists and derived from the record where it does
 * not. Never keyed or grouped by `sourceId`: the array's shape is the records' shape, so an
 * explicit draw sharing a purpose with another still gets its own row.
 */
export function buildFundingAttribution(
  resolvedFunding: readonly ResolvedFunding[],
  obligations: readonly FinancialObligation[] = [],
  accountLabels: ReadonlyMap<string, string> = new Map(),
): FundingAttributionRow[] {
  const labelById = new Map(obligations.map((o) => [o.id, o.label]));
  return resolvedFunding.map((record) => ({
    obligationId: record.obligationId,
    sourceId: record.sourceId,
    label: labelById.get(record.obligationId) ?? explicitLabel(record),
    requestedCents: record.requestedCents,
    fundedCents: record.fundedCents,
    shortfallCents: record.shortfallCents,
    fullyFunded: record.shortfallCents === 0,
    sources: record.sources.map((s) => sourceLine(s, accountLabels)),
  }));
}
