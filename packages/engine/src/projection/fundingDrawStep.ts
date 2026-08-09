/**
 * Funding draws — simulation-time resolution of an ordered, cross-account money-out draw.
 *
 * The ledger records only the intent — an explicitly-funded obligation naming an amount and an
 * ordered source list — because the split is balance-dependent. Here it is taken, with the
 * pro-rata basis accounting of {@link import("./withdrawal").buildWithdrawalSources}.
 *
 * An account draw is grossed up so what remains after capital-gains tax still covers the payment,
 * and the gain routes through the tax chokepoint (`allocateMonth`) as a net-neutral source.
 * A purchase funded from an appreciated source therefore lowers net worth by the tax paid;
 * a cash source (basis == balance) conserves it. A credit source instead borrows against the
 * card's headroom with no sale and no tax — the discriminated {@link FundingSourceState} lets both
 * walk the one ordered list, so the user's authored order is honoured and never reshuffled.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { SimState } from "./runState";
import type { IncomeSourceMonth } from "./waterfall";
import { attributeExplicitObligation, type ResolvedFunding } from "./resolvedFunding";
import type { FinancialObligation } from "./financialObligation";
import { classifyFundingFailure, type FundingFailure, type EligibleAccountState } from "./fundingFailure";
import type { FundingTreatment } from "./fundingEligibility";
import { RevolvingCard, SYNTHETIC_CARD_ID } from "../liability/liability";

export type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;
/** The month's taxable base, per owner — the context a gross-up differences tax over. */
export type TaxableByOwner = Map<string, TaxableByCategory>;

/** Backstop on the gross-up climb; a realistic draw converges in about a dozen steps. */
const GROSS_UP_ITERATIONS = 1_000;

/**
 * An account source: liquidated and grossed up over the capital-gains tax the sale induces, with a
 * pro-rata basis split. `kind` is optional so the many asset-only source literals across the engine
 * need no `"account"` tag; absent → an account.
 */
export interface AccountFundingSource {
  readonly kind?: "account";
  readonly id: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly balanceCents: Cents;
  readonly basisCents: Cents;
  readonly label?: string;
}

/**
 * A credit source: the draw BORROWS against the card's remaining headroom rather than selling
 * anything. `balanceCents` is the amount currently owed and `creditLimitCents` the borrowing
 * ceiling — `null` when no limit was entered, which is treated as ZERO usable headroom, never as
 * unbounded, matching the picker (which greys a limitless card) and the failure classifier's
 * `capacityOf`. An unbounded card would trivially fund anything and could never block, which would
 * make coverage advice meaningless. No sale means no basis, no realized gain, and no tax — the
 * borrow itself is the funding action, and it never grosses up or stacks onto the owner's taxable
 * base.
 */
export interface CreditFundingSource {
  readonly kind: "credit";
  readonly id: string;
  readonly ownerId: string;
  readonly balanceCents: Cents;
  readonly creditLimitCents: Cents | null;
  readonly label?: string;
}

/** A source the ordered draw walks: an asset account it sells, or a credit line it borrows on. */
export type FundingSourceState = AccountFundingSource | CreditFundingSource;

export interface ResolvedFundingSource {
  /** Which kind of source delivered this slice — an account sale or a credit borrow. */
  readonly kind: "account" | "credit";
  readonly id: string;
  readonly ownerId: string;
  /** The account's withdrawal tax category; `"taxExempt"` for a credit borrow, which realizes none. */
  readonly category: TaxCategory;
  readonly label?: string;
  /** Sold from the account and grossed up over its own tax; for credit, the amount borrowed. */
  readonly grossCents: Cents;
  /** Realized taxable gain within `grossCents` — always 0 for a credit borrow. */
  readonly gainCents: Cents;
  /** Marginal tax the gain induced over the running owner base — always 0 for a credit borrow. */
  readonly taxCents: Cents;
  /** `grossCents − gainCents`; the whole borrow for credit, which realizes no gain. */
  readonly principalCents: Cents;
  /** What reached the purchase — `grossCents − taxCents`; equal to `grossCents` for credit. */
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
 * Resolve an ordered draw of `amountCents` across `sources` without mutating account state. Each
 * source is taken in turn until the remainder is covered: an account source sells enough that the
 * net (after the tax the sale induces) covers the remainder, floored at what it holds; a credit
 * source borrows the remainder against its headroom (`limit − balance`, clamped at zero; a `null`
 * limit is zero headroom, not unbounded), tax-free. Both walk the ONE ordered list — a
 * `[brokerage, visa]` list sells then borrows, never reordered.
 *
 * Account tax is differenced over `taxableByOwner` and each gain stacked onto it, so a second
 * taxable source from the same owner is taxed on top of the first — hence this MUTATES
 * `taxableByOwner` (pass a copy to probe). A credit borrow realizes nothing and stacks nothing.
 *
 * Shared with the affordability reporter (`fundingLookup.availabilityAt`), so the reported
 * shortfall matches exactly what the sim would fall short by.
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

