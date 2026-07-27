/**
 * addEvent — the safe, base-aware way to grow the ledger; the write-path
 * twin of `removeEvent`.
 *
 * `addEvent`/`validateNewEvent` validate a candidate event's own fields and its
 * preconditions against the interpreted state before appending it. Unlike the
 * pure interpret path, this can also run *affordability* preconditions that need
 * a projection — a money-out event's hard block reads projected liquid balances
 * (the down-payment block today). That projection is why these live here rather
 * than in `interpret.ts`:
 * this module sits above the projection layer (it imports {@link buildProjection}),
 * keeping `interpret.ts` free of any projection dependency.
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
  type FundingSourceState,
  type TaxableByOwner,
  type TaxableByCategory,
} from "../projection/fundingDrawStep";
import { nullJurisdiction, type Jurisdiction, type JurisdictionContext } from "../jurisdiction";

// The projection's default start year (simulate.ts / report.ts hold the same local
// constant): only bracket indexing reads it, so an off-by-a-year here is immaterial.
const DEFAULT_START_YEAR = 2026;

/**
 * The two funding questions an authoring surface asks of the ledger *so far*, both answered
 * from ONE projection so a caller pays for it once:
 *
 * - `sourcesAt(month)` — the POOL: every account that could ever fund a draw, with what it
 *   holds at that month — WHICH MAY BE NOTHING — largest first. What a source picker lists
 *   (#156) and what a conflict message can name. Only liquid accounts qualify — a cash goal
 *   fund included (its whole purpose is to be reachable), retirement excluded (#125), credit
 *   never, being a liability rather than an asset — so "credit is not a funding source" holds
 *   by construction. Membership is a property of the ACCOUNT, not of the month: what varies
 *   with the month is only `balanceCents`, so a caller comparing two months sees an emptied
 *   account go to $0 rather than disappear.
 * - `availabilityAt(sourceIds, amountCents, month)` — the VERDICT for a chosen selection.
 *
 * The two agree by construction on what a source holds: the pool's `balanceCents` and the
 * verdict's are the same projected number, so a picker that shows $60,500 and a gate that
 * blocks against it can never be telling the user different stories — the gap between them is
 * only ever the tax, which the verdict reports separately (`taxed`).
 */
export interface FundingLookup {
  readonly sourcesAt: (month: number) => readonly FundingSourceBalance[];
  readonly availabilityAt: (
    sourceIds: readonly string[],
    amountCents: number,
    month: number,
  ) => FundingAvailability;
}

/**
 * The funding-availability check for the ledger *so far*, from one projection. Given the
 * SELECTED sources (in drain order), the amount wanted, and the month, it runs the SAME
 * ordered gross-up the simulator uses ({@link resolveOrderedFundingDraw}) against the
 * projected month state — draining each source, grossed up over the capital-gains tax the
 * sale induces (differenced marginally over the owner's projected other income that month
 * PLUS any draw already authored at that month, from `flows.taxableByOwnerAfterFundingCents`)
 * — and reports whether the net covers the amount. Because
 * it is the SAME resolution the sim runs, a gate built on it blocks exactly when the sim
 * would fall short, under any tax regime.
 *
 * It is a question about a {@link import("./transfers").FundingDraw}, not about any one
 * event: the Home Purchase §4.5 gate asks it of a down payment, One-Time Spend (#154) will
 * ask it of a spend, and both get the identical answer from this one lookup. Only liquid
 * accounts fund a draw (a cash goal fund included; credit never, being a liability), so a
 * selected id that is not a positive-balance liquid account contributes 0 to the draw yet is
 * still named (at balance 0) in the returned sources. The month is clamped into the horizon.
 * Balances are positive-only — faithful to the full liquid position, because the cascade
 * floors the liquid sink to zero before each snapshot and every other account is drawn only
 * through `Math.max(0, …)` guards, so no hidden negative to reconcile.
 *
 * Exported because the authoring UI asks the same questions the gate does, and must get the
 * same answers: the down-payment picker lists `sourcesAt(month)` and previews the block with
 * `availabilityAt(...)`, so what it shows IS what `addEvent` will decide.
 */
