/**
 * Two-tier event validation (§6):
 *  - {@link validateEventData}: pure, stateless structural checks on an event's
 *    own fields (nonnegative money, valid APR, integer months/terms). Enforced
 *    at append time.
 *  - {@link validateEventPreconditions}: checks against replay state (referenced
 *    owners/series/liabilities exist and are active, ids are unique, no double
 *    separation). Run during undo and available for pre-append validation.
 *
 * Both return messages naming the event id, type, and failed requirement.
 */

import type { ValidationResult } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import type { ReplayContext, ReplayState } from "./replayState";
import { checkEvent } from "./eventHandlers";

function bad(event: { id: string; type: string }, requirement: string): ValidationResult {
  return { ok: false, reason: `${event.type} "${event.id}": ${requirement}` };
}

function nonNegative(
  event: { id: string; type: string },
  label: string,
  value: number,
): ValidationResult | null {
  if (!(value >= 0)) return bad(event, `${label} must be ≥ 0 (got ${value})`);
  return null;
}

function positiveInteger(
  event: { id: string; type: string },
  label: string,
  value: number,
): ValidationResult | null {
  if (!Number.isInteger(value) || value <= 0) {
    return bad(event, `${label} must be a positive integer (got ${value})`);
  }
  return null;
}

/** Stateless structural validation of an event's own fields. */
export function validateEventData(event: NewLifeEvent): ValidationResult {
  if (!Number.isInteger(event.month)) {
    return bad(event, `month must be an integer (got ${event.month})`);
  }
  switch (event.type) {
    case "RelationshipEvent":
      if (!event.person.id) return bad(event, "person id must be non-empty");
      return { ok: true };
    case "ChildEvent":
      if (!Number.isInteger(event.birthMonth)) {
        return bad(event, `birthMonth must be an integer (got ${event.birthMonth})`);
      }
      return { ok: true };
    case "SeparationEvent":
      return (
        nonNegative(event, "alimonyMonthlyCents", event.alimonyMonthlyCents) ??
        nonNegative(event, "childSupportMonthlyCents", event.childSupportMonthlyCents) ??
        (Number.isInteger(event.alimonyDurationMonths) && event.alimonyDurationMonths >= 0
          ? { ok: true }
          : bad(event, `alimonyDurationMonths must be a nonnegative integer (got ${event.alimonyDurationMonths})`))
      );
    case "LoanEvent": {
      const money =
        nonNegative(event, "openingBalanceCents", event.openingBalanceCents) ??
        (event.apr >= 0 ? null : bad(event, `apr must be ≥ 0 (got ${event.apr})`)) ??
        (event.creditLimitCents == null
          ? null
          : nonNegative(event, "creditLimitCents", event.creditLimitCents));
      if (money) return money;
      if (event.termMonths != null) {
        const t = positiveInteger(event, "termMonths", event.termMonths);
        if (t) return t;
      }
      return { ok: true };
    }
    case "DebtPayoffEvent":
      return event.amountCents > 0
        ? { ok: true }
        : bad(event, `amountCents must be > 0 (got ${event.amountCents})`);
    case "JobChangeEvent":
      return nonNegative(event, "annualIncomeCents", event.annualIncomeCents) ?? { ok: true };
    case "BudgetItemStartEvent":
      return nonNegative(event, "monthlyCents", event.monthlyCents) ?? { ok: true };
    case "BudgetItemEndEvent":
      return { ok: true };
  }
}

/** Preconditions for `event` against the state accumulated so far. */
export function validateEventPreconditions(
  event: LifeEvent,
  state: ReplayState,
  context: ReplayContext,
): ValidationResult {
  return checkEvent(event, state, context);
}