    // Credit borrows against headroom instead of selling. `availableCredit = limit − balance`
    // clamped at zero; a null limit (no limit entered) is ZERO headroom, never unbounded — an
    // unbounded card would trivially cover any remainder and could never block. No sale means no
    // basis, no gain, no tax, and nothing stacked onto the owner base — the borrow is delivered in
    // full and IS the funding action. A maxed or limitless card (headroom ≤ 0) is skipped exactly
    // as a $0 account is, so it never lands as a zero source.
    if (source.kind === "credit") {
      const headroom =
        source.creditLimitCents === null
          ? 0
          : Math.max(0, source.creditLimitCents - source.balanceCents);
      const borrowed = Math.min(remaining, headroom);
      if (borrowed <= 0) continue;
      remaining -= borrowed;
      perSource.push({
        kind: "credit",
        id: source.id,
        ownerId: source.ownerId,
        category: "taxExempt",
        label: source.label,
        grossCents: borrowed,
        gainCents: 0,
        taxCents: 0,
        principalCents: borrowed,
        netDeliveredCents: borrowed,
      });
      continue;
    }

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
      kind: "account",
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
 *   account, so the flow view carries explicit and automatic obligations through one shape;
 * - `omittedSourceEventIds` — the complete set of source event IDs whose draws were not
 *   executed, including the blocking event and any later events skipped. Used to suppress all
 *   artifacts (properties, liabilities) originating from these events.
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
  /**
   * All source event IDs whose draws were omitted: the blocking event and every later event
   * skipped because processing stopped. A separate set from the block details, which report
   * only the first shortfall for display; this set is complete for suppressing all artifacts.
   */
  readonly omittedSourceEventIds: ReadonlySet<string>;
}

/** A draw that fell short of its named sources — the projection's terminal event. */
export interface FundingBlock {
  readonly obligation: FinancialObligation;
  readonly requiredCents: Cents;
  /** What the named sources delivered net of tax — `required − shortfall`. */
  readonly availableCents: Cents;
  readonly shortfallCents: Cents;
  /**
   * Why the draw fell short: eligible money sits elsewhere (a funding-configuration mistake) or
   * nothing eligible suffices. Classified against the household's whole account pool at this
   * month, priced through the same gross-up as the draw itself — advisory, never a reassignment.
   */
  readonly fundingFailure: FundingFailure;
}

