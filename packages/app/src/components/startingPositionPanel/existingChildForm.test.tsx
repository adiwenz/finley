/**
 * @vitest-environment jsdom
 *
 * ExistingChildForm — a child already born at plan start. Pins that the form hands
 * `haveExistingChild` an age (not a birth month), converting years to months and dollars to
 * cents at submit.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Projection } from "@finley/engine";
import { ExistingChildForm } from "./existingChildForm";

afterEach(cleanup);

function renderForm() {
  const haveExistingChild = vi.fn();
  const onDone = vi.fn();
  const onAdd = (write: (p: Projection) => void) =>
    write({ haveExistingChild } as unknown as Projection);
  render(<ExistingChildForm onAdd={onAdd} onDone={onDone} />);
  return { haveExistingChild, onDone };
}

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("ExistingChildForm", () => {
  it("authors a child anchored on age, carrying the edited name and cost", () => {
    const { haveExistingChild, onDone } = renderForm();
    fireEvent.change(screen.getByPlaceholderText(/Child's name/i), {
      target: { value: "Robin" },
    });
    fireEvent.change(spin(/Age today/i), { target: { value: "7" } });
    fireEvent.change(spin(/Annual cost/i), { target: { value: "20000" } });
    fireEvent.click(btn(/^Add$/));

    expect(haveExistingChild).toHaveBeenCalledWith({
      name: "Robin",
      ageMonths: 84,
      annualCostCents: 20_000 * 100,
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("defaults an unnamed child", () => {
    const { haveExistingChild } = renderForm();
    fireEvent.click(btn(/^Add$/));
    expect(haveExistingChild).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Child" }),
    );
  });
});
