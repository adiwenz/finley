/**
 * addEvent — the safe, base-aware way to grow the ledger; the write-path twin of
 * `removeEvent`.
 *
 * `addEvent`/`validateNewEvent` validate a candidate's own fields and its preconditions
 * against the interpreted state before appending. Unlike the pure interpret path, they can
 * run *affordability* preconditions needing a projection (the down-payment block reads
 * projected liquid balances). That projection is why they live here: this module sits above
 * the projection layer, keeping `interpret.ts` free of any projection dependency.
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
 *   holds at that month (WHICH MAY BE NOTHING), largest first. Only liquid accounts qualify:
 *   a cash goal fund included, retirement excluded, credit never (a liability, not an asset),
 *   so "credit is not a funding source" holds by construction. Membership is a property of the
 *   ACCOUNT, not the month — only `balanceCents` varies, so an emptied account goes to $0
 *   rather than disappearing between months.
 * - `availabilityAt(sourceIds, amountCents, month)` — the VERDICT for a chosen selection.
 *
 * Both read the same projected `balanceCents`, so a picker and a gate can never tell the user
 * different stories; the only gap is the tax, which the verdict reports separately (`taxed`).
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
 * SELECTED sources (in drain order), the amount, and the month, it runs the SAME ordered
 * gross-up the simulator uses ({@link resolveOrderedFundingDraw}) against the projected month
 * state — each source grossed up over the capital-gains tax its sale induces, differenced
 * marginally over the owner's projected other income that month PLUS any draw already authored
 * at that month (`flows.taxableByOwnerAfterFundingCents`) — and reports whether the net covers
 * the amount. Same resolution as the sim, so the gate blocks exactly when the sim would fall
 * short, under any tax regime.
 *
 * It is a question about a {@link import("./transfers").FundingDraw}, not about any one event:
 * the Home Purchase §4.5 gate asks it of a down payment, One-Time Spend of a spend, both get
 * the identical answer. Only liquid accounts fund a draw (cash goal funds included; credit
 * never, being a liability), so a selected id that is not a positive-balance liquid account
 * contributes 0 yet is still named at balance 0. The month is clamped into the horizon.
 * Balances are positive-only and still faithful to the full liquid position: the cascade
 * floors the liquid sink to zero before each snapshot and every other account is drawn through
 * `Math.max(0, …)` guards, so there is no hidden negative.
 *
 * Exported because the authoring UI must get the same answers the gate does: the down-payment
 * picker lists `sourcesAt(month)` and previews the block with `availabilityAt(...)`, so what
 * it shows IS what `addEvent` will decide.
 */
export function fundingLookup(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction = nullJurisdiction,
): FundingLookup {
  const startYear = base.startYear ?? DEFAULT_START_YEAR;
  // Label and withdrawal category of each LIQUID account. The label names a counted source,
  // falling back to the id — `||`, not `??`, so an empty-string label falls back too rather
  // than printing a nameless "()". The category prices each sale's tax under its own
  // provenance (tax-exempt cash reserve untaxed; a taxable brokerage bears its gain).
  const liquidAccounts = (base.initialAccounts ?? []).filter((a) => a.liquid);
  const labelById = new Map(liquidAccounts.map((a) => [a.id, a.label || a.id]));
  const ownerById = new Map(liquidAccounts.map((a) => [a.id, a.ownerId]));
  const categoryById = new Map(liquidAccounts.map((a) => [a.id, a.taxProfile.withdrawalCategory]));
  const projection = buildProjection(interpretLedger(ledger, base), base, jurisdiction);
  const last = projection.months.length - 1;
  const monthAt = (month: number) => projection.months[Math.max(0, Math.min(month, last))];

  // EVERY liquid account with what it holds at the month, largest first — a stable default
  // drain order for a picker (biggest bucket first), which the user then reorders. An empty
  // account is listed at $0 rather than omitted so membership does not shift as the month
  // moves: a picker can grey it out instead of having it vanish while an id the user chose
  // earlier stays selected behind the scenes. Whether a listed account can actually pay is
  // `balanceCents > 0`, the same test `availabilityAt` applies below.
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
    // The owner's projected taxable base for this month with any already-authored draw
    // stacked in — the marginal context the sale's tax is differenced over, and the map the
    // sim exposed from this same projection. A candidate appended now is last in ledger
    // order, so the sim resolves it against exactly this base.
    const taxableByOwner: TaxableByOwner = new Map();
    const baseRecord = m?.flows?.taxableByOwnerAfterFundingCents ?? {};
    for (const [ownerId, byCategory] of Object.entries(baseRecord)) {
      taxableByOwner.set(ownerId, { ...(byCategory as TaxableByCategory) });
    }

    // Name every selected source (balance 0 if not a positive-balance liquid account), but
    // fund only from those that genuinely can.
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
    // Tax actually induced, summed over the sources touched — NOT inferred from "delivered
    // less than the sources hold", true of any draw smaller than its sources and so would
    // call an untaxed cash draw taxed.
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
 * The add-event replay context: base facts plus `fundingAvailabilityAt` (can these sources net
 * this amount at this month, after tax?), from one projection of the pre-candidate ledger.
 * Every money-out event's affordability gate fires only through this.
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
 * Validate a would-be appended event against the current ledger+base: its own fields, then its
 * preconditions against the replayed state (including the affordability gate, evaluated with
 * `jurisdiction`). A standalone pre-check; {@link addEvent} runs it before appending.
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
 * Grow the ledger — symmetric with `removeEvent`. On success appends the event stamped with
 * the next sequence number; on failure returns the conflict and leaves the ledger untouched.
 * `jurisdiction` feeds the affordability projection, defaulting to the null jurisdiction so
 * existing callers stay source-compatible.
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
