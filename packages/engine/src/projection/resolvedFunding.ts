/**
 * Per-line funding attribution — which sources paid each obligation, and how much.
 *
 * A DERIVED interpretation, never a ledger fact (see CONTEXT.md, "Funding attribution"): money
 * is fungible, and "the car payment went on the Visa while rent came from income" is imposed by
 * the priority order this walk consumes sources in, not observed. Reordering the priorities would
 * reassign which line was financed. It is computed DURING the funding walk — a partition of a
 * flow that already happened — so it moves no money: balances, basis, tax, net worth and the
 * insolvency flag are identical whether or not this runs.
 *
 * The walk offers each obligation, in {@link orderObligationsByPriority} order, the month's supply
 * in strict cascade order: income cash, then the liquid-buffer drawdown, then each decumulation
 * draw, then credit. Every obligation is fully funded until credit is genuinely exhausted; only
 * once the last layer runs dry does a low-priority line fall short, which is the same residual
 * the month reports as insolvency.
 */

import type { Cents } from "../money";
import type { FinancialObligation } from "./financialObligation";
import { orderObligationsByPriority } from "./financialObligation";

/**
 * Where a funded dollar came from. `sourceId` pairs with `kind` because an automatic obligation's
 * payer is frequently not an account: income never lands in an account before being spent, and a
 * credit card is a liability. Consumers read `kind` rather than parsing the id.
 */
export type FundingSourceKind = "income" | "account" | "credit";

export interface ResolvedFundingSource {
  readonly kind: FundingSourceKind;
  readonly sourceId: string;
  /** Net amount delivered toward the obligation by this source. */
  readonly amountCents: Cents;
  /**
   * Present for account-funded sources where the funding resolver performs a withdrawal or
   * liquidation. Populated with the resolver's full breakdown by a later task; unset here for
   * the liquid-buffer drawdown (a cash spend that realizes nothing).
   */
  readonly withdrawal?: {
    readonly grossWithdrawnCents: Cents;
    readonly principalCents: Cents;
    readonly realizedGainCents: Cents;
    readonly taxCents: Cents;
    readonly netDeliveredCents: Cents;
  };
}

export interface ResolvedFunding {
  /** The obligation's stable {@link FinancialObligation.id} — its identity, never `sourceId`. */
  readonly obligationId: string;
  /** The obligation's reporting namespace; two purchases may share it, so it never keys a record. */
  readonly sourceId: string;
  readonly month: number;
  readonly requestedCents: Cents;
  readonly fundedCents: Cents;
  readonly shortfallCents: Cents;
  /** The sources that paid it, in the cascade order they were consumed. */
  readonly sources: readonly ResolvedFundingSource[];
}

/**
 * A decumulation draw's contribution toward the month's obligations: an investment account's
 * liquidation, keyed by account id and reported by its net cash delivered. The detailed
 * withdrawal breakdown (gross, basis, gain, tax) is folded into {@link ResolvedFundingSource} by
 * a later task; the attribution walk needs only the net each account delivered.
 */
export interface DecumulationDraw {
  readonly sourceId: string;
  readonly netDeliveredCents: Cents;
}

/**
 * The month's supply, laid out in the exact cascade order the walk consumes it. Each field is the
 * slice that layer delivered toward the automatic obligations, so Σ over all of them is the total
 * the month actually funded. Sized by the simulator from the same figures that moved the money —
 * this record only re-describes that flow, it never re-decides it.
 */
export interface FundingSupplyPlan {
  /** Non-withdrawal net income (wages, benefits, RMDs, interest) applied to obligations. */
  readonly incomeCents: Cents;
  /** The liquid cash buffer spent before any investment was sold; null when there is none. */
  readonly liquidDrawdown: { readonly sourceId: string; readonly amountCents: Cents } | null;
  /** Investment liquidations, in liquidation order. */
  readonly decumulationDraws: readonly DecumulationDraw[];
  /** What the shortfall cascade borrowed onto credit toward obligations. */
  readonly creditCents: Cents;
}

/** Fixed id/kind for the pooled non-account layers — income and credit have no account to name. */
const INCOME_SOURCE_ID = "income";
const CREDIT_SOURCE_ID = "credit";

interface Layer {
  readonly kind: FundingSourceKind;
  readonly sourceId: string;
  remaining: Cents;
}

