/**
 * Unlike the pure interpret path, validators here run *affordability* preconditions needing
 * a projection (the down-payment block reads projected liquid balances) — which is why they
 * sit above the projection layer, keeping `interpret.ts` projection-free.
 */

import type { Ledger, ValidationResult } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { checkEvent } from "./eventHandlers";
import { validateEventData } from "./eventValidation";
import { contextFrom, interpretLedger, interpretToState, sortedEvents } from "./interpret";
import type { InterpretContext, FundingAvailability, FundingSourceBalance } from "./interpretState";
import type { LedgerBaseConfig } from "./ledgerBase";
import { buildProjection } from "../projection/buildHouseholdInput";
import {
  resolveOrderedFundingDraw,
  type CreditFundingSource,
  type FundingSourceState,
  type TaxableByOwner,
  type TaxableByCategory,
} from "../projection/fundingDrawStep";
import { classifyFundingFailure, type EligibleAccountState, type FundingFailure } from "../projection/fundingFailure";
import type { FundingTreatment } from "../projection/fundingEligibility";
import { nullJurisdiction, type Jurisdiction, type JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { HouseholdLiability } from "./household";
import { isPreExisting } from "../projection/nowMarker";

// simulate.ts / report.ts hold the same local constant. Only bracket indexing reads it, so
// an off-by-a-year is immaterial.
const DEFAULT_START_YEAR = 2026;

/**
 * Two funding questions about the ledger *so far*, answered from ONE projection: `sourcesAt`
 * gives the POOL, `availabilityAt` the VERDICT for a selection. Both read the same projected
 * `balanceCents`, so a picker and a gate can never tell the user different stories; the only
 * gap is tax, which the verdict reports separately (`taxed`).
 *
 * The pool is every liquid account that could fund a draw (cash goal fund included,
 * retirement excluded, credit never — a liability, not an asset), largest first. Membership
 * is a property of the ACCOUNT, not the month, so an emptied account is listed at $0.
 */
export interface FundingLookup {
  /**
   * The pool at `treatment`'s eligibility — liquid accounts always, plus every credit card the
   * household has taken when `treatment` is `"expense"` ({@link getEligibleFundingSources}'s own
   * rule: an expense admits credit, an asset acquisition never does). Defaults to
   * `"asset-acquisition"`, the pool Home Purchase's down payment has always seen, so an existing
   * caller passing one argument is unaffected.
   */
  readonly sourcesAt: (
    month: number,
    treatment?: FundingTreatment,
  ) => readonly FundingSourceBalance[];
  readonly availabilityAt: (
    sourceIds: readonly string[],
    amountCents: number,
    month: number,
  ) => FundingAvailability;
  /**
   * Why the selected sources would fall short, classified against the WHOLE eligible pool —
   * `funding-configuration` when eligible money exists elsewhere, `no-eligible-source-suffices`
   * when it doesn't. Built over the exact same {@link resolveOrderedFundingDraw} pricing as
   * `availabilityAt` (its `selectedSources*Cents` are that call's own figures, not recomputed),
   * so the gate and the classifier can never disagree about what the selection delivers.
   */
  readonly failureAt: (
    treatment: FundingTreatment,
    sourceIds: readonly string[],
    amountCents: number,
    month: number,
  ) => FundingFailure;
}

/**
 * The ledger as it stood immediately BEFORE `eventId` — every event that precedes it in
 * interpretation order (month ASC, sequenceNumber ASC, {@link sortedEvents}'s own order), minus
 * the event itself, minus everything that comes after it (a later-month event, or a same-month
 * sibling authored after it). This is the "so far" a candidate priced AT that event's own
 * position sees: exactly what {@link addEvent} already gives a brand-new event (appended last,
 * so everything precedes it), generalized to a position INSIDE an existing ledger.
 *
 * The one seam both `updateEvent`'s revise-time affordability gate and the authoring picker's
 * "editing an existing spend" read use to price a candidate at its own sequence position rather
 * than at the ledger's end — a same-month sibling authored AFTER it must never count as
 * already-spent money it competes with, and one authored BEFORE it always must.
 *
 * `eventId` not found (should not happen for an existing event a caller resolved first) falls
 * back to the whole ledger, matching `fundingLookup`'s own plain behavior.
 */
export function ledgerBeforeEvent(ledger: Ledger, eventId: string): Ledger {
  const ordered = sortedEvents(ledger.events);
  const idx = ordered.findIndex((e) => e.id === eventId);
  return {
    events: idx === -1 ? ordered : ordered.slice(0, idx),
    nextSequenceNumber: ledger.nextSequenceNumber,
  };
}

/**
 * The funding-availability check for the ledger *so far*, from one projection. Each source is
 * grossed up over the capital-gains tax its sale induces by the SAME ordered resolution the
 * simulator uses ({@link resolveOrderedFundingDraw}), differenced marginally over the owner's
 * projected other income that month PLUS any draw already authored there
 * (`flows.taxableByOwnerAfterFundingCents`) — so the gate blocks exactly when the sim would
 * fall short.
 *
 * Event-neutral, a question about an ordered cross-account draw: the Home Purchase §4.5
 * down-payment gate and One-Time Spend get the identical answer. The month is
 * clamped into the horizon. Balances are positive-only: the cascade floors the liquid sink to
 * zero before each snapshot and every other account is drawn through `Math.max(0, …)` guards.
 */
export function fundingLookup(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction = nullJurisdiction,
): FundingLookup {
  const startYear = base.startYear ?? DEFAULT_START_YEAR;
  // `||`, not `??`, so an empty-string label falls back to the id too. The category prices
  // each sale's tax under its own provenance (a tax-exempt cash reserve untaxed; a taxable
  // brokerage bears its gain).
  const liquidAccounts = (base.initialAccounts ?? []).map((a) => a.sim).filter((a) => a.liquid);
  const labelById = new Map(liquidAccounts.map((a) => [a.id, a.label || a.id]));
  const ownerById = new Map(liquidAccounts.map((a) => [a.id, a.ownerId]));
  const categoryById = new Map(liquidAccounts.map((a) => [a.id, a.taxProfile.withdrawalCategory]));
  const household = interpretLedger(ledger, base);
  // A card the household has already taken (via a LoanEvent), keyed for the credit-aware source
  // resolution below. Its `creditLimitCents` is authored, never `null` — a null limit (zero usable
  // headroom) can only arise from the primitive's own defensive default, never from data this seam
  // produces.
  const cardById = new Map<string, Extract<HouseholdLiability, { kind: "creditCard" }>>(
    household.liabilities
      .filter((l): l is Extract<HouseholdLiability, { kind: "creditCard" }> => l.kind === "creditCard")
      .map((c) => [c.id, c]),
  );
  const projection = buildProjection(household, base, jurisdiction);
  const last = projection.months.length - 1;

  /**
   * Month 0's already-authored explicit draws (another One-Time Spend, a down payment), replayed
   * against the opening balances through the SAME primitive the simulator resolves them with
   * ({@link resolveOrderedFundingDraw}), in ledger order — nothing else about month 0 (growth,
   * the automatic waterfall, a card's own interest/minimum-payment mechanics, decumulation) runs.
   * A household with no month-0 explicit draws gets back `opening`'s own figures untouched, so
   * every existing month-0 read (a card's pre-mechanics headroom, among others) is unaffected; one
   * WITH a prior spend sees its sources already reduced by it — the seam a second month-0 draw
   * must be priced against, matching exactly what the simulator would apply were this candidate
   * the one being resolved. Bug this fixes: month 0 was treated as pre-existing (`<= 0`) and so
   * NEVER reflected any of its own draws — the same `<= 0` vs `< 0` drift {@link isPreExisting}'s
   * own doc comment warns about, here for a different symptom (a second month-0 spend always
   * seeing the original balance) rather than free equity.
   */
  function openingAfterMonth0Draws() {
    const accountBalancesCents: Record<string, number> = { ...projection.opening.accountBalancesCents };
    const accountBasisCents: Record<string, number> = { ...projection.opening.accountBasisCents };
    const liabilityBalancesCents: Record<string, number> = { ...projection.opening.liabilityBalancesCents };
    const ctx0: JurisdictionContext = { year: startYear };
    const taxableByOwner: TaxableByOwner = new Map();

    const month0Draws = household.fundingDraws.filter(
      (o) => o.month === 0 && o.funding.kind === "explicit",
    );
    for (const obligation of month0Draws) {
      if (obligation.funding.kind !== "explicit") continue;
      const sources: FundingSourceState[] = [];
      for (const id of obligation.funding.orderedAccountIds) {
        const card = cardById.get(id);
        if (card !== undefined) {
          sources.push({
            kind: "credit",
            id,
            ownerId: card.ownerId,
            balanceCents: liabilityBalancesCents[id] ?? 0,
            creditLimitCents: card.creditLimitCents,
            label: id,
          });
          continue;
        }
        if (!labelById.has(id)) continue;
        sources.push({
          id,
          ownerId: ownerById.get(id) ?? "",
          category: categoryById.get(id) ?? "capitalGains",
          balanceCents: accountBalancesCents[id] ?? 0,
          basisCents: accountBasisCents[id] ?? 0,
          label: labelById.get(id) ?? id,
        });
      }
      // Mutates `taxableByOwner` in place — exactly what threads a second month-0 draw's gain
      // marginally atop the first's, the same stacking `resolveFundingDraws` applies within a
      // real month.
      const { perSource } = resolveOrderedFundingDraw(
        obligation.amountCents,
        sources,
        jurisdiction,
        ctx0,
        taxableByOwner,
      );
      for (const s of perSource) {
        if (s.grossCents <= 0) continue;
        if (s.kind === "credit") {
          liabilityBalancesCents[s.id] = (liabilityBalancesCents[s.id] ?? 0) + s.grossCents;
          continue;
        }
        accountBalancesCents[s.id] = (accountBalancesCents[s.id] ?? 0) - s.grossCents;
        accountBasisCents[s.id] = Math.max(0, (accountBasisCents[s.id] ?? 0) - s.principalCents);
      }
    }
    return { accountBalancesCents, accountBasisCents, liabilityBalancesCents };
  }
  const adjustedOpening = openingAfterMonth0Draws();

  const monthAt = (month: number) => {
    if (isPreExisting(month)) return projection.opening;
    if (month === 0) return { ...projection.opening, ...adjustedOpening };
    return projection.months[Math.min(month, last)];
  };

  // Whether a listed account can pay is `balanceCents > 0`, the test `availabilityAt` applies.
  const sourcesAt = (
    month: number,
    treatment: FundingTreatment = "asset-acquisition",
  ): readonly FundingSourceBalance[] => {
    const m = monthAt(month);
    const pool: FundingSourceBalance[] = [];
    for (const [id, label] of labelById) {
      pool.push({ id, label, balanceCents: (m?.accountBalancesCents[id] ?? 0) as number });
    }
    // Credit joins the pool only for an `expense` — {@link getEligibleFundingSources}'s own rule
    // (an asset acquisition never admits it), applied here by simply never pushing a card
    // outside that branch rather than filtering after the fact.
    if (treatment === "expense") {
      for (const card of cardById.values()) {
        const owed = (m?.liabilityBalancesCents[card.id] ?? 0) as number;
        pool.push({
          id: card.id,
          label: card.id,
          balanceCents: Math.max(0, card.creditLimitCents - owed),
          kind: "credit",
          limited: true,
        });
      }
    }
    return pool.sort((a, b) => b.balanceCents - a.balanceCents);
  };

  // Balance, basis, and jurisdiction context at the seam a candidate draw resolves against —
  // after this month's explicit draws, before decumulation. Since the reorder, decumulation
  // runs AFTER the candidate, so its end-of-month drain must not count against the candidate's
  // sources; the flow view exports the pre-decumulation figures for exactly this read. The
  // `opening` snapshot (a genuinely pre-existing month, `< 0`) carries no flows and already
  // holds pre-decumulation balances, so it falls back to the end-of-month maps — which for the
  // opening snapshot ARE the starting balances. Shared by `availabilityAt` and `failureAt` so
  // both price a draw over identically the same seam.
  const contextAt = (month: number) => {
    const m = monthAt(month);
    const ctx: JurisdictionContext = { year: startYear + Math.floor(Math.max(0, month) / 12) };
    // A candidate appended now is last in ledger order, so the sim resolves it against
    // exactly this base.
    const taxableByOwner: TaxableByOwner = new Map();
    const baseRecord = m?.flows?.taxableByOwnerAfterFundingCents ?? {};
    for (const [ownerId, byCategory] of Object.entries(baseRecord)) {
      taxableByOwner.set(ownerId, { ...(byCategory as TaxableByCategory) });
    }
    const balanceOf = (id: string): number =>
      (m?.flows?.accountBalancesAfterFundingCents?.[id] ?? m?.accountBalancesCents[id] ?? 0) as number;
    const basisOf = (id: string): number =>
      (m?.flows?.accountBasisAfterFundingCents?.[id] ?? m?.accountBasisCents[id] ?? 0) as number;
    // No later step within a month re-touches a card's balance the way decumulation re-touches an
    // account's (the funding draw is the last thing to move it), so — unlike accounts — the plain
    // end-of-month figure already reflects every draw resolved so far this month.
    const liabilityBalanceOf = (id: string): number => (m?.liabilityBalancesCents[id] ?? 0) as number;
    return { ctx, taxableByOwner, balanceOf, basisOf, liabilityBalanceOf };
  };

  /**
   * The selected sources as `resolveOrderedFundingDraw` reads them, at `month`'s seam. An id naming
   * a card the household has taken resolves to its remaining headroom (`limit − owed`), the SAME
   * primitive the simulator borrows against — a mixed `[checking, visa]` list here and in
   * `resolveFundingDraws` price identically, so the gate and the sim can never disagree about what
   * an explicitly-named card delivers.
   */
  const selectedSources = (
    sourceIds: readonly string[],
    balanceOf: (id: string) => number,
    basisOf: (id: string) => number,
    liabilityBalanceOf: (id: string) => number,
  ) => {
    const named: FundingSourceBalance[] = [];
    const fundingSources: FundingSourceState[] = [];
    for (const id of sourceIds) {
      const card = cardById.get(id);
      if (card !== undefined) {
        const owed = liabilityBalanceOf(id);
        const headroom = Math.max(0, card.creditLimitCents - owed);
        named.push({ id, label: id, balanceCents: headroom, kind: "credit", limited: true });
        if (headroom > 0) {
          const source: CreditFundingSource = {
            kind: "credit",
            id,
            ownerId: card.ownerId,
            balanceCents: owed,
            creditLimitCents: card.creditLimitCents,
            label: id,
          };
          fundingSources.push(source);
        }
        continue;
      }
      const label = labelById.get(id) ?? id;
      const balance = balanceOf(id);
      const isLiquidBucket = labelById.has(id) && balance > 0;
      named.push({ id, label, balanceCents: isLiquidBucket ? balance : 0 });
      if (isLiquidBucket) {
        fundingSources.push({
          id,
          ownerId: ownerById.get(id) ?? "",
          category: categoryById.get(id) ?? "capitalGains",
          balanceCents: balance,
          basisCents: basisOf(id),
          label,
        });
      }
    }
    return { named, fundingSources };
  };

  const availabilityAt = (
    sourceIds: readonly string[],
    amountCents: number,
    month: number,
  ): FundingAvailability => {
    const { ctx, taxableByOwner, balanceOf, basisOf, liabilityBalanceOf } = contextAt(month);
    const { named, fundingSources } = selectedSources(sourceIds, balanceOf, basisOf, liabilityBalanceOf);

    const { perSource, netDeliveredCents, shortfallCents } = resolveOrderedFundingDraw(
      amountCents,
      fundingSources,
      jurisdiction,
      ctx,
      taxableByOwner,
    );
    // Summed over the sources touched, NOT inferred from "delivered less than the sources
    // hold" — that holds for any draw smaller than its sources, and would call an untaxed
    // cash draw taxed.
    const taxCents = perSource.reduce((sum, s) => sum + s.taxCents, 0);
    return {
      shortfallCents,
      availableCents: netDeliveredCents,
      taxCents,
      taxed: taxCents > 0,
      sources: named,
    };
  };

  const failureAt = (
    treatment: FundingTreatment,
    sourceIds: readonly string[],
    amountCents: number,
    month: number,
  ): FundingFailure => {
    const { ctx, taxableByOwner, balanceOf, basisOf, liabilityBalanceOf } = contextAt(month);
    const { named, fundingSources } = selectedSources(sourceIds, balanceOf, basisOf, liabilityBalanceOf);

    // Price the selection over a COPY: the classifier below prices its own probes (the whole
    // eligible pool, then each alternative) over the UNMUTATED base, mirroring how a blocked
    // draw's own gains never stack (`resolveFundingDraws`) — the selection failed, so nothing
    // it would have sold is booked.
    const probe: TaxableByOwner = new Map();
    for (const [ownerId, byCategory] of taxableByOwner) probe.set(ownerId, { ...byCategory });
    const selected = resolveOrderedFundingDraw(amountCents, fundingSources, jurisdiction, ctx, probe);
    const selectedTaxCents = selected.perSource.reduce((sum, s) => sum + s.taxCents, 0);

    // The whole eligible pool the classifier weighs alternatives against — liquid accounts plus
    // every card the household has taken, mirroring `resolveFundingDraws`' own block-time pool so
    // an "unselected card could cover this" advisory reads the same from the gate as from a
    // blocked simulation. `getEligibleFundingSources` (inside the classifier) is what keeps a card
    // out of an `asset-acquisition`'s alternatives — the pool itself carries both.
    const accounts: EligibleAccountState[] = [
      ...liquidAccounts.map((a) => ({
        id: a.id,
        ownerId: a.ownerId,
        category: a.taxProfile.withdrawalCategory,
        balanceCents: balanceOf(a.id),
        basisCents: basisOf(a.id),
        label: labelById.get(a.id) ?? a.id,
        liquid: true,
      })),
      ...[...cardById.values()].map((c) => ({
        kind: "credit" as const,
        id: c.id,
        ownerId: c.ownerId,
        balanceCents: liabilityBalanceOf(c.id),
        creditLimitCents: c.creditLimitCents,
        label: c.id,
        liquid: false as const,
        credit: true as const,
      })),
    ];

    return classifyFundingFailure({
      treatment,
      requiredCents: amountCents,
      selectedSourceIds: sourceIds,
      selectedSourcesAvailableCents: selected.netDeliveredCents,
      selectedSourcesTaxCents: selectedTaxCents,
      selectedSources: named.map((n) => ({
        accountId: n.id,
        label: n.label,
        kind: n.kind === "credit" ? ("credit" as const) : ("account" as const),
        availableCents: n.balanceCents,
      })),
      accounts,
      jurisdiction,
      ctx,
      taxableByOwner,
    });
  };

  return { sourcesAt, availabilityAt, failureAt };
}

/**
 * Base facts plus the funding-availability gate and classifier, from ONE projection of the
 * pre-candidate ledger — `homePurchase.check` reads both to refuse an unaffordable down payment
 * and explain why.
 */
function addEventContext(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): InterpretContext {
  const funding = fundingLookup(ledger, base, jurisdiction);
  return {
    ...contextFrom(base),
    fundingAvailabilityAt: funding.availabilityAt,
    fundingFailureAt: funding.failureAt,
    fundingSourcesAt: funding.sourcesAt,
  };
}

/**
 * Its own fields first, then its preconditions against the replayed state (including the
 * affordability gate). A standalone pre-check; {@link addEvent} runs it before appending.
 */
export function validateNewEvent(
  ledger: Ledger,
  base: LedgerBaseConfig,
  event: NewLifeEvent,
  jurisdiction: Jurisdiction = nullJurisdiction,
): ValidationResult {
  const data = validateEventData(event);
  if (!data.ok) return data;
  const stamped = { ...event, sequenceNumber: ledger.nextSequenceNumber } as LifeEvent;
  return checkEvent(
    stamped,
    interpretToState(ledger, base),
    addEventContext(ledger, base, jurisdiction),
  );
}

export type AddResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

/** On failure the ledger is left untouched. `jurisdiction` feeds the affordability projection. */
export function addEvent(
  ledger: Ledger,
  base: LedgerBaseConfig,
  event: NewLifeEvent,
  jurisdiction: Jurisdiction = nullJurisdiction,
): AddResult {
  const check = validateNewEvent(ledger, base, event, jurisdiction);
  if (!check.ok) return { ok: false, conflict: check.reason };
  const stamped = { ...event, sequenceNumber: ledger.nextSequenceNumber } as LifeEvent;
  return {
    ok: true,
    ledger: {
      events: [...ledger.events, stamped],
      nextSequenceNumber: ledger.nextSequenceNumber + 1,
    },
  };
}
