/**
 * @vitest-environment jsdom
 *
 * ExistingPartnerForm — a partner already in the household at plan start. Pins that the form
 * hands `startPartnered` months-together (not a month), and derives the birth year from the
 * age entered rather than asking for it directly.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import type { Projection } from "@finley/engine";
import { ExistingPartnerForm } from "./existingPartnerForm";

afterEach(cleanup);

function renderForm() {
  const startPartnered = vi.fn();
  const onDone = vi.fn();
  const onAdd = (write: (p: Projection) => void) =>
    write({ startPartnered } as unknown as Projection);
  render(<ExistingPartnerForm onAdd={onAdd} onDone={onDone} />);
  return { startPartnered, onDone };
}

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("ExistingPartnerForm", () => {
  it("authors a partner anchored on months together, defaulting an unnamed partner", () => {
    const { startPartnered, onDone } = renderForm();
    enterNumber(spin(/Their age today/i), "45");
    enterNumber(spin(/Together for/i), "10");
    fireEvent.click(btn(/^Add$/));

    const currentYear = new Date().getFullYear();
    expect(startPartnered).toHaveBeenCalledWith({
      partneredForMonths: 120,
      name: "Partner",
      birthYear: currentYear - 45,
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("carries an entered name through unchanged", () => {
    const { startPartnered } = renderForm();
    fireEvent.change(screen.getByPlaceholderText(/Partner's name/i), {
      target: { value: "Jordan" },
    });
    fireEvent.click(btn(/^Add$/));
    expect(startPartnered).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Jordan" }),
    );
  });
});