/**
 * Resolve every funding draw scheduled at `month` against the live `SimState`. PRE-FLIGHTED: each
 * draw is fully priced — {@link resolveOrderedFundingDraw} reads the balances but never mutates
 * them — before any of its balance moves are committed, so the first draw whose named sources fall
 * short is identified as the {@link FundingBlock} WITHOUT having half-drained an account. A block
 * omits its own draw and every draw after it — the block is a structural state, not a partial
 * mutation that depends on execution order. Draws before it resolve and apply exactly as they
 * always did, so the next draw prices over the balances they left behind.
 *
 * Every omitted draw's event is reported in `omittedSourceEventIds` — the blocking event AND every
 * later same-month event whose draw was skipped. An event's artifacts (a property, its mortgage)
 * are originated by a step separate from its draw, so suppressing only the blocking event would
 * still mint the skipped events' houses and loans with no cash ever leaving. Suppression is keyed
 * on this complete set; only the FIRST shortfall is reported as the {@link FundingBlock}, since a
 * later draw was never priced and so has no shortfall to state.
 *
 * The gross-up is {@link resolveOrderedFundingDraw}, the one definition the affordability reporter
 * (`fundingLookup.availabilityAt`) shares — so the shortfall a preview reports is exactly the one a
 * stranded purchase blocks on here.
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
  const omittedSourceEventIds = new Set<string>();

  const working: TaxableByOwner = new Map();
  for (const [ownerId, byCategory] of taxableByOwner) working.set(ownerId, { ...byCategory });

  // This month's draws, in resolution order, materialized BEFORE any is priced: a block has to name
  // not just the draw that fell short but every draw after it that consequently never ran, and that
  // tail is only knowable from the whole list. A funding draw is any EXPLICITLY-funded obligation:
  // `explicit` names the sources to drain in order (an automatic obligation has none — the waterfall
  // funds it). Both an asset acquisition (a home down payment) and an expense (a one-time spend) can
  // be explicit; the difference is only whether it buys an asset or reduces net worth outright, which
  // the balance moves below already express. Anything filtered out here is not a draw at all, so a
  // block never omits it.
  const draws = state.fundingDraws.filter(
    (o) => o.month === month && o.funding.kind === "explicit",
  );

  for (const [index, obligation] of draws.entries()) {
    // Narrowing only: the filter above already established this.
    if (obligation.funding.kind !== "explicit") continue;
    const orderedAccountIds = obligation.funding.orderedAccountIds;
    const sources: FundingSourceState[] = [];
    for (const sourceId of orderedAccountIds) {
      const account = state.accounts.find((a) => a.id === sourceId);
      if (account !== undefined) {
        sources.push({
          kind: "account",
          id: sourceId,
          ownerId: account.ownerId,
          category: account.taxProfile.withdrawalCategory,
          balanceCents: state.assetBalances.get(sourceId) ?? 0,
          basisCents: Math.max(0, state.basisByAccount.get(sourceId) ?? 0),
          label: account.label ?? sourceId,
        });
        continue;
      }
      // A named credit card borrows against its headroom instead of selling. The synthetic
      // shortfall card is an internal cascade artifact and is never authorable as a source, so it
      // is skipped even if its id somehow appears. `balanceCents` here is the amount owed, from the
      // authoritative liability map, so headroom is priced over the debt as it stands this month.
      const cardCandidate = state.liabilities.find(
        (l): l is RevolvingCard =>
          l instanceof RevolvingCard && l.id === sourceId && l.id !== SYNTHETIC_CARD_ID,
      );
      if (cardCandidate !== undefined) {
        sources.push({
          kind: "credit",
          id: sourceId,
          ownerId: cardCandidate.ownerId,
          balanceCents: state.liabilityBalances.get(sourceId) ?? 0,
          creditLimitCents: cardCandidate.creditLimitCents,
          label: sourceId,
        });
      }
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
      // Classify WHY against the whole eligible pool at this month's balances, priced over the
      // running taxable base (`working`, before this never-applied draw). The classifier copies
      // the base per probe, so `working` is not disturbed. The pool carries both asset accounts and
      // real credit cards; eligibility (keyed on the obligation's treatment) then admits cards only
      // for an expense, so a stranded spend can be told "an unselected card could cover this" while
      // a stranded down payment never is. Explicit obligations are only ever expense or
      // asset-acquisition (a debt payment is always automatic), so the treatment narrows to those.
      const accountPool: EligibleAccountState[] = [
        ...state.accounts.map((a) => ({
          kind: "account" as const,
          id: a.id,
          ownerId: a.ownerId,
          category: a.taxProfile.withdrawalCategory,
          balanceCents: state.assetBalances.get(a.id) ?? 0,
          basisCents: Math.max(0, state.basisByAccount.get(a.id) ?? 0),
          liquid: a.liquid,
        })),
        ...state.liabilities
          .filter(
            (l): l is RevolvingCard => l instanceof RevolvingCard && l.id !== SYNTHETIC_CARD_ID,
          )
          .map((c) => ({
            kind: "credit" as const,
            id: c.id,
            ownerId: c.ownerId,
            balanceCents: state.liabilityBalances.get(c.id) ?? 0,
            creditLimitCents: c.creditLimitCents,
            liquid: false as const,
            credit: true as const,
          })),
      ];
      const treatment: FundingTreatment =
        obligation.treatment === "expense" ? "expense" : "asset-acquisition";
      const fundingFailure = classifyFundingFailure({
        treatment,
        requiredCents: obligation.amountCents,
        selectedSourceIds: orderedAccountIds,
        selectedSourcesAvailableCents: obligation.amountCents - shortfallCents,
        selectedSourcesTaxCents: perSource.reduce((sum, s) => sum + s.taxCents, 0),
        accounts: accountPool,
        jurisdiction,
        ctx,
        taxableByOwner: working,
      });
      block = {
        obligation,
        requiredCents: obligation.amountCents,
        availableCents: obligation.amountCents - shortfallCents,
        shortfallCents,
        fundingFailure,
      };
      // Every draw from here on is omitted, not just this one: none of their money moves, so none
      // of their events may originate an artifact. Reported as a set separate from `block`, which
      // stays the single first shortfall — the later draws were never priced, so they have no
      // shortfall of their own to state, and calling them independently unfundable would be a
      // claim this function did not test.
      for (const omitted of draws.slice(index)) {
        if (omitted.sourceEventId !== undefined) omittedSourceEventIds.add(omitted.sourceEventId);
      }
      break;
    }
    // Fundable: commit the probe's taxable base, then apply the balance moves.
    for (const [ownerId, byCategory] of probe) working.set(ownerId, byCategory);
    // Attribution mirrors the money exactly: each source (a zero-gross one touched nothing) becomes
    // one record source — an account carrying its withdrawal breakdown, a credit borrow carrying its
    // `kind` and amount alone — and Σ net delivered is the obligation's funded amount. Recorded off
    // the same `perSource` the balance moves below read, so the record and the ledger cannot diverge.
    resolvedFunding.push(
      attributeExplicitObligation(
        obligation,
        perSource
          .filter((s) => s.grossCents > 0)
          .map((s) => ({
            kind: s.kind,
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

      // A credit borrow raises the card's owed balance by the amount drawn. No asset is sold, so
      // no basis moves, nothing surfaces as a savings drawdown, and it books no gain or tax band —
      // the debt increase IS the funding, and the card's normal interest/payment mechanics then
      // carry the new balance forward through `advanceLiabilities`.
      if (s.kind === "credit") {
        state.liabilityBalances.set(s.id, (state.liabilityBalances.get(s.id) ?? 0) + s.grossCents);
        continue;
      }

      state.assetBalances.set(s.id, (state.assetBalances.get(s.id) ?? 0) - s.grossCents);
      state.basisByAccount.set(
        s.id,
        Math.max(0, (state.basisByAccount.get(s.id) ?? 0) - s.principalCents),
      );
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
    omittedSourceEventIds,
  };
}
