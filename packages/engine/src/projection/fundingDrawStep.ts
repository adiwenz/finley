/**
 * Funding draws — simulation-time resolution of an ordered, cross-account money-out draw.
 *
 * The ledger records only the intent — an explicitly-funded obligation naming an amount and an
 * ordered source list — because the split is balance-dependent. Here it is taken, with the
 * pro-rata basis accounting of {@link import("./withdrawal").buildWithdrawalSources}.
 *
 * The draw is grossed up so what remains after capital-gains tax still covers the payment,
 * and the gain routes through the tax chokepoint (`allocateMonth`) as a net-neutral source.
 * A purchase funded from an appreciated source therefore lowers net worth by the tax paid;
 * a cash source (basis == balance) conserves it.
 */

import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { TaxCategory } from "../cashFlowSeries";
import type { SimState } from "./runState";
import type { IncomeSourceMonth } from "./waterfall";
import { attributeExplicitObligation, type ResolvedFunding } from "./resolvedFunding";
import type { FinancialObligation } from "./financialObligation";

export type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;
/** The month's taxable base, per owner — the context a gross-up differences tax over. */
export type TaxableByOwner = Map<string, TaxableByCategory>;

/** Backstop on the gross-up climb; a realistic draw converges in about a dozen steps. */
const GROSS_UP_ITERATIONS = 1_000;

export interface FundingSourceState {
  readonly id: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly balanceCents: Cents;
  readonly basisCents: Cents;
  readonly label?: string;
}

export interface ResolvedFundingSource {
  readonly id: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly label?: string;
  /** Sold from the account, grossed up over its own tax. */
  readonly grossCents: Cents;
  /** Realized taxable gain within `grossCents`. */
  readonly gainCents: Cents;
  /** Marginal tax the gain induced over the running owner base. */
  readonly taxCents: Cents;
  /** `grossCents − gainCents`. */
  readonly principalCents: Cents;
  /** What reached the purchase — `grossCents − taxCents`. */
  readonly netDeliveredCents: Cents;
}

export interface OrderedFundingDrawResult {
  readonly perSource: readonly ResolvedFundingSource[];
  /** Σ `netDeliveredCents`. */
  readonly netDeliveredCents: Cents;
  /** `max(0, amount − netDelivered)`. */
  readonly shortfallCents: Cents;
}

/** Per-owner taxable base from the month's already-resolved (non-funding) income. */
export function buildTaxableByOwner(sources: readonly IncomeSourceMonth[]): TaxableByOwner {
  const taxableByOwner: TaxableByOwner = new Map();
  for (const src of sources) {
    let map = taxableByOwner.get(src.ownerId);
    if (map === undefined) {
      map = {};
      taxableByOwner.set(src.ownerId, map);
    }
    const amount = src.taxableCents ?? src.waterfallInflowCents;
    if (amount !== 0) map[src.taxCategory] = (map[src.taxCategory] ?? 0) + amount;
  }
  return taxableByOwner;
}

/** Serializable snapshot, for the flow view / gate seam. */
export function toTaxableRecord(taxableByOwner: TaxableByOwner): Record<string, TaxableByCategory> {
  const record: Record<string, TaxableByCategory> = {};
  for (const [ownerId, byCategory] of taxableByOwner) record[ownerId] = { ...byCategory };
  return record;
}

/**
 * Resolve an ordered draw of `amountCents` across `sources` without mutating account state:
 * sell enough from each in turn that the net (after the tax the sale induces) covers the
 * remainder, floored at what it holds. Tax is differenced over `taxableByOwner` and each
 * gain stacked onto it, so a second taxable source from the same owner is taxed on top of
 * the first — hence this MUTATES `taxableByOwner` (pass a copy to probe).
 *
 * Shared with the §4.5 affordability gate, so the gate blocks exactly when the sim would
 * fall short.
 */
