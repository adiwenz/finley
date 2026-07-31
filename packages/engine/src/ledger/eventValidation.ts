/**
 * Two-tier event validation:
 *  - {@link validateEventData}: stateless structural checks on an event's own fields,
 *    enforced at append time.
 *  - {@link validateEventPreconditions}: checks against replay state (referenced
 *    owners/series/liabilities exist and are active, ids unique, no double separation). Run
 *    during undo and available for pre-append validation.
 */

import type { ValidationResult } from "./ledger";
import type { LifeEvent, NewLifeEvent } from "./eventTypes";
import type { InterpretContext, InterpretState } from "./interpretState";
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
      return nonNegative(event, "annualCostCents", event.annualCostCents) ?? { ok: true };
    case "SeparationEvent":
      return (
        nonNegative(event, "alimonyMonthlyCents", event.alimonyMonthlyCents) ??
        nonNegative(event, "childSupportMonthlyCents", event.childSupportMonthlyCents) ??
        (Number.isInteger(event.alimonyDurationMonths) && event.alimonyDurationMonths >= 0
          ? { ok: true }
          : bad(event, `alimonyDurationMonths must be a nonnegative integer (got ${event.alimonyDurationMonths})`))
      );
    case "LoanEvent": {
      // The union guarantees which field is present, so each arm validates its own
      // without a null check.
      const money =
        nonNegative(event, "openingBalanceCents", event.openingBalanceCents) ??
        (event.apr >= 0 ? null : bad(event, `apr must be ≥ 0 (got ${event.apr})`));
      if (money) return money;
      return event.kind === "creditCard"
        ? nonNegative(event, "creditLimitCents", event.creditLimitCents) ?? { ok: true }
        : positiveInteger(event, "termMonths", event.termMonths) ?? { ok: true };
    }
    case "HomePurchaseEvent": {
      const money =
        nonNegative(event, "purchasePriceCents", event.purchasePriceCents) ??
        nonNegative(event, "downPaymentCents", event.downPaymentCents);
      if (money) return money;
      // Distinct, non-empty: a zero-source purchase has nothing to drain, and a repeated id
      // would double-drain one account. The mortgage's own terms are validated on its LoanEvent.
      if (!Array.isArray(event.downPaymentSourceIds) || event.downPaymentSourceIds.length === 0) {
        return bad(event, `downPaymentSourceIds must list at least one funding source`);
      }
      if (new Set(event.downPaymentSourceIds).size !== event.downPaymentSourceIds.length) {
        return bad(event, `downPaymentSourceIds must not repeat a source`);
      }
      return { ok: true };
    }
    case "DebtPayoffEvent":
      return event.amountCents > 0
        ? { ok: true }
        : bad(event, `amountCents must be > 0 (got ${event.amountCents})`);
  }
}

export function validateEventPreconditions(
  event: LifeEvent,
  state: InterpretState,
  context: InterpretContext,
): ValidationResult {
  return checkEvent(event, state, context);
}
