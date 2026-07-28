/** A house is bought — a HomePurchaseEvent (property + mortgage + down payment). */

import { useMemo, useState } from "react";
import {
  dollarsToCents,
  DTI_FRONT_END_THRESHOLD,
  DTI_BACK_END_THRESHOLD,
  type FundingLookup,
  type Household,
  type ProjectionSeries,
} from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { formatDollars } from "../../format";
import { MonthSelect, type FormProps } from "./formControls";
import { assessHomePurchaseDti } from "./homePurchaseDti";
import { FundingSourcePicker } from "./fundingSourcePicker";

/**
 * Opening values — a plausible starter purchase to edit, not a recommendation. Dollars
 * and percent, matching the inputs; cents conversion happens at the engine boundary.
 */
const DEFAULTS: Omit<HomePurchaseDraft, "month" | "sourceIds"> = {
  price: 300_000,
  down: 60_000,
  apr: 6.5,
  termYears: 30,
};

/**
 * The form's live state — one draft in the units the fields edit, not a hook per field.
 * Cents/fraction conversion happens at the engine boundary on submit; the DTI advisory
 * derives from this each render, never stored.
 */
interface HomePurchaseDraft {
  readonly month: number;
  readonly price: number;
  readonly down: number;
  readonly apr: number;
  readonly termYears: number;
  /**
   * Accounts the down payment drains, IN ORDER — the first empties before the next.
   * Stored intent, not the live selection: the render filters it to what can still pay at
   * `month` before anything reads it.
   */
  readonly sourceIds: readonly string[];
}

export function HomePurchaseForm({
  defaultMonth,
  nextId,
  horizonMonths,
  onAdd,
  household,
  series,
  funding,
}: FormProps & {
  household: Household;
  series: ProjectionSeries;
  /** The engine's funding questions — the same pair `addEvent`'s §4.5 gate answers with. */
  funding: FundingLookup;
}) {
  // Accounts that can actually pay at `month`, largest-first (drain-order friendly). The
  // pool also lists accounts holding nothing — the picker greys those out.
  const fundableAt = (month: number) =>
    funding.sourcesAt(month).filter((s) => s.balanceCents > 0).map((s) => s.id);

  const [draft, setDraft] = useState<HomePurchaseDraft>(() => ({
    month: defaultMonth,
    ...DEFAULTS,
    // Open on the largest account that can pay that month, so the form is usable without
    // a choice — a visible, editable default rather than a hardcoded one.
    sourceIds: fundableAt(defaultMonth).slice(0, 1),
  }));
  const patch = (fields: Partial<HomePurchaseDraft>) => setDraft((d) => ({ ...d, ...fields }));

  /**
   * Moving the purchase re-prices every account, so one picked while it held money may
   * hold nothing at the new month. Drop it: a selection the user can no longer see is one
   * they no longer have. Nothing takes its place — quietly substituting an account would
   * spend money they did not choose to spend.
   */
  const setMonth = (month: number) =>
    setDraft((d) => {
      const fundable = new Set(fundableAt(month));
      return { ...d, month, sourceIds: d.sourceIds.filter((id) => fundable.has(id)) };
    });

  // Pool and verdict for the CURRENT month/selection/amount, both from one projection
  // inside `funding`, so edits re-derive without re-simulating the plan.
  const pool = useMemo(() => funding.sourcesAt(draft.month), [funding, draft.month]);
  // The selection actually in play. `setMonth` prunes on the path a user takes, but the
  // pool also moves when `funding` changes (an event elsewhere redraws the same month's
  // balances) and that path has no setter to hook. Filtering here makes it an invariant:
  // what the picker checks, what the coverage line counts, and what `submit` records are
  // one list.
  const sourceIds = useMemo(
    () => draft.sourceIds.filter((id) => pool.some((s) => s.id === id && s.balanceCents > 0)),
    [draft.sourceIds, pool],
  );
  const availability = useMemo(
    () => funding.availabilityAt(sourceIds, dollarsToCents(draft.down), draft.month),
    [funding, sourceIds, draft.down, draft.month],
  );

  // SOFT warning: advisory only, recomputed each render so it tracks live inputs. Never
  // gates `submit` — the only hard block, down-payment coverage, is enforced in the
  // engine event handler.
  const dti = assessHomePurchaseDti(household, series, {
    month: draft.month,
    purchasePriceCents: dollarsToCents(draft.price),
    downPaymentCents: dollarsToCents(draft.down),
    apr: draft.apr / 100,
    termMonths: draft.termYears * 12,
  });

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "HomePurchaseEvent",
      month: draft.month,
      propertyId: `home-${nextId}`,
      ownerId: "p1",
      purchasePriceCents: dollarsToCents(draft.price),
      downPaymentCents: dollarsToCents(draft.down),
      // Chosen accounts in chosen order — the drain order the simulator resolves the
      // down payment against. Pruned, so an account emptied by a month change cannot
      // ride onto the event unseen.
      downPaymentSourceIds: sourceIds,
      mortgageLiabilityId: `mortgage-${nextId}`,
      mortgageApr: draft.apr / 100,
      mortgageTermMonths: draft.termYears * 12,
    });
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={setMonth} />
      <NumInput label="Price" value={draft.price} onChange={(price) => patch({ price })} prefix="$" step={10000} />
      <NumInput label="Down payment" value={draft.down} onChange={(down) => patch({ down })} prefix="$" step={5000} />
      <NumInput label="Mortgage APR" value={draft.apr} onChange={(apr) => patch({ apr })} suffix="%" step={0.25} />
      <NumInput label="Term" value={draft.termYears} onChange={(termYears) => patch({ termYears })} suffix="yr" min={1} />
      <FundingSourcePicker
        pool={pool}
        selected={sourceIds}
        amountCents={dollarsToCents(draft.down)}
        availability={availability}
        onChange={(sourceIds) => patch({ sourceIds })}
        label="Down payment paid from"
      />
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
      {dti.exceeded && <DtiWarning dti={dti} />}
      <p className="hint">
        Accounts are drained in the order you pick them, and only cash and
        investment accounts can pay — retirement savings and credit can’t.
      </p>
    </>
  );
}

/**
 * Affordability advisory — amber, and does NOT block, unlike the red hard-block alert. It
 * names the ratio that fired *and* its downstream consequence: an over-guideline mortgage
 * leaves less for everything else, so the plan leans harder on credit and reaches
 * insolvency sooner.
 */
function DtiWarning({ dti }: { dti: ReturnType<typeof assessHomePurchaseDti> }) {
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
