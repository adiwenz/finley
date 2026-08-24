/** A partner already in the household when the plan starts — a `startPartnered` anchor. */

import { useState } from "react";
import { MAX_AGE, MAX_LIVED_AGE, minLifeExpectancyFor, dollarsToCents } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { commitFocusedField } from "../numInput/commitFocusedField";
import type { StartingPositionFormProps } from "./startingPositionFormControls";
import {
  DEFAULT_PARTNER_SHARE_PERCENT,
  SharedSplitFields,
} from "../addEventForm/sharedSplitFields";

/**
 * What the life-expectancy field opens on. A visible, editable starting point — NOT a fallback:
 * the engine requires a partner's own expectancy and never substitutes the primary's, so the
 * number has to be one the user can see and change, in the same spirit as the age above.
 */
const PARTNER_DEFAULT_LIFE_EXPECTANCY = 90;

/**
 * The youngest a person can have been when the relationship began. Without it, "Together for"
 * was bounded only by a flat 70 years, so a partner aged 20 could be recorded as 30 years
 * together — a relationship starting when they were −10, which the plan then simulates as
 * though it were an ordinary past.
 *
 * 16 rather than 18: the field is describing a relationship, not a marriage, and a couple who
 * met in their teens is an ordinary thing to plan around. It is a floor against nonsense, not
 * a judgement about when a relationship ought to start.
 */
const MIN_RELATIONSHIP_AGE = 16;

export function ExistingPartnerForm({ onAdd, onDone, primaryName }: StartingPositionFormProps) {
  const [name, setName] = useState("");
  const [age, setAge] = useState(40);
  const [lifeExpectancy, setLifeExpectancy] = useState(PARTNER_DEFAULT_LIFE_EXPECTANCY);
  const [partneredForYears, setPartneredForYears] = useState(5);
  // Their own money, kept apart from the primary's opening balances. Zeroes are the honest
  // default: a partner with nothing stated brings nothing, which is what this form meant before
  // it could say otherwise.
  const [savings, setSavings] = useState(0);
  const [retirement, setRetirement] = useState(0);
  const [brokerage, setBrokerage] = useState(0);
  // A number, not a mode: the partnership opens on an even split and stays wherever it is put.
  const [sharePercent, setSharePercent] = useState(DEFAULT_PARTNER_SHARE_PERCENT);
  /** The split is mid-retype: what is on screen is not a split, so there is nothing to add yet. */
  const [splitIncomplete, setSplitIncomplete] = useState(false);

  function submit() {
    // The anchor lands at its true past month, driven by how long the household has been
    // together — `startPartnered` computes that month from `partneredForMonths`.
    const birthYear = new Date().getFullYear() - age;
    onAdd((p) =>
      p.startPartnered({
        partneredForMonths: partneredForYears * 12,
        name: name || "Partner",
        birthYear,
        lifeExpectancy,
        accounts: {
          savingsBalanceCents: dollarsToCents(savings),
          retirementBalanceCents: dollarsToCents(retirement),
          brokerageBalanceCents: dollarsToCents(brokerage),
        },
        partnerSharePercent: sharePercent,
      }),
    );
    onDone();
  }

  return (
    <>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="text-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Partner's name"
        />
      </label>
      {/* Lowering the age has to pull an already-entered relationship length down with it, or
          the bound below would hold only for whoever filled the fields in order. */}
      <NumInput
        label="Their age today"
        value={age}
        onChange={(next) => {
          setAge(next);
          setPartneredForYears((yrs) => Math.min(yrs, Math.max(0, next - MIN_RELATIONSHIP_AGE)));
        }}
        min={18}
        max={MAX_LIVED_AGE}
      />
      {/* Their own, not the household's: the projection runs to the longest-lived member, so a
          partner younger than the primary is what extends it. */}
      <NumInput
        label="Their life expectancy"
        value={lifeExpectancy}
        onChange={setLifeExpectancy}
        // The engine's floor for a person of this age, and nothing above it: a partner of 40
        // may be projected to 41. The `Math.max(60, …)` this replaces snapped that to 60.
        min={minLifeExpectancyFor(age)}
        max={MAX_AGE}
      />
      {/* Bounded by THEIR age, not a flat maximum: a relationship cannot predate the person in
          it. The bound moves with the age above, and a figure past it is clamped and explained
          rather than silently accepted. */}
      <NumInput
        label="Together for"
        value={partneredForYears}
        onChange={setPartneredForYears}
        suffix="yr"
        min={0}
        max={Math.max(0, age - MIN_RELATIONSHIP_AGE)}
      />
      {/* Return rates are deliberately absent: a partner's accounts grow at the household's own
          plan rates, which is one market assumption rather than a second set to keep in step. */}
      <NumInput label="Their cash savings" value={savings} onChange={setSavings} prefix="$" step={1_000} min={0} />
      <NumInput
        label="Their retirement account"
        value={retirement}
        onChange={setRetirement}
        prefix="$"
        step={1_000}
        min={0}
      />
      <NumInput label="Their brokerage" value={brokerage} onChange={setBrokerage} prefix="$" step={1_000} min={0} />
      <SharedSplitFields
        primaryName={primaryName ?? "You"}
        partnerName={name}
        partnerPercent={sharePercent}
        onChange={setSharePercent}
        onIncompleteChange={setSplitIncomplete}
      />
      <p className="hint">
        Their accounts join the household's net worth and can fund household spending while you are
        together, and leave with them at separation.
      </p>
      <button
        className="btn primary"
        disabled={splitIncomplete}
        onPointerDown={commitFocusedField}
        onClick={submit}
      >
        Add
      </button>
    </>
  );
}
