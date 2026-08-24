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
   * The name of the person whose obligation this was, set ONLY when the money came from somebody
   * else's account — one partner covering the other's bill after their own savings ran out. It is
   * the one funding fact a household of two cannot read off the amounts: an obligation with an
   * owner is that person's to carry, so a source belonging to anyone else is help, and looks
   * identical to self-funding once the owner is dropped from both.
   *
   * Absent for a household obligation, which belongs to no one and so cannot be assisted, and for
   * any obligation paid from its own owner's account.
   */
  readonly onBehalfOf?: string;
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

/**
 * `"household"` is the owner an obligation carries when it belongs to the household rather than to
 * a member — a shared credit card. Nobody can assist a bill that is already everyone's.
 */
const HOUSEHOLD_OWNER = "household";

/**
 * Everything needed to say WHOSE money a source was, rather than only what kind. Optional as a
 * whole and field by field: a solo household has no owner to name and passes none, and every
 * lookup falls back to the label it always showed.
 */
export interface FundingNaming {
  /** Account id → the name to show for it, owner-qualified where the household has two people. */
  readonly accountLabels?: ReadonlyMap<string, string>;
  /** Account id → the id of the person who owns it. */
  readonly accountOwners?: ReadonlyMap<string, string>;
  /** Person id → their name. */
  readonly personNames?: ReadonlyMap<string, string>;
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

function sourceLine(
  source: ResolvedFundingSource,
  naming: FundingNaming,
  obligationOwnerId: string | undefined,
): FundingSourceLine {
  const accountLabels = naming.accountLabels ?? NO_NAMES;
  const accountOwners = naming.accountOwners ?? NO_NAMES;
  const personNames = naming.personNames ?? NO_NAMES;
  const label =
    source.kind === "account"
      ? accountLabels.get(source.sourceId) ?? source.sourceId
      : KIND_LABEL[source.kind];
  // Income and credit are pooled layers with no account behind them, so there is no owner to
  // compare and nothing to call assistance.
  const owedBy =
    source.kind === "account" && obligationOwnerId !== undefined && obligationOwnerId !== HOUSEHOLD_OWNER
      ? personNames.get(obligationOwnerId)
      : undefined;
  const paidBy = accountOwners.get(source.sourceId);
  const onBehalfOf = owedBy !== undefined && paidBy !== undefined && paidBy !== obligationOwnerId
    ? owedBy
    : undefined;
  const base = { kind: source.kind, label, amountCents: source.amountCents };
  const withOwner = onBehalfOf === undefined ? base : { ...base, onBehalfOf };
  return source.withdrawal !== undefined ? { ...withOwner, withdrawal: source.withdrawal } : withOwner;
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
  naming: FundingNaming = {},
): FundingAttributionRow[] {
  const labelById = new Map(obligations.map((o) => [o.id, o.label]));
  const ownerById = new Map(obligations.map((o) => [o.id, o.ownerId]));
  return resolvedFunding.map((record) => ({
    obligationId: record.obligationId,
    sourceId: record.sourceId,
    label: labelById.get(record.obligationId) ?? explicitLabel(record),
    requestedCents: record.requestedCents,
    fundedCents: record.fundedCents,
    shortfallCents: record.shortfallCents,
    fullyFunded: record.shortfallCents === 0,
    sources: record.sources.map((s) =>
      sourceLine(s, naming, ownerById.get(record.obligationId)),
    ),
  }));
}
