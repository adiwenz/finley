/**
 * The transaction lifecycle that is not authoring: retracting one, and revising one already in
 * the log.
 *
 * Both are addressable rather than positional — a UI deleting row 3 names the event, because it
 * does not know creation order — and both validate through the same whole-ledger replay, so an
 * edit that would strand a later event is refused naming it.
 */

import type { GrowthMode } from "../money/cashFlowSeries";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { Cents } from "../money/money";
import type { EmbeddedMortgage, LifeEvent, NewLifeEvent } from "../ledger/eventTypes";
import type { ProjectionState } from "./state";
import { dropEvent, replaceEvent } from "./eventWrite";
import { withBirthYear } from "../plan/person";
import { isPreExisting } from "../projection/nowMarker";
import { mint } from "./mint";

/**
 * What may be changed about a transaction already in the log — its DATA, never its identity.
 *
 * One variant per authoring verb, discriminated on the same `type` names
 * {@link import("../input/scenarioInput").EventEntry} uses, so a revision states which kind of event it
 * expects and revising a loan as though it were a home is a refusal rather than nonsense. Every
 * field is optional: an absent one keeps what the event already says.
 *
 * No variant carries an id, and none carries a nested entity. The event id, the person a marriage
 * created and their jobs, the child, the liability, the property all survive a revision
 * untouched — {@link revisedEvent} rebuilds from the existing event rather than from the caller,
 * so identity is preserved by construction and a field added to an event type is carried through
 * without being re-listed here.
 *
 * The purchase's embedded mortgage is the one exception, and only across a `financed` toggle: its
 * liability id survives an ordinary edit exactly like everything else above, but `financed: true`
 * on a cash purchase MINTS one (the caller cannot name it, same as everywhere else) and
 * `financed: false` drops it. Both still route through {@link revisedEvent} rebuilding from the
 * existing event, never from a caller-supplied id.
 *
 * Nested entities are added and removed through their own methods, which mint or target ids
 * properly (`./jobs` owns a partner's).
 *
 * The account fields (`downPaymentSourceIds`, `accountId`) name accounts that already exist —
 * target handles, the same ones the authoring inputs take. They mint nothing.
 */
export type TransactionRevision =
  | {
      readonly type: "marry";
      readonly month?: number;
      readonly name?: string;
      readonly birthYear?: number;
      /**
       * Optional the way every field on a revision is — omitted means "leave it alone", never
       * "default it". A partner's expectancy is required at `marry` and never inherited from the
       * primary, so this is the only way to change one after the fact.
       */
      readonly lifeExpectancy?: number;
      readonly benefitClaimingAge?: number;
    }
  | {
      readonly type: "haveChild";
      readonly month?: number;
      readonly name?: string;
      readonly birthMonth?: number;
      readonly annualCostCents?: Cents;
    }
  | {
      readonly type: "separate";
      readonly month?: number;
      readonly alimonyMonthlyCents?: Cents;
      readonly alimonyDurationMonths?: number;
      readonly childSupportMonthlyCents?: Cents;
    }
  | {
      /**
       * `kind` is fixed — a card and a term loan are different instruments, not one with a
       * different field set — so exactly one of `creditLimitCents`/`termMonths` applies, and
       * the other is refused rather than ignored.
       */
      readonly type: "takeLoan";
      readonly month?: number;
      readonly openingBalanceCents?: Cents;
      readonly apr?: number;
      readonly creditLimitCents?: Cents;
      readonly termMonths?: number;
    }
  | {
      /**
       * The mortgage rides inside the purchase now, so its terms are revised here, not through a
       * separate `takeLoan`. How the financed balance moves depends on the purchase kind:
       *
       * - A plan-time purchase re-derives `openingBalanceCents = purchasePriceCents − downPaymentCents`,
       *   so price and financed amount cannot drift; `mortgageBalanceCents` is IGNORED there.
       * - A HOLDING (a home already owned) opens at the mortgage's CURRENT balance, decoupled from
       *   value, so its balance is directly settable via `mortgageBalanceCents` and value edits leave
       *   it alone — the "edit value, balance, and terms in one place" case.
       *
       * `mortgageApr`/`mortgageTermMonths` revise a financed purchase's terms. `financed` is the
       * ONLY thing that toggles financing on or off:
       *
       * - Absent ⇒ no change — an already-financed purchase keeps its mortgage (and the mortgage
       *   fields above edit its terms); a cash purchase stays cash.
       * - `true` on an already-financed purchase ⇒ no-op beyond the usual term edits; its
       *   mortgage's liability id is carried through UNCHANGED.
       * - `true` on a cash purchase ⇒ mints a FRESH mortgage liability id (`mortgageApr` and
       *   `mortgageTermMonths` become required for this call) — never a reused, previously-removed
       *   one, even for the same event.
       * - `false` ⇒ drops `mortgage` entirely, id included; the purchase becomes cash. A later
       *   `financed: true` mints a new id from scratch.
       */
      readonly type: "buyHome";
      readonly month?: number;
      readonly purchasePriceCents?: Cents;
      readonly downPaymentCents?: Cents;
      readonly downPaymentSourceIds?: readonly string[];
      readonly financed?: boolean;
      readonly mortgageBalanceCents?: Cents;
      readonly mortgageApr?: number;
      readonly mortgageTermMonths?: number;
      readonly appreciationMode?: GrowthMode;
    }
  | {
      readonly type: "payOffDebt";
      readonly month?: number;
      readonly accountId?: string;
      readonly amountCents?: Cents;
    };

