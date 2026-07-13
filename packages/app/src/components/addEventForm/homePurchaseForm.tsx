/** A house is bought — a HomePurchaseEvent (property + mortgage + down payment). */

import { useState } from "react";
import { dollarsToCents } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type FormProps } from "./formControls";

export function HomePurchaseForm({ defaultMonth, nextId, onAdd }: FormProps) {
  const [month, setMonth] = useState(defaultMonth);
  const [price, setPrice] = useState(300_000);
  const [down, setDown] = useState(60_000);
  const [apr, setApr] = useState(6.5);
  const [termYears, setTermYears] = useState(30);

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "HomePurchaseEvent",
      month,
      propertyId: `home-${nextId}`,
      ownerId: "p1",
      purchasePriceCents: dollarsToCents(price),
      downPaymentCents: dollarsToCents(down),
      // The base plan seeds a single liquid account, "savings" (projectionBase).
      downPaymentAccountId: "savings",
      mortgageLiabilityId: `mortgage-${nextId}`,
      mortgageApr: apr / 100,
      mortgageTermMonths: termYears * 12,
    });
  }

  return (
    <>
      <MonthSelect value={month} onChange={setMonth} />
      <NumInput label="Price" value={price} onChange={setPrice} prefix="$" step={10000} />
      <NumInput label="Down payment" value={down} onChange={setDown} prefix="$" step={5000} />
      <NumInput label="Mortgage APR" value={apr} onChange={setApr} suffix="%" step={0.25} />
      <NumInput label="Term" value={termYears} onChange={setTermYears} suffix="yr" min={1} />
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
      <p className="hint">
        The down payment must be covered by liquid savings at that month — credit
        can’t fund it (§4.5).
      </p>
    </>
  );
}