/** The supply as an ordered, mutable list of layers — a 0-amount layer is dropped, not offered. */
function orderedLayers(supply: FundingSupplyPlan): Layer[] {
  const layers: Layer[] = [];
  if (supply.incomeCents > 0) {
    layers.push({ kind: "income", sourceId: INCOME_SOURCE_ID, remaining: supply.incomeCents });
  }
  if (supply.liquidDrawdown !== null && supply.liquidDrawdown.amountCents > 0) {
    layers.push({
      kind: "account",
      sourceId: supply.liquidDrawdown.sourceId,
      remaining: supply.liquidDrawdown.amountCents,
    });
  }
  for (const draw of supply.decumulationDraws) {
    if (draw.netDeliveredCents > 0) {
      layers.push({ kind: "account", sourceId: draw.sourceId, remaining: draw.netDeliveredCents });
    }
  }
  if (supply.creditCents > 0) {
    layers.push({ kind: "credit", sourceId: CREDIT_SOURCE_ID, remaining: supply.creditCents });
  }
  return layers;
}

/**
 * One account's contribution to an explicit draw, as the funding resolver measured it: the
 * withdrawal breakdown plus which account delivered it. {@link attributeExplicitObligation} copies
 * it verbatim onto a source, so `netDeliveredCents` is both the source's `amountCents` and its
 * `withdrawal.netDeliveredCents` — the two agree by construction, never by a separate reconcile.
 */
export interface ExplicitDrawSource {
  readonly accountId: string;
  readonly grossWithdrawnCents: Cents;
  readonly principalCents: Cents;
  readonly realizedGainCents: Cents;
  readonly taxCents: Cents;
  readonly netDeliveredCents: Cents;
}

/**
 * Attribute an explicitly-funded obligation to the accounts it named. It drains its own ordered
 * accounts instead of the shared supply, so every source is `kind: "account"` and none is ever
 * income — the SAME record shape the automatic branch emits, so a consumer reads `kind` and never
 * parses ids to tell the two branches apart. `fundedCents` is Σ net delivered; whatever the named
 * accounts could not cover is left as `shortfallCents` (the money is not rationed onto credit —
 * that only arrives in a later slice).
 */
export function attributeExplicitObligation(
  obligation: FinancialObligation,
  drawSources: readonly ExplicitDrawSource[],
): ResolvedFunding {
  const sources: ResolvedFundingSource[] = drawSources.map((s): ResolvedFundingSource => ({
    kind: "account",
    sourceId: s.accountId,
    amountCents: s.netDeliveredCents,
    withdrawal: {
      grossWithdrawnCents: s.grossWithdrawnCents,
      principalCents: s.principalCents,
      realizedGainCents: s.realizedGainCents,
      taxCents: s.taxCents,
      netDeliveredCents: s.netDeliveredCents,
    },
  }));
  const fundedCents = sources.reduce((total, s) => total + s.amountCents, 0);
  return {
    obligationId: obligation.id,
    sourceId: obligation.sourceId,
    month: obligation.month,
    requestedCents: obligation.amountCents,
    fundedCents,
    shortfallCents: Math.max(0, obligation.amountCents - fundedCents),
    sources,
  };
}

/**
 * Attribute each automatically-funded obligation to the sources that paid it. Explicit obligations
 * are excluded here — they name their own accounts and never draw this shared supply, so
 * {@link attributeExplicitObligation} records them separately from the resolver that drains those
 * accounts. Both branches yield the identical {@link ResolvedFunding} shape.
 *
 * The layers carry mutable `remaining` so a higher-priority obligation drains a layer before a
 * lower-priority one reaches it — that draining IS the interpretation. Whatever supply is left
 * after the last obligation is unspent capacity; whatever obligation need is left after the last
 * layer is the shortfall the month reports as insolvency.
 */
export function resolveFundingAttribution(
  obligations: readonly FinancialObligation[],
  supply: FundingSupplyPlan,
): ResolvedFunding[] {
  const layers = orderedLayers(supply);
  const resolved: ResolvedFunding[] = [];
  for (const o of orderObligationsByPriority(obligations)) {
    if (o.funding.kind !== "automatic") continue;
    let need = o.amountCents;
    const sources: ResolvedFundingSource[] = [];
    for (const layer of layers) {
      if (need <= 0) break;
      if (layer.remaining <= 0) continue;
      const take = Math.min(need, layer.remaining);
      layer.remaining -= take;
      need -= take;
      sources.push({ kind: layer.kind, sourceId: layer.sourceId, amountCents: take });
    }
    resolved.push({
      obligationId: o.id,
      sourceId: o.sourceId,
      month: o.month,
      requestedCents: o.amountCents,
      fundedCents: o.amountCents - need,
      shortfallCents: need,
      sources,
    });
  }
  return resolved;
}