/** The event kind each revision verb addresses — the pairing {@link reviseProjectionTransaction} enforces. */
const REVISED_EVENT_TYPE: Record<TransactionRevision["type"], LifeEvent["type"]> = {
  marry: "RelationshipEvent",
  haveChild: "ChildEvent",
  separate: "SeparationEvent",
  takeLoan: "LoanEvent",
  buyHome: "HomePurchaseEvent",
  payOffDebt: "DebtPayoffEvent",
};

/** A rebuilt event, plus the counter it left behind — moved only when the revision minted an id. */
interface Revised {
  readonly next: NewLifeEvent;
  readonly nextSeq?: number;
}

/**
 * Rebuild an event with a revision's named fields applied.
 *
 * Every arm spreads `current` first, so identity — the event's own id, `childId`,
 * `partnerPersonId`, `liabilityId`, `ownerId`, `propertyId`, the person and their jobs — is
 * carried rather than re-listed. Only `sequenceNumber` is dropped, because
 * the ledger reassigns it. The revision's variant is known to match `current.type`:
 * {@link reviseProjectionTransaction} refuses the pairing before calling here, which is what
 * makes each cast below sound.
 *
 * Takes `state` for the one arm that can mint: a `buyHome` revision that finances a cash
 * purchase mints a fresh mortgage liability id off the same counter every other id comes off,
 * so it needs the counter to mint from. Every other arm never mints, so `nextSeq` is absent on
 * their `Revised` and {@link reviseProjectionTransaction} leaves the counter untouched.
 */
