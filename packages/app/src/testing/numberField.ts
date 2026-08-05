/**
 * Entering a number in a test, the way a person enters one.
 *
 * {@link import("../components/numInput/numInput").NumInput} commits on blur, not on keystroke,
 * so a bare `fireEvent.change` is only half the gesture: it types digits into a field that has
 * not been left yet, and nothing downstream has heard about them. Every test that means "the
 * user entered 45 here" goes through this, so no test can accidentally assert against a value
 * still sitting uncommitted in a field.
 *
 * A test that specifically wants the half-finished state — digits typed, field still focused —
 * fires the `change` itself and does not call this.
 */
import { fireEvent } from "@testing-library/react";

export function enterNumber(field: HTMLElement, value: number | string): void {
  fireEvent.change(field, { target: { value: String(value) } });
  fireEvent.blur(field);
}
