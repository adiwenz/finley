/**
 * Replay — the one place event meaning becomes household state (§1).
 *
 * `replayHousehold` folds the ledger over the handler registry and returns an
 * immutable {@link ReplayedHousehold}. Both projection and snapshot consume
 * *that* object, so they can never interpret the ledger differently. Base
 * (value-editing surface) series are folded in here too, so they appear in the
 * projection and the snapshot identically.
 */

import type { Ledger, ValidationResult } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import { applyEvent, checkEvent } from "./eventHandlers";
import { validateEventData } from "./eventValidation";
import { asPersonId, asSeriesId, type AccountId } from "../ids";
import type { OwnedSeries } from "../projection/simulate";
import {
  freshState,
  materializeSeries,
  type HouseholdLiability,
  type HouseholdSeries,
  type LedgerBaseConfig,
  type ReplayContext,
  type ReplayState,
  type ReplayedHousehold,
} from "./replayState";

/** Replay order: (month ASC, sequenceNumber ASC) — producer-before-consumer (§5, §6). */
export function sortedEvents(events: readonly LifeEvent[]): LifeEvent[] {
  return [...events].sort(
    (a, b) => a.month - b.month || a.sequenceNumber - b.sequenceNumber,
  );
}

export function contextFrom(base: LedgerBaseConfig): ReplayContext {
  const accountIds = new Set<AccountId>();
  for (const acc of base.initialAccounts ?? []) accountIds.add(acc.id as AccountId);
  return { accountIds };
}

/** Seed the pre-event household from base config (durable persons present from the start). */
export function seedState(base: LedgerBaseConfig): ReplayState {
  const state = freshState();
  for (const person of base.initialPersons ?? []) {
    state.personsById.set(asPersonId(person.id), {
      person,
      startMonth: -Infinity,
      endMonth: null,
    });
  }
  return state;
}

/** Replay to the internal (mutable) state — shared by household build and undo. */
export function replayToState(ledger: Ledger, base: LedgerBaseConfig): ReplayState {
  const state = seedState(base);
  const context = contextFrom(base);
  for (const event of sortedEvents(ledger.events)) applyEvent(event, state, context);
  return state;
}

function baseSeries(
  os: OwnedSeries,
  seriesType: "income" | "expense",
  index: number,
): HouseholdSeries {
  return {
    id: asSeriesId(`base-${seriesType}-${index}`),
    ownerId: asPersonId(os.ownerId),
    seriesType,
    role: "base",
    causedByEventId: null,
    startMonth: os.series.startMonth,
    endMonth: os.series.endMonth ?? null,
    series: os.series,
  };
}

function toHousehold(state: ReplayState, base: LedgerBaseConfig): ReplayedHousehold {
  const series: HouseholdSeries[] = [
    ...(base.initialIncomeSeries ?? []).map((os, i) => baseSeries(os, "income", i)),
    ...(base.initialExpenseSeries ?? []).map((os, i) => baseSeries(os, "expense", i)),
    ...[...state.seriesById.values()].map(
      (def): HouseholdSeries => ({
        id: def.id,
        ownerId: def.ownerId,
        seriesType: def.seriesType,
        role: def.role,
        causedByEventId: def.causedByEventId,
        startMonth: def.startMonth,
        endMonth: def.endMonth,
        series: materializeSeries(def),
      }),
    ),
  ];

  const liabilities: HouseholdLiability[] = [...state.liabilitiesById.values()].map((def) => ({
    id: def.id,
    kind: def.kind,
    ownerId: def.ownerId,
    causedByEventId: def.causedByEventId,
    startMonth: def.startMonth,
    openingBalanceCents: def.openingBalanceCents,
    apr: def.apr,
    termMonths: def.termMonths,
    creditLimitCents: def.creditLimitCents,
    transfers: def.transfers,
  }));

  return {
    memberships: [...state.personsById.values()].map((m) => ({
      person: m.person,
      startMonth: m.startMonth,
      endMonth: m.endMonth,
    })),
    children: [...state.childrenById.values()],
    series,
    liabilities,
    accountTransfers: [...state.accountTransfersByAccountId.values()].flat(),
  };
}

/** The single derive-from-replay entry point (§1). */
export function replayHousehold(ledger: Ledger, base: LedgerBaseConfig): ReplayedHousehold {
  return toHousehold(replayToState(ledger, base), base);
}

/**
 * Validate a would-be appended event against the current ledger+base: its own
 * fields, then its preconditions relative to the replayed state. A standalone
 * pre-check; {@link addEvent} runs this internally before appending.
 */
export function validateNewEvent(
  ledger: Ledger,
  base: LedgerBaseConfig,
  event: NewLifeEvent,
): ValidationResult {
  const data = validateEventData(event);
  if (!data.ok) return data;
  const stamped = { ...event, sequenceNumber: ledger.nextSequenceNumber } as LifeEvent;
  return checkEvent(stamped, replayToState(ledger, base), contextFrom(base));
}

/** Success carries the grown ledger; failure carries a human-readable conflict. */
export type AddResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; conflict: string };

/**
 * The safe, base-aware way to grow the ledger — symmetric with {@link removeEvent}.
 * Validates the event's own fields and its preconditions against the replayed
 * state; on success appends it (stamped with the next sequence number), on
 * failure returns the conflict and leaves the ledger untouched.
 */
export function addEvent(
  ledger: Ledger,
  base: LedgerBaseConfig,
  event: NewLifeEvent,
): AddResult {
  const check = validateNewEvent(ledger, base, event);
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
