/** A house is bought — a HomePurchaseEvent (property + mortgage + down payment). */

import { useMemo, useState } from "react";
import {
  dollarsToCents,
  DTI_FRONT_END_THRESHOLD,
  DTI_BACK_END_THRESHOLD,
  isPreExisting,
  PRIMARY_PERSON_ID,
  type FundingLookup,
  type HomePurchaseAssessment,
  type ProjectionResult,
} from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { formatDollars } from "../../format";
import { HoldingWhen, MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";
import { FundingSourcePicker } from "./fundingSourcePicker";

/** Opening values — a plausible starter purchase to edit, not a recommendation. `mortgageBalance`
 * is omitted: a plan-time purchase derives it from price − down at init. */
const DEFAULTS: Omit<HomePurchaseDraft, "month" | "sourceIds" | "mortgageBalance"> = {
  price: 300_000,
  down: 60_000,
  apr: 6.5,
  termYears: 30,
};

/**
 * One draft in the units the fields edit, not a hook per field. Cents/fraction conversion
 * happens at the engine boundary on submit; the DTI advisory derives from this each render.
 */
interface HomePurchaseDraft {
  readonly month: number;
  readonly price: number;
  readonly down: number;
  readonly apr: number;
  readonly termYears: number;
  /**
   * The balance still owed, in dollars. Only a HOLDING edits it directly — a plan-time purchase
   * derives it as price − down. Carried for the plan-time case but never shown there.
   */
  readonly mortgageBalance: number;
  /**
   * Accounts the down payment drains, IN ORDER — the first empties before the next.
   * Stored intent, not the live selection: the render filters it to what can still pay at
   * `month` before anything reads it.
   */
  readonly sourceIds: readonly string[];
}

export function HomePurchaseForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  result,
  funding,
  edit,
}: FormProps & {
  /** The live run — the DTI advisory is read off it, never re-simulated here. */
  result: ProjectionResult;
  /** The engine's funding questions — the same pair `addEvent`'s §4.5 gate answers with. */
  funding: FundingLookup;
  edit?: EditProps<EventOf<"HomePurchaseEvent">>;
}) {
  // Accounts that can actually pay at `month`, largest-first (drain-order friendly); the
  // pool itself also lists accounts holding nothing, which the picker greys out.
  const fundableAt = (month: number) =>
    funding.sourcesAt(month).filter((s) => s.balanceCents > 0).map((s) => s.id);

  const [draft, setDraft] = useState<HomePurchaseDraft>(() =>
    edit
      ? {
          month: edit.event.month,
          price: edit.event.purchasePriceCents / 100,
          down: edit.event.downPaymentCents / 100,
          // The embedded mortgage's terms, prefilled so one form edits price, financing, and terms
          // together. A cash purchase / owned-outright home has none, so fall back to the defaults
          // (unshown there anyway).
          apr: edit.event.mortgage ? edit.event.mortgage.apr * 100 : DEFAULTS.apr,
          termYears: edit.event.mortgage ? edit.event.mortgage.termMonths / 12 : DEFAULTS.termYears,
          mortgageBalance: edit.event.mortgage ? edit.event.mortgage.openingBalanceCents / 100 : 0,
          sourceIds: edit.event.downPaymentSourceIds,
        }
      : {
          month: defaultMonth,
          ...DEFAULTS,
          mortgageBalance: DEFAULTS.price - DEFAULTS.down,
          // The largest account that can pay that month: a visible, editable default rather than
          // a hardcoded one.
          sourceIds: fundableAt(defaultMonth).slice(0, 1),
        },
  );
  const patch = (fields: Partial<HomePurchaseDraft>) => setDraft((d) => ({ ...d, ...fields }));

  /**
   * A holding — a home the household already owns. It opened at the now marker with no draw and
   * no §4.5 gate, and its price field IS today's value, so the date is stated rather than picked
   * and there is no down payment to fund: the fields below are exactly what the Starting position
   * form asked for. Its mortgage rides inside the purchase now, so its balance and terms are edited
   * right here rather than on a separate loan marker.
   */
  const holding = edit !== undefined && isPreExisting(edit.event.month);

  /**
   * Whether there is a mortgage to edit. Adding always finances (the down payment is below the
   * price); editing shows the mortgage fields only when the event already carries one, so a cash
   * purchase / owned-outright home is not offered financing it does not have.
   */
  const financed = edit === undefined || edit.event.mortgage !== undefined;

  /**
   * Moving the purchase re-prices every account, so one picked while it held money may hold
   * nothing at the new month. Drop it, and put nothing in its place — quietly substituting
   * an account would spend money the user did not choose to spend.
   */
  const setMonth = (month: number) =>
    setDraft((d) => {
      const fundable = new Set(fundableAt(month));
      return { ...d, month, sourceIds: d.sourceIds.filter((id) => fundable.has(id)) };
    });

  // Both read one projection inside `funding`, so edits re-derive without re-simulating.
  const pool = useMemo(() => funding.sourcesAt(draft.month), [funding, draft.month]);
  // The selection actually in play. `setMonth` prunes on the path a user takes, but the pool
  // also moves when `funding` changes (an event elsewhere redraws the same month's balances)
  // and that path has no setter to hook. Filtering here makes it an invariant: what the
  // picker checks, what the coverage line counts, and what `submit` records are one list.
  const sourceIds = useMemo(
    () => draft.sourceIds.filter((id) => pool.some((s) => s.id === id && s.balanceCents > 0)),
    [draft.sourceIds, pool],
  );
  const availability = useMemo(
    () => funding.availabilityAt(sourceIds, dollarsToCents(draft.down), draft.month),
    [funding, sourceIds, draft.down, draft.month],
  );

  // SOFT warning: never gates `submit`. The only hard block, down-payment coverage, is
  // enforced in the engine event handler.
  const dti = result.assessHomePurchase({
    month: draft.month,
    purchasePriceCents: dollarsToCents(draft.price),
    downPaymentCents: dollarsToCents(draft.down),
    apr: draft.apr / 100,
    termMonths: draft.termYears * 12,
  });

  function submit() {
    // One `buyHome` revision carries the property's fields AND the embedded mortgage. The engine
    // re-derives a plan-time purchase's balance from price − down; a holding's balance is decoupled
    // from value, so it is sent explicitly. Mortgage fields are omitted for a cash purchase.
    if (edit) {
      edit.onRevise((p) =>
        p.reviseTransaction(edit.event.id, {
          type: "buyHome",
          month: draft.month,
          purchasePriceCents: dollarsToCents(draft.price),
          downPaymentCents: dollarsToCents(draft.down),
          downPaymentSourceIds: sourceIds,
          ...(financed
            ? { mortgageApr: draft.apr / 100, mortgageTermMonths: draft.termYears * 12 }
            : {}),
          ...(holding && financed ? { mortgageBalanceCents: dollarsToCents(draft.mortgageBalance) } : {}),
        }),
      );
      return;
    }
    // `buyHome` mints the property id and derives `<propertyId>-mortgage` from it.
    onAdd((p) =>
      p.buyHome({
        month: draft.month,
        ownerId: PRIMARY_PERSON_ID,
        purchasePriceCents: dollarsToCents(draft.price),
        downPaymentCents: dollarsToCents(draft.down),
        // Chosen order = the drain order the simulator resolves the down payment against.
        downPaymentSourceIds: sourceIds,
        mortgageApr: draft.apr / 100,
        mortgageTermMonths: draft.termYears * 12,
      }),
    );
  }

  return (
    <>
      {holding ? (
        <HoldingWhen />
      ) : (
        <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={setMonth} />
      )}
      <NumInput
        label={holding ? "Current value" : "Price"}
        value={draft.price}
        onChange={(price) => patch({ price })}
        prefix="$"
        step={10000}
      />
      {!holding && (
        <NumInput label="Down payment" value={draft.down} onChange={(down) => patch({ down })} prefix="$" step={5000} />
      )}
      {/* The mortgage lives inside the purchase, so its terms are edited here. A holding's balance
          is decoupled from its value, so it gets its own field; a plan-time purchase derives the
          balance from price − down and shows none. */}
      {financed && (
        <>
          {holding && (
            <NumInput
              label="Mortgage balance"
              value={draft.mortgageBalance}
              onChange={(mortgageBalance) => patch({ mortgageBalance })}
              prefix="$"
              step={5000}
            />
          )}
          <NumInput label="Mortgage APR" value={draft.apr} onChange={(apr) => patch({ apr })} suffix="%" step={0.25} />
          <NumInput label="Term" value={draft.termYears} onChange={(termYears) => patch({ termYears })} suffix="yr" min={1} />
        </>
      )}
      {/* A holding drew nothing when it opened, so there is no drain order to edit. */}
      {!holding && (
        <FundingSourcePicker
          pool={pool}
          selected={sourceIds}
          amountCents={dollarsToCents(draft.down)}
          availability={availability}
          onChange={(sourceIds) => patch({ sourceIds })}
          label="Down payment paid from"
        />
      )}
      <button className="btn primary" onClick={submit}>
        {edit ? "Save changes" : "Add event"}
      </button>
      {/* The affordability advisory is an authoring-time nudge on a new purchase; an edit to an
          already-recorded home does not re-open it. */}
      {!edit && dti.exceeded && <DtiWarning dti={dti} />}
      <p className="hint">
        {holding
          ? "Opens at today's value — no down payment, no affordability gate."
          : "Accounts are drained in the order you pick them, and only cash and investment accounts can pay — retirement savings and credit can’t."}
      </p>
    </>
  );
}

/** Affordability advisory — amber, and does NOT block, unlike the red hard-block alert. */
function DtiWarning({ dti }: { dti: HomePurchaseAssessment }) {
  const { assessment, monthlyMortgageCents } = dti;
  const frontPct = Math.round(assessment.frontEndRatio * 100);
  const backPct = Math.round(assessment.backEndRatio * 100);
  const frontGuide = Math.round(DTI_FRONT_END_THRESHOLD * 100);
  const backGuide = Math.round(DTI_BACK_END_THRESHOLD * 100);

  return (
    <div className="alert alert-amber soft-warning" role="status">
      <strong>Affordability heads-up.</strong> This adds about{" "}
      {formatDollars(monthlyMortgageCents)}/mo in mortgage payments.
      {assessment.frontEndExceeded && (
        <> Housing would take {frontPct}% of gross income (guideline: {frontGuide}%).</>
      )}
      {assessment.backEndExceeded && (
        <> Total debt would take {backPct}% of gross income (guideline: {backGuide}%).</>
      )}{" "}
      Above the guideline, less income is left to cover everything else — the plan
      leans harder on credit and can run out of money sooner. The purchase still
      records; this is advice, not a block.
    </div>
  );
}
