/** A house is bought — a HomePurchaseEvent (property + mortgage + down payment). */

import { useState } from "react";
import {
  dollarsToCents,
  DTI_FRONT_END_THRESHOLD,
  DTI_BACK_END_THRESHOLD,
  type Household,
  type ProjectionSeries,
} from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { formatDollars } from "../../format";
import { MonthSelect, type FormProps } from "./formControls";
import { assessHomePurchaseDti } from "./homePurchaseDti";

/**
 * Opening values for the form — a plausible starter purchase the user edits, not
 * a recommendation. Dollars and percent, matching the inputs below; the cents
 * conversion happens at the engine boundary.
 */
const DEFAULTS: Omit<HomePurchaseDraft, "month"> = {
  price: 300_000,
  down: 60_000,
  apr: 6.5,
  termYears: 30,
};

/**
 * The form's live state — one draft in the units the fields edit (dollars and percent),
 * not a hook per field. The cents/fraction conversion happens at the engine boundary on
 * submit; the DTI advisory is derived from this each render, never stored.
 */
interface HomePurchaseDraft {
  readonly month: number;
  readonly price: number;
  readonly down: number;
  readonly apr: number;
  readonly termYears: number;
}

export function HomePurchaseForm({
  defaultMonth,
  nextId,
  horizonMonths,
  onAdd,
  household,
  series,
}: FormProps & {
  household: Household;
  series: ProjectionSeries;
}) {
  const [draft, setDraft] = useState<HomePurchaseDraft>(() => ({ month: defaultMonth, ...DEFAULTS }));
  const patch = (fields: Partial<HomePurchaseDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // The §4.5 SOFT warning: advisory only, recomputed each render so it tracks the
  // live inputs. It never gates `submit` — the event records regardless (the only
  // hard block, down-payment coverage, is enforced in the engine event handler).
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
      // The base plan seeds a single liquid account, "savings" (projectionBase).
      downPaymentAccountId: "savings",
      mortgageLiabilityId: `mortgage-${nextId}`,
      mortgageApr: draft.apr / 100,
      mortgageTermMonths: draft.termYears * 12,
    });
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      <NumInput label="Price" value={draft.price} onChange={(price) => patch({ price })} prefix="$" step={10000} />
      <NumInput label="Down payment" value={draft.down} onChange={(down) => patch({ down })} prefix="$" step={5000} />
      <NumInput label="Mortgage APR" value={draft.apr} onChange={(apr) => patch({ apr })} suffix="%" step={0.25} />
      <NumInput label="Term" value={draft.termYears} onChange={(termYears) => patch({ termYears })} suffix="yr" min={1} />
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
      {dti.exceeded && <DtiWarning dti={dti} />}
      <p className="hint">
        The down payment must be covered by liquid savings at that month — credit
        can’t fund it (§4.5).
      </p>
    </>
  );
}

/**
 * The §4.5 affordability advisory — distinct from the red hard-block alert (this
 * is amber and does NOT block). It names the ratio that fired *and* its projected
 * downstream consequence: an over-guideline mortgage leaves less income for
 * everything else, so the plan leans harder on credit and reaches insolvency
 * sooner.
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
