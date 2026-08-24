/**
 * Small labelled number field with optional $ / % / unit affixes.
 *
 * Every number the app authors comes through here, so this is the one place that decides WHEN a
 * typed figure becomes a fact. It becomes one on COMMIT — blur, or Enter — and not on each
 * keystroke. Every field on the panels writes straight to the plan, and the plan re-projects a
 * whole lifetime on every write, so a per-keystroke field ran that projection once per digit:
 * typing "45" into an age asked what happens if you retire at 4 before it ever asked about 45.
 * Those intermediate runs are not just wasted work — they are answers to questions nobody asked,
 * and the charts flicker through them.
 *
 * While the field has an uncommitted edit it shows that edit verbatim (`draft`), not the value
 * the plan holds: a half-typed number is the user's, and re-rendering it from a plan that has
 * not heard about it yet is what makes a controlled number field fight the person typing in it.
 * `null` means there is nothing uncommitted and the committed `value` shows through — including
 * right after a commit, so a clamped or reformatted figure ("007", 150 clamped to 100) snaps to
 * what was actually recorded rather than lingering as text that no longer means anything.
 *
 * An abandoned edit is DISCARDED, not committed: blanking the field and leaving it restores the
 * value rather than writing 0, which is a figure with consequences and was never typed.
 *
 * A clamped commit SAYS SO. Silently rewriting −$5,000 to $0 leaves the field showing a figure
 * the user did not type and gives no reason for it — they entered a negative balance, the form
 * accepted their click, and a partner arrived with nothing. The bound is still enforced; it is
 * now stated in the same breath.
 */

import { useId, useState } from "react";

export function NumInput({
  label,
  value,
  onChange,
  onLiveChange,
  prefix,
  suffix,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /**
   * Fired on every keystroke that already reads as a whole, in-range figure — for the rare field
   * whose value is not a fact about the plan but half of a pair the form has to keep consistent
   * while it is being typed (a percentage split's complement). Nothing that re-projects may
   * subscribe: the commit-on-blur contract above exists because those runs are expensive and
   * answer questions nobody asked.
   *
   * Deliberately silent on anything out of bounds or half-entered — "1" on the way to "130", a
   * lone "-", an emptied field — so a live listener never sees a figure the commit would refuse
   * and then clamp with an explanation.
   */
  onLiveChange?: (v: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  /** The uncommitted edit, verbatim; `null` when the committed `value` is what's shown. */
  const [draft, setDraft] = useState<string | null>(null);
  /** What the last commit did to a figure it would not take, or `null` when it took it whole. */
  const [clamped, setClamped] = useState<{ readonly typed: number; readonly used: number } | null>(
    null,
  );

  const noteId = useId();

  const withAffixes = (n: number) => `${prefix ?? ""}${n.toLocaleString("en-US")}${suffix ? ` ${suffix}` : ""}`;

  /**
   * Turn the draft into a fact, or discard it. Clamping happens here and only here: the
   * `min`/`max` attributes bound the spinner arrows alone, and typing flows through freely
   * above so intermediate digits are never fought — an age field with `min={18}` must let "4"
   * exist on its way to "45".
   */
  function commit() {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    // Nothing usable typed — an emptied field, or text a number input let through. The
    // committed value stands; writing 0 here would author a figure nobody entered.
    if (draft.trim() === "" || Number.isNaN(parsed)) return;
    let next = parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setClamped(next === parsed ? null : { typed: parsed, used: next });
    if (next !== value) onChange(next);
  }

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input-wrap">
        {prefix && <span className="field-affix">{prefix}</span>}
        <input
          type="number"
          value={draft ?? value}
          min={min ?? 0}
          max={max}
          step={step ?? 1}
          aria-describedby={clamped === null ? undefined : noteId}
          onChange={(e) => {
            // Typing again is the user answering the note; it has nothing left to say.
            setClamped(null);
            setDraft(e.target.value);
            if (onLiveChange === undefined) return;
            const typed = e.target.value.trim();
            const parsed = Number(typed);
            if (typed === "" || Number.isNaN(parsed)) return;
            if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) return;
            if (parsed !== value) onLiveChange(parsed);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter commits in place, keeping focus — the gesture for "yes, that figure",
            // from someone who is not done with the form. It must NOT submit an enclosing
            // form on the way, or a field would author its value and dismiss its own form.
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        {suffix && <span className="field-affix">{suffix}</span>}
      </span>
      {clamped !== null && (
        <span className="field-note" id={noteId} role="status">
          {withAffixes(clamped.typed)} isn't allowed here — using{" "}
          {withAffixes(clamped.used)}
          {clamped.used === min
            ? ", the lowest this can be."
            : clamped.used === max
              ? ", the highest this can be."
              : "."}
        </span>
      )}
    </label>
  );
}
