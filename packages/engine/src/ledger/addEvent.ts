/**
 * Unlike the pure interpret path, validators here run *affordability* preconditions needing
 * a projection (the down-payment block reads projected liquid balances) — which is why they
 * sit above the projection layer, keeping `interpret.ts` projection-free.
 */

import type { Ledger, ValidationResult } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { checkEvent } from "./eventHandlers";
import { validateEventData } from "./eventValidation";
import { contextFrom, interpretLedger, interpretToState } from "./interpret";
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
import { getEligibleFundingSources, type FundingTreatment } from "../projection/fundingEligibility";
import { nullJurisdiction, type Jurisdiction, type JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { HouseholdLiability } from "./household";

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
  readonly sourcesAt: (month: number) => readonly FundingSourceBalance[];
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
  /**
   * The pool a PICKER offers for `treatment`: `sourcesAt`'s liquid accounts, plus — for
   * `"expense"` only — every credit card the household has already taken, at its remaining
   * headroom (`limit − owed`). `getEligibleFundingSources` is the single rule for which
   * treatment admits a card, so a picker offering a down payment (`"asset-acquisition"`) never
   * lists one, exactly as `availabilityAt`/`failureAt` never count one toward it.
   */
  readonly eligibleSourcesAt: (
    treatment: FundingTreatment,
    month: number,
  ) => readonly FundingSourceBalance[];
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
  // A Year-0 purchase draws against the funds on hand right now — the `opening` snapshot;
  // later months read that processed month's end-of-month balances, as before.
  const monthAt = (month: number) =>
    month <= 0 ? projection.opening : projection.months[Math.min(month, last)];

  // Whether a listed account can pay is `balanceCents > 0`, the test `availabilityAt` applies.
  const sourcesAt = (month: number): readonly FundingSourceBalance[] => {
    const m = monthAt(month);
    const pool: FundingSourceBalance[] = [];
    for (const [id, label] of labelById) {
      pool.push({ id, label, balanceCents: (m?.accountBalancesCents[id] ?? 0) as number });
    }
    return pool.sort((a, b) => b.balanceCents - a.balanceCents);
  };

  // Balance, basis, and jurisdiction context at the seam a candidate draw resolves against —
  // after this month's explicit draws, before decumulation. Since the reorder, decumulation
  // runs AFTER the candidate, so its end-of-month drain must not count against the candidate's
  // sources; the flow view exports the pre-decumulation figures for exactly this read. The
  // `opening` snapshot (month ≤ 0) carries no flows and already holds pre-decumulation
  // balances, so it falls back to the end-of-month maps — which for the opening snapshot ARE
  // the starting balances. Shared by `availabilityAt` and `failureAt` so both price a draw
  // over identically the same seam.
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
    const { fundingSources } = selectedSources(sourceIds, balanceOf, basisOf, liabilityBalanceOf);

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
      accounts,
      jurisdiction,
      ctx,
      taxableByOwner,
    });
  };

  const eligibleSourcesAt = (
    treatment: FundingTreatment,
    month: number,
  ): readonly FundingSourceBalance[] => {
    const { liabilityBalanceOf } = contextAt(month);
    const candidates: (FundingSourceBalance & { readonly liquid: boolean; readonly credit?: true })[] = [
      ...sourcesAt(month).map((a) => ({ ...a, liquid: true as const })),
      ...[...cardById.values()].map((card) => {
        const owed = liabilityBalanceOf(card.id);
        const headroom = Math.max(0, card.creditLimitCents - owed);
        return {
          id: card.id,
          label: card.id,
          balanceCents: headroom,
          kind: "credit" as const,
          limited: true,
          liquid: false as const,
          credit: true as const,
        };
      }),
    ];
    return getEligibleFundingSources(treatment, candidates);
  };

  return { sourcesAt, availabilityAt, failureAt, eligibleSourcesAt };
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
