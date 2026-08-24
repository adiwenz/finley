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
 * Neither field keeps a copy. Both hand every parsed keystroke straight up and re-render from the
 * one percentage held here, which is what makes "they sum to 100" hold through the CLAMP as well:
 * a field that kept its own text sat at a clamped 100 while its partner was edited to 70, and
 * nothing typed afterwards could talk it back down.
 *
 * The one state the pair cannot express is a field with nothing in it — mid-retype, there is no
 * figure to take a complement of. That is reported rather than guessed at, because the alternative
 * is saving a split the form is not showing: an emptied field left the last committed percentage
 * standing invisibly, and Save wrote it.
 *
 * Used wherever a partnership is authored or corrected, so the answer is asked and shown in one
 * vocabulary across the add form, the edit form, and the starting-position form.
 */

import { useState } from "react";
import { DEFAULT_PARTNER_SHARE_PERCENT } from "@finley/engine";
import { NumInput } from "../numInput/numInput";

export { DEFAULT_PARTNER_SHARE_PERCENT };

export function SharedSplitFields({
  primaryName,
  partnerName,
  partnerPercent,
  onChange,
  onIncompleteChange,
}: {
  /** The primary's name, who carries whatever the partner does not. */
  readonly primaryName: string;
  /** The partner's name as typed so far; blank until they have one. */
  readonly partnerName: string;
  /** The partner's share, 0–100. */
  readonly partnerPercent: number;
  readonly onChange: (partnerPercent: number) => void;
  /**
   * Whether the pair is mid-retype and so is not currently showing a split at all. The form is
   * expected to refuse Save while it is — what is on screen sums to less than 100, and the
   * percentage behind it is one the user has already begun to replace.
   */
  readonly onIncompleteChange?: (incomplete: boolean) => void;
}) {
  const them = partnerName.trim() || "Partner";
  /** Which halves are showing nothing usable right now. Blurring either one refills it. */
  const [blank, setBlank] = useState({ primary: false, partner: false });
  const incomplete = blank.primary || blank.partner;

  /**
   * One keystroke, in whichever half it was typed. `shown` is what that field now displays, so
   * the other half is set from it directly — there is no second source to reconcile, and the
   * clamp has already happened by the time it arrives.
   */
  function live(half: "primary" | "partner", shown: number | null) {
    const next = { ...blank, [half]: shown === null };
    setBlank(next);
    onIncompleteChange?.(next.primary || next.partner);
    if (shown !== null) onChange(half === "primary" ? 100 - shown : shown);
  }

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
        onLiveChange={(shown) => live("primary", shown)}
        suffix="%"
        min={0}
        max={100}
        step={1}
      />
      <NumInput
        label={them}
        value={partnerPercent}
        onChange={onChange}
        onLiveChange={(shown) => live("partner", shown)}
        suffix="%"
        min={0}
        max={100}
        step={1}
      />
      {incomplete ? (
        <p className="hint warn" role="status">
          Enter a percentage for {blank.primary ? primaryName : them} — the two shares add up to
          100%.
        </p>
      ) : (
        <p className="hint">
          We’ll aim for this split each month. If one person can’t cover their share, the other may
          help.
        </p>
      )}
    </div>
  );
}
