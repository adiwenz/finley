/**
 * Flush the field the user is still standing in, before a button acts on the form.
 *
 * {@link import("./numInput").NumInput} turns a typed figure into a fact on BLUR, which assumes
 * that reaching for Save takes focus out of the field first. A button is not required to take
 * focus when it is clicked, and on macOS it does not — so the gesture everyone actually makes,
 * type the last number and click Save, submitted the form with that number still uncommitted
 * inside the field. The value written was the one the field had before the edit, the form closed
 * on success, and nothing anywhere said an edit had been dropped.
 *
 * Called on POINTER DOWN, which precedes both the focus change and the click: the commit and its
 * re-render land before the click handler reads the draft, so the click sees what is on screen.
 * Fields that were already committed blur to no effect, so this is safe on any button.
 */
export function commitFocusedField(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}