function revisedEvent(state: ProjectionState, current: LifeEvent, revision: TransactionRevision): Revised {
  const { sequenceNumber: _reassigned, ...kept } = current;
  const at = <T extends TransactionRevision["type"]>(_t: T) =>
    revision as Extract<TransactionRevision, { type: T }>;

  switch (current.type) {
    case "RelationshipEvent": {
      const r = at("marry");
      // A partner's jobs are dated in the partner's own ages, so a corrected birth year moves
      // them with it — the same rule the primary's edit runs, from the one definition of it, so
      // the two planes cannot disagree about what correcting a birthday means. Everything else
      // spreads over the result; their id and job list ride through either way.
      const person =
        r.birthYear === undefined ? current.person : withBirthYear(current.person, r.birthYear);
      return {
        next: {
          ...kept,
          month: r.month ?? current.month,
          // `birthYear` is not restated here: `person` already carries it, applied through the
          // rule above so the jobs it dates moved with it.
          person: {
            ...person,
            name: r.name ?? person.name,
            lifeExpectancy: r.lifeExpectancy ?? person.lifeExpectancy,
            benefitClaimingAge: r.benefitClaimingAge ?? person.benefitClaimingAge,
          },
        } as NewLifeEvent,
      };
    }
    case "ChildEvent": {
      const r = at("haveChild");
      return {
        next: {
          ...kept,
          month: r.month ?? current.month,
          childName: r.name ?? current.childName,
          birthMonth: r.birthMonth ?? current.birthMonth,
          annualCostCents: r.annualCostCents ?? current.annualCostCents,
        } as NewLifeEvent,
      };
    }
    case "SeparationEvent": {
      const r = at("separate");
      return {
        next: {
          ...kept,
          month: r.month ?? current.month,
          alimonyMonthlyCents: r.alimonyMonthlyCents ?? current.alimonyMonthlyCents,
          alimonyDurationMonths: r.alimonyDurationMonths ?? current.alimonyDurationMonths,
          childSupportMonthlyCents: r.childSupportMonthlyCents ?? current.childSupportMonthlyCents,
        } as NewLifeEvent,
      };
    }
    case "LoanEvent": {
      const r = at("takeLoan");
      const wrongArm =
        current.kind === "creditCard" ? r.termMonths !== undefined : r.creditLimitCents !== undefined;
      if (wrongArm) {
        throw new Error(
          `Projection: cannot revise transaction — a ${current.kind} loan takes ` +
            `${current.kind === "creditCard" ? "creditLimitCents" : "termMonths"}, not the other`,
        );
      }
      const common = {
        ...kept,
        month: r.month ?? current.month,
        openingBalanceCents: r.openingBalanceCents ?? current.openingBalanceCents,
        apr: r.apr ?? current.apr,
      };
      return {
        next: (
          current.kind === "creditCard"
            ? { ...common, creditLimitCents: r.creditLimitCents ?? current.creditLimitCents }
            : { ...common, termMonths: r.termMonths ?? current.termMonths }
        ) as NewLifeEvent,
      };
    }
    case "HomePurchaseEvent": {
      const r = at("buyHome");
      const appreciationMode = r.appreciationMode ?? current.appreciationMode;
      const purchasePriceCents = r.purchasePriceCents ?? current.purchasePriceCents;
      const downPaymentCents = r.downPaymentCents ?? current.downPaymentCents;
      // `financed` is the only thing that turns a mortgage on or off; absent, the purchase keeps
      // whatever it already is.
      const wantsMortgage = r.financed ?? current.mortgage !== undefined;
      let mortgage: EmbeddedMortgage | undefined;
      let nextSeq: number | undefined;
      if (!wantsMortgage) {
        // Financed → cash: the mortgage AND its liability id are dropped, not carried anywhere.
        mortgage = undefined;
      } else {
        // Rebuild the embedded mortgage from the revised numbers. For a plan-time purchase the
        // balance is DERIVED (`price − down`), so changing either re-finances it and the two can
        // never drift. A HOLDING opens at the mortgage's CURRENT balance instead — value and
        // balance are independent — so its balance is carried (or set outright via
        // `mortgageBalanceCents`) and never recomputed from value.
        const openingBalanceCents = isPreExisting(current.month)
          ? r.mortgageBalanceCents ?? current.mortgage?.openingBalanceCents ?? 0
          : purchasePriceCents - downPaymentCents;
        if (current.mortgage !== undefined) {
          // Edited mortgage: the liability id is carried through UNCHANGED — this is not a new
          // liability, only revised terms on the same one.
          mortgage = {
            liabilityId: current.mortgage.liabilityId,
            openingBalanceCents,
            apr: r.mortgageApr ?? current.mortgage.apr,
            termMonths: r.mortgageTermMonths ?? current.mortgage.termMonths,
          };
        } else {
          // Cash → mortgage: a fresh liability, minted off the shared counter — never an id a
          // prior, since-removed mortgage on this same purchase held.
          if (r.mortgageApr === undefined || r.mortgageTermMonths === undefined) {
            throw new Error(
              `Projection: cannot revise transaction — financing a cash purchase needs ` +
                `mortgageApr and mortgageTermMonths`,
            );
          }
          const minted = mint(state, "mortgage");
          nextSeq = minted.nextSeq;
          mortgage = {
            liabilityId: minted.id,
            openingBalanceCents,
            apr: r.mortgageApr,
            termMonths: r.mortgageTermMonths,
          };
        }
      }
      // `mortgage` is assigned unconditionally (even when `undefined`) rather than conditionally
      // spread: `kept` already carries `current.mortgage`, so a conditional spread would leave a
      // dropped mortgage sitting in the rebuilt event whenever `wantsMortgage` went false.
      return {
        next: {
          ...kept,
          month: r.month ?? current.month,
          purchasePriceCents,
          downPaymentCents,
          downPaymentSourceIds: r.downPaymentSourceIds ?? current.downPaymentSourceIds,
          mortgage,
          ...(appreciationMode !== undefined ? { appreciationMode } : {}),
        } as NewLifeEvent,
        nextSeq,
      };
    }
    case "DebtPayoffEvent": {
      const r = at("payOffDebt");
      return {
        next: {
          ...kept,
          month: r.month ?? current.month,
          accountId: r.accountId ?? current.accountId,
          amountCents: r.amountCents ?? current.amountCents,
        } as NewLifeEvent,
      };
    }
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

/**
 * Drop a transaction and, transitively, everything it caused — a home purchase takes its
 * mortgage, a child their cost stream.
 *
 * REFUSED when the remaining ledger would no longer replay — separating a partner you never
 * married — and the conflict names the event that would fail. Sequence numbers are never
 * recycled, so a later append cannot collide with the gap this leaves.
 */
export function removeProjectionTransaction(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  id: string,
): ProjectionState {
  return dropEvent(state, jurisdiction, id);
}

/**
 * Revise a transaction's DATA in place — its amounts, its month, the names on it — keeping its
 * id, its place in the log, and every identity it carries. Without this, anything authored *on*
 * an event is write-once.
 *
 * The revision names only what changes ({@link TransactionRevision}); it cannot carry an id, a
 * person, a job list or any other nested entity, and the event is rebuilt from what is already in
 * the log rather than from the caller. So a revision can no more re-point a `liabilityId` or swap
 * a partner's job list than it can rename the event.
 *
 * `type` is fixed as well as `id` — dependencies are tracked by id, meaning by type — so a
 * revision that names the wrong verb for the event is refused rather than reinterpreted. Changing
 * either means a different event: remove and add instead.
 */
export function reviseProjectionTransaction(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  id: string,
  revision: TransactionRevision,
): ProjectionState {
  const current = state.scenario.ledger.events.find((e) => e.id === id);
  if (current === undefined) {
    throw new Error(`Projection: cannot revise transaction — no transaction "${id}"`);
  }
  const expected = REVISED_EVENT_TYPE[revision.type];
  if (current.type !== expected) {
    throw new Error(
      `Projection: cannot revise transaction — "${id}" is a ${current.type}, ` +
        `which a "${revision.type}" revision does not address`,
    );
  }
  // A `marry` revision may move that partner's `birthYear` or `lifeExpectancy`, and so the month
  // they die — which everything that partner takes part in is dated against: their own separation,
  // any loan or home they own, any job they hold. `replaceEvent` checks the prospective state for
  // exactly that, so an edit that strands one past a death is refused rather than leaving an event
  // nobody lives to see.
  const { next, nextSeq } = revisedEvent(state, current, revision);
  return replaceEvent(state, jurisdiction, id, next, nextSeq);
}
