/**
 * @vitest-environment jsdom
 *
 * ExistingHomeForm — a home already owned at plan start. Pins that the mortgage fields are
 * gated on "still has a mortgage" (default on, since most held homes are mortgaged), and that
 * unchecking it omits `mortgage` entirely rather than sending zeros — an unmortgaged
 * `ownHome` and a mortgaged one are different shapes, not the same shape with a zero balance.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Projection } from "@finley/engine";
import { ExistingHomeForm } from "./existingHomeForm";

afterEach(cleanup);

function renderForm() {
  const ownHome = vi.fn();
  const onDone = vi.fn();
  const onAdd = (write: (p: Projection) => void) => write({ ownHome } as unknown as Projection);
  render(<ExistingHomeForm onAdd={onAdd} onDone={onDone} />);
  return { ownHome, onDone };
}

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("ExistingHomeForm", () => {
  it("owns a home with its mortgage's current balance and remaining term", () => {
    const { ownHome, onDone } = renderForm();
    fireEvent.change(spin(/Current value/i), { target: { value: "500000" } });
    fireEvent.change(spin(/Mortgage balance today/i), { target: { value: "300000" } });
    fireEvent.change(spin(/APR/i), { target: { value: "5.5" } });
    fireEvent.change(spin(/Term remaining/i), { target: { value: "20" } });
    fireEvent.click(btn(/^Add$/));

    expect(ownHome).toHaveBeenCalledWith(
      expect.objectContaining({
        valueCents: 500_000 * 100,
        mortgage: {
          balanceCents: 300_000 * 100,
          apr: 0.055,
          remainingTermMonths: 240,
        },
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("owns a home outright once the mortgage checkbox is unchecked — mortgage omitted, not zeroed", () => {
    const { ownHome } = renderForm();
    fireEvent.click(screen.getByRole("checkbox", { name: /Still has a mortgage/i }));
    expect(screen.queryByRole("spinbutton", { name: /Mortgage balance today/i })).toBeNull();

    fireEvent.click(btn(/^Add$/));
    const input = ownHome.mock.calls[0][0];
    expect(input.mortgage).toBeUndefined();
  });
});