export function resolveOrderedFundingDraw(
  amountCents: Cents,
  sources: readonly FundingSourceState[],
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  taxableByOwner: TaxableByOwner,
): OrderedFundingDrawResult {
  const computeTaxCents = (taxable: TaxableByCategory): Cents =>
    jurisdiction.computeTaxCents(taxable, ctx);

  const perSource: ResolvedFundingSource[] = [];
  let remaining = amountCents;

  for (const source of sources) {
    if (remaining <= 0) break;
    const balance = source.balanceCents;
    if (balance <= 0) continue;
    const { id, ownerId, category, label } = source;
    const basis = Math.max(0, source.basisCents);
    const basisFraction = balance > 0 ? Math.min(1, basis / balance) : 0;
    // The jurisdiction owns return-of-capital policy; absent the seam, fall back to the
    // pro-rata basis split. Must stay monotone non-decreasing — the climb below relies on it.
    const gainOf = (gross: Cents): Cents =>
      jurisdiction.taxableWithdrawalCents?.(
        { grossCents: gross, basisCents: basis, balanceCents: balance, category },
        ctx,
      ) ?? gross - Math.round(gross * basisFraction);

    const base = taxableByOwner.get(ownerId) ?? {};
    const withGain = (gross: Cents): TaxableByCategory => ({
      ...base,
      [category]: (base[category] ?? 0) + gainOf(gross),
    });
    const baseTax = computeTaxCents(base);
    const inducedTax = (gross: Cents): Cents => computeTaxCents(withGain(gross)) - baseTax;

    // Least fixed point of `gross = remaining + inducedTax(gross)`, climbed from `remaining`
    // and capped at the balance — the same solve as the decumulation withdrawal.
    let gross = Math.min(balance, remaining);
    for (let i = 0; i < GROSS_UP_ITERATIONS; i++) {
      const wanted = remaining + inducedTax(gross);
      // Cannot cover its own gross-up: take what is there, the rest falls to the next source.
      if (wanted >= balance) {
        gross = balance;
        break;
      }
      if (wanted === gross) break;
      gross = wanted;
    }

    const gain = gainOf(gross);
    const tax = computeTaxCents(withGain(gross)) - baseTax;
    taxableByOwner.set(ownerId, withGain(gross));
    const netDelivered = gross - tax;
    remaining -= netDelivered;
    perSource.push({
      id,
      ownerId,
      category,
      label,
      grossCents: gross,
      gainCents: gain,
      taxCents: tax,
      principalCents: gross - gain,
      netDeliveredCents: netDelivered,
    });
  }

  return {
    perSource,
    netDeliveredCents: amountCents - remaining,
    shortfallCents: Math.max(0, remaining),
  };
}

/**
 * The bands and tax routing one month's funding draws produce:
 * - `gainSources` — one band per source that realized a gain, reporting-only
 *   (`waterfallInflowCents` 0), for {@link import("./reportFlows").buildFlows};
 * - `principalDrawdownCents` — returned principal across all sources (a cash source
 *   contributes its whole draw), folded into the `savingsDrawdown` band;
 * - `taxSources` — net-neutral sources routing each gain through the tax chokepoint, folded
 *   into `incomeSources` BEFORE `allocateMonth`;
 * - `taxableByOwnerAfter` — the taxable base with this month's draws stacked in, read by the
 *   authoring gate (via `flows`) so a second money-out event in the same month is priced
 *   over its sibling's realized gain;
 * - `resolvedFunding` — one per-line attribution record per explicit draw, every source an
 *   account, so the flow view carries explicit and automatic obligations through one shape.
 */
export interface FundingDrawReport {
  readonly gainSources: readonly IncomeSourceMonth[];
  readonly principalDrawdownCents: Cents;
  readonly taxSources: readonly IncomeSourceMonth[];
  readonly taxableByOwnerAfter: TaxableByOwner;
  readonly resolvedFunding: readonly ResolvedFunding[];
  /**
   * The first draw this month whose named sources could not cover it, if any — the block. When
   * set, this draw and every draw after it were NOT applied: no balance moved, no gain or tax
   * booked, no attribution recorded. Draws before it resolved and applied normally.
   */
  readonly block?: FundingBlock;
}

/** A draw that fell short of its named sources — the projection's terminal event. */
export interface FundingBlock {
  readonly obligation: FinancialObligation;
  readonly requiredCents: Cents;
  /** What the named sources delivered net of tax — `required − shortfall`. */
  readonly availableCents: Cents;
  readonly shortfallCents: Cents;
}

/**
 * Resolve every funding draw scheduled at `month` against the live `SimState`. PRE-FLIGHTED: each
 * draw is priced against a scratch copy of the affected balances before any real balance moves, so
 * the first draw whose named sources fall short is identified as the {@link FundingBlock} WITHOUT
 * having half-drained an account. A block omits its own draw and every draw after it — the block is
 * a structural state, not a partial mutation that depends on execution order. Draws before it
 * resolve and apply exactly as they always did.
 *
 * The gross-up is {@link resolveOrderedFundingDraw}, the one definition the §4.5 gate shares — so
 * an accepted purchase never lands short here, and a stranded one blocks identically.
 *
 * `taxableByOwner` is NOT mutated: a working copy is threaded across draws, stacking each applied
 * draw's gain onto the next, and comes back as `taxableByOwnerAfter`. A blocked draw's gain is
 * never stacked — it did not sell anything.
 */
