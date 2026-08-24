/**
 * How a partnership divides its shared expenses — two percentages that always sum to 100.
 *
 * One control, no modes. There is no "even vs proportional" choice to make and no strategy to
 * pick: 50/50 is simply the number the field opens on, and every other split is the same field
 * with a different number in it. Nothing the projection later discovers about either person's
 * income, savings, job, benefits or tax ever moves it.
 *
 * The two fields are one value. Editing either sets the other to its complement, so the pair
 * cannot be left in a state that does not add up — a household is never asked to do the
 * subtraction, and there is no invalid combination to reject.
 *
 * The complement follows the KEYSTROKE, not the blur. These two fields are the one place in the
 * app where a number is not a fact about the plan but half of a pair, so waiting for the field to
 * be left showed a 0/30 split on the way from 70/30 to 0/100 — two figures that sum to 30 and a
 * reader with no way to know which one the plan would take. Nothing re-projects on it: the split
 * lives in the form's own draft until the event is written, so the live half costs a render.
 *
 * Used wherever a partnership is authored or corrected, so the answer is asked and shown in one
 * vocabulary across the add form, the edit form, and the starting-position form.
 */

import { DEFAULT_PARTNER_SHARE_PERCENT } from "@finley/engine";
import { NumInput } from "../numInput/numInput";

export { DEFAULT_PARTNER_SHARE_PERCENT };

export function SharedSplitFields({
  primaryName,
  partnerName,
  partnerPercent,
  onChange,
}: {
  /** The primary's name, who carries whatever the partner does not. */
  readonly primaryName: string;
  /** The partner's name as typed so far; blank until they have one. */
  readonly partnerName: string;
  /** The partner's share, 0–100. */
  readonly partnerPercent: number;
  readonly onChange: (partnerPercent: number) => void;
}) {
  const them = partnerName.trim() || "Partner";
  return (
    <div className="field">
      <span className="field-label">How do you divide shared expenses?</span>
      {/* The primary's field writes the COMPLEMENT, so whichever of the two the user reaches for
          behaves the same way. Both are clamped to 0–100 by NumInput, and 0/100 and 100/0 are
          ordinary answers rather than edge cases. */}
      <NumInput
        label={primaryName}
        value={100 - partnerPercent}
        onChange={(primary) => onChange(100 - primary)}
        onLiveChange={(primary) => onChange(100 - primary)}
        suffix="%"
        min={0}
        max={100}
        step={1}
      />
      <NumInput
        label={them}
        value={partnerPercent}
        onChange={onChange}
        onLiveChange={onChange}
        suffix="%"
        min={0}
        max={100}
        step={1}
      />
      <p className="hint">
        We’ll aim for this split each month. If one person can’t cover their share, the other may
        help.
      </p>
    </div>
  );
}
