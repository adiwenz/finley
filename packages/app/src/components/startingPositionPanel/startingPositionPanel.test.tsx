/**
 * @vitest-environment jsdom
 *
 * StartingPositionPanel — the accordion of "what's already true on day one" items. Pins that
 * exactly one item's form is open at a time (picking a second closes the first, picking the
 * open one again closes it), and that a successful submit collapses back to the closed state
 * rather than leaving a stale form open.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Projection } from "@finley/engine";
import { StartingPositionPanel } from "./startingPositionPanel";

afterEach(cleanup);

function renderPanel() {
  const carryLoan = vi.fn();
  const ownHome = vi.fn();
  const onAdd = (write: (p: Projection) => void) =>
    write({ carryLoan, ownHome } as unknown as Projection);
  render(<StartingPositionPanel onAdd={onAdd} />);
  return { carryLoan, ownHome };
}

const toggle = (name: RegExp) => screen.getByRole("button", { name });

describe("StartingPositionPanel — accordion", () => {
  it("opens no form until an item is picked", () => {
    renderPanel();
    expect(screen.queryByRole("combobox", { name: /Type/i })).toBeNull();
  });

  it("opening a second item closes the first", () => {
    renderPanel();
    fireEvent.click(toggle(/Loan/));
    expect(screen.getByRole("combobox", { name: /Type/i })).toBeTruthy();

    fireEvent.click(toggle(/Home/));
    expect(screen.queryByRole("combobox", { name: /Type/i })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: /Current value/i })).toBeTruthy();
  });

  it("clicking the open item's own toggle closes it", () => {
    renderPanel();
    fireEvent.click(toggle(/Loan/));
    expect(screen.getByRole("combobox", { name: /Type/i })).toBeTruthy();

    fireEvent.click(toggle(/Loan/));
    expect(screen.queryByRole("combobox", { name: /Type/i })).toBeNull();
  });

  it("a successful submit collapses the form", () => {
    const { carryLoan } = renderPanel();
    fireEvent.click(toggle(/Loan/));
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(carryLoan).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("combobox", { name: /Type/i })).toBeNull();
  });
});
