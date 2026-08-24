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
   * Fired on every keystroke, reporting what this field NOW SHOWS — for the rare field whose
   * value is not a fact about the plan but half of a pair the form has to keep consistent while
   * it is being typed (a percentage split's complement). `null` means it shows nothing usable
   * yet: an emptied field, a lone "-". Nothing that re-projects may subscribe — the
   * commit-on-blur contract above exists because those runs are expensive and answer questions
   * nobody asked.
   *
   * Subscribing also moves the CLAMP forward to the keystroke, and the field snaps to the bound
   * with the usual note. That is the opposite of the "4 on the way to 45" freedom above, and it
   * has to be: the listener's whole job is to hold the pair at 100, so a live 150 would show
   * 150 beside a complement of 0 — two figures summing to 150, one of which the commit is about
   * to refuse. A bounded pair has no half-typed 150 to protect; there is no in-range number it
   * is on the way to.
   *
   * Subscribing FORFEITS the private draft for any keystroke that parses: the figure is handed
   * up and the field re-renders from `value`, so the caller is the only one holding it. A live
   * field that kept its own copy went stale the moment its partner was edited — a clamped 150
   * left "100" showing while the pair moved underneath it, and 70/100 summed to 170 with no
   * gesture that could talk the field down again. The cost is that a live field cannot show
   * "007" or a trailing ".", which is why only a bounded whole-number pair subscribes.
   */
  onLiveChange?: (v: number | null) => void;
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
  /** The figure this field will take, given what was typed — the bounds, and nothing else. */
  function bound(n: number): number {
    let next = n;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  }

  function commit() {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    // Nothing usable typed — an emptied field, or text a number input let through. The
    // committed value stands; writing 0 here would author a figure nobody entered.
    if (draft.trim() === "" || Number.isNaN(parsed)) {
      // The abandoned edit is gone and `value` shows through again — a live caller was last
      // told `null`, so say what the field went back to or it would hold the pair invalid.
      onLiveChange?.(value);
      return;
    }
    // Only ever SETS the note. A note is answered by the next keystroke, which clears it above —
    // clearing it here instead would swallow the one a live clamp already put up, since the draft
    // it left behind is the bounded figure and this commit then has nothing of its own to say.
    const next = bound(parsed);
    if (next !== parsed) setClamped({ typed: parsed, used: next });
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
            const typed = e.target.value.trim();
            const parsed = Number(typed);
            if (onLiveChange === undefined) {
              setDraft(e.target.value);
              return;
            }
            // Half-entered: there is no figure to hand up or to clamp. The text stays verbatim,
            // and the caller is told the field is currently showing nothing it can use.
            if (typed === "" || Number.isNaN(parsed)) {
              setDraft(e.target.value);
              onLiveChange(null);
              return;
            }
            // Nothing kept here. The bounded figure goes up and comes back as `value`, so this
            // field renders what the caller holds and cannot drift from its partner.
            setDraft(null);
            if (bound(parsed) !== parsed) setClamped({ typed: parsed, used: bound(parsed) });
            onLiveChange(bound(parsed));
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