export function resolveFundingDraws(
  state: SimState,
  month: number,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  taxableByOwner: TaxableByOwner,
): FundingDrawReport {
  const gainSources: IncomeSourceMonth[] = [];
  const taxSources: IncomeSourceMonth[] = [];
  const resolvedFunding: ResolvedFunding[] = [];
  let principalDrawdownCents = 0;
  let block: FundingBlock | undefined;

  const working: TaxableByOwner = new Map();
  for (const [ownerId, byCategory] of taxableByOwner) working.set(ownerId, { ...byCategory });

  // Scratch balances/basis: each applied draw drains these before the next is priced, and the real
  // `state` maps are only touched once a draw is known to be fundable, one draw at a time.
  const scratchBalances = new Map<string, Cents>();
  const scratchBasis = new Map<string, Cents>();
  const readScratch = (map: Map<string, Cents>, fallback: Map<string, Cents>, id: string): Cents =>
    map.has(id) ? (map.get(id) ?? 0) : (fallback.get(id) ?? 0);

  for (const obligation of state.fundingDraws) {
    if (obligation.month !== month) continue;
    // A funding draw is an explicitly-funded asset acquisition: `explicit` names the accounts to
    // drain (an automatic obligation has none — the waterfall funds it), and `asset-acquisition`
    // is what makes it a draw that books a gain band plus a net-neutral tax band. Both fields
    // gate resolution here; the `sourceId` below is the bands' namespace.
    if (obligation.funding.kind !== "explicit" || obligation.treatment !== "asset-acquisition") {
      continue;
    }
    const orderedAccountIds = obligation.funding.orderedAccountIds;
    const sources: FundingSourceState[] = [];
    for (const sourceId of orderedAccountIds) {
      const account = state.accounts.find((a) => a.id === sourceId);
      if (account === undefined) continue;
      sources.push({
        id: sourceId,
        ownerId: account.ownerId,
        category: account.taxProfile.withdrawalCategory,
        balanceCents: readScratch(scratchBalances, state.assetBalances, sourceId),
        basisCents: Math.max(0, readScratch(scratchBasis, state.basisByAccount, sourceId)),
        label: account.label ?? sourceId,
      });
    }
    // Probe against a COPY of the running taxable base: a blocked draw must not stack its partial
    // gains onto `working`, since it never sells anything.
    const probe: TaxableByOwner = new Map();
    for (const [ownerId, byCategory] of working) probe.set(ownerId, { ...byCategory });
    const { perSource, shortfallCents } = resolveOrderedFundingDraw(
      obligation.amountCents,
      sources,
      jurisdiction,
      ctx,
      probe,
    );
    if (shortfallCents > 0) {
      // The block. Omit this draw and everything after it — no state moves, no attribution.
      block = {
        obligation,
        requiredCents: obligation.amountCents,
        availableCents: obligation.amountCents - shortfallCents,
        shortfallCents,
      };
      break;
    }
    // Fundable: commit the probe's taxable base, drain the scratch balances, then apply the real
    // moves. Scratch and real drain identically (scratch opened from real), so the two agree.
    for (const [ownerId, byCategory] of probe) working.set(ownerId, byCategory);
    // Attribution mirrors the money exactly: each drained account (a zero-gross source touched
    // nothing) becomes one `account` source carrying its own withdrawal breakdown, and Σ net
    // delivered is the obligation's funded amount. Recorded off the same `perSource` the balance
    // moves below read, so the record and the ledger cannot diverge.
    resolvedFunding.push(
      attributeExplicitObligation(
        obligation,
        perSource
          .filter((s) => s.grossCents > 0)
          .map((s) => ({
            accountId: s.id,
            grossWithdrawnCents: s.grossCents,
            principalCents: s.principalCents,
            realizedGainCents: s.gainCents,
            taxCents: s.taxCents,
            netDeliveredCents: s.netDeliveredCents,
          })),
      ),
    );
    const prefix = obligation.sourceId;

    for (const s of perSource) {
      if (s.grossCents <= 0) continue;
      const balanceBefore = readScratch(scratchBalances, state.assetBalances, s.id);
      const basisBefore = readScratch(scratchBasis, state.basisByAccount, s.id);
      scratchBalances.set(s.id, balanceBefore - s.grossCents);
      scratchBasis.set(s.id, Math.max(0, basisBefore - s.principalCents));
      state.assetBalances.set(s.id, balanceBefore - s.grossCents);
      state.basisByAccount.set(s.id, Math.max(0, basisBefore - s.principalCents));
      principalDrawdownCents += s.principalCents;

      // A zero-gain (cash) source books no band: pure returned principal, surfacing only
      // through the savings drawdown.
      if (s.gainCents > 0) {
        gainSources.push({
          ownerId: s.ownerId,
          // Reporting-only: buildFlows reads this band, the waterfall never does.
          waterfallInflowCents: 0,
          cashInflowCents: s.gainCents,
          taxCategory: s.category,
          taxableCents: 0,
          sourceId: `${prefix}:${s.id}`,
          label: s.label ?? s.id,
        });
      }
      // Net-neutral: carries the tax slice as cash and books the gain as taxable, so
      // `allocateMonth` charges exactly `tax` and nets zero. `cashInflowCents` 0 keeps it
      // out of the income view.
      if (s.taxCents > 0) {
        taxSources.push({
          ownerId: s.ownerId,
          waterfallInflowCents: s.taxCents,
          cashInflowCents: 0,
          taxCategory: s.category,
          taxableCents: s.gainCents,
          sourceId: `${prefix}-tax:${s.id}`,
          label: s.label ?? s.id,
        });
      }
    }
  }

  return {
    gainSources,
    principalDrawdownCents,
    taxSources,
    taxableByOwnerAfter: working,
    resolvedFunding,
    ...(block !== undefined ? { block } : {}),
  };
}