export function fundingLookup(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction = nullJurisdiction,
): FundingLookup {
  const startYear = base.startYear ?? DEFAULT_START_YEAR;
  // Label and withdrawal category of each LIQUID account: the label names a counted source
  // ("Emergency fund", falling back to the id — `||`, not `??`, so an empty-string label
  // falls back too rather than a nameless "()"); the category prices each sale's tax under
  // its own provenance (a tax-exempt cash reserve untaxed; a taxable brokerage bears its gain).
  const liquidAccounts = (base.initialAccounts ?? []).filter((a) => a.liquid);
  const labelById = new Map(liquidAccounts.map((a) => [a.id, a.label || a.id]));
  const ownerById = new Map(liquidAccounts.map((a) => [a.id, a.ownerId]));
  const categoryById = new Map(liquidAccounts.map((a) => [a.id, a.taxProfile.withdrawalCategory]));
  const projection = buildProjection(interpretLedger(ledger, base), base, jurisdiction);
  const last = projection.months.length - 1;
  const monthAt = (month: number) => projection.months[Math.max(0, Math.min(month, last))];

  // The pool: EVERY liquid account, carrying what it holds at the month, largest first — a
  // stable, sensible default drain order for a picker (spend the biggest bucket first), which
  // the user then reorders by choosing. An empty account is listed at $0 rather than omitted,
  // so the pool's membership does not shift under a caller as the month moves: a picker can
  // then show an account that has emptied — greyed out and unpickable — instead of having it
  // silently vanish while an id the user chose earlier is still selected behind the scenes.
  // Whether a listed account can actually pay is `balanceCents > 0`, the same test
  // `availabilityAt` applies below.
  const sourcesAt = (month: number): readonly FundingSourceBalance[] => {
    const m = monthAt(month);
    const pool: FundingSourceBalance[] = [];
    for (const [id, label] of labelById) {
      pool.push({ id, label, balanceCents: (m?.accountBalancesCents[id] ?? 0) as number });
    }
    return pool.sort((a, b) => b.balanceCents - a.balanceCents);
  };

  const availabilityAt = (
    sourceIds: readonly string[],
    amountCents: number,
    month: number,
  ): FundingAvailability => {
    const m = monthAt(month);
    const ctx: JurisdictionContext = { year: startYear + Math.floor(Math.max(0, month) / 12) };
    // The owner's projected taxable base for this month WITH any already-authored draw at
    // this month stacked in — the marginal context the sale's tax is differenced over, and
    // the very map the sim exposed from this same projection. A candidate appended now is
    // last in ledger order, so the sim will resolve it against exactly this base.
    const taxableByOwner: TaxableByOwner = new Map();
    const baseRecord = m?.flows?.taxableByOwnerAfterFundingCents ?? {};
    for (const [ownerId, byCategory] of Object.entries(baseRecord)) {
      taxableByOwner.set(ownerId, { ...(byCategory as TaxableByCategory) });
    }

    // The selected sources in drain order: name every one (balance 0 if not a liquid,
    // positive-balance account), but only fund the draw from those that genuinely can.
    const named: FundingSourceBalance[] = [];
    const fundingSources: FundingSourceState[] = [];
    for (const id of sourceIds) {
      const label = labelById.get(id) ?? id;
      const balance = (m?.accountBalancesCents[id] ?? 0) as number;
      const isLiquidBucket = labelById.has(id) && balance > 0;
      named.push({ id, label, balanceCents: isLiquidBucket ? balance : 0 });
      if (isLiquidBucket) {
        fundingSources.push({
          id,
          ownerId: ownerById.get(id) ?? "",
          category: categoryById.get(id) ?? "capitalGains",
          balanceCents: balance,
          basisCents: (m?.accountBasisCents[id] ?? 0) as number,
          label,
        });
      }
    }

    const { perSource, netDeliveredCents, shortfallCents } = resolveOrderedFundingDraw(
      amountCents,
      fundingSources,
      jurisdiction,
      ctx,
      taxableByOwner,
    );
    // The tax actually induced, summed over the sources this draw touched — NOT inferred from
    // "delivered less than the sources hold", which is true of any draw smaller than its
    // sources and would call an untaxed cash draw taxed.
    const taxCents = perSource.reduce((sum, s) => sum + s.taxCents, 0);
    return {
      shortfallCents,
      availableCents: netDeliveredCents,
      taxCents,
      taxed: taxCents > 0,
      sources: named,
    };
  };

  return { sourcesAt, availabilityAt };
}

/**
 * The add-event replay context: the base facts plus the `fundingAvailabilityAt` capability
 * (can these sources net this amount at this month, after tax?), from one projection of the
 * ledger so far (the pre-candidate state). Every money-out event's affordability gate — the
 * §4.5 down-payment block today, One-Time Spend next — fires only through this.
 */
function addEventContext(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): InterpretContext {
  return {
    ...contextFrom(base),
    fundingAvailabilityAt: fundingLookup(ledger, base, jurisdiction).availabilityAt,
  };
}

/**
 * Validate a would-be appended event against the current ledger+base: its own
 * fields, then its preconditions relative to the replayed state (including the
 * affordability gate, evaluated with `jurisdiction`). A standalone
 * pre-check; {@link addEvent} runs this internally before appending.
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

/** Success carries the grown ledger; failure carries a human-readable conflict. */
export type AddResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

/**
 * The safe, base-aware way to grow the ledger — symmetric with `removeEvent`.
 * Validates the event's own fields and its preconditions against the replayed
 * state; on success appends it (stamped with the next sequence number), on
 * failure returns the conflict and leaves the ledger untouched. `jurisdiction`
 * feeds the affordability projection; it defaults to the null jurisdiction
 * so existing callers stay source-compatible.
 */
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
