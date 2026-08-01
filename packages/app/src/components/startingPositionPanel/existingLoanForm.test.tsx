/**
 * @vitest-environment jsdom
 *
 * ExistingLoanForm — a debt already carried at plan start. Pins that the form hands
 * `carryLoan` a remaining term (not an origination term), and that `kind` gates the term
 * field exactly as {@link LoanForm} gates it for a fresh loan — a credit card is revolving
 * and carries a credit limit instead.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Projection } from "@finley/engine";
import { ExistingLoanForm } from "./existingLoanForm";

afterEach(cleanup);

function renderForm() {
  const carryLoan = vi.fn();
  const onDone = vi.fn();
  const onAdd = (write: (p: Projection) => void) => write({ carryLoan } as unknown as Projection);
  render(<ExistingLoanForm onAdd={onAdd} onDone={onDone} />);
  return { carryLoan, onDone };
}

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("ExistingLoanForm", () => {
  it("carries an amortizing loan at its remaining term, converting dollars and APR", () => {
    const { carryLoan, onDone } = renderForm();
    fireEvent.change(spin(/Balance today/i), { target: { value: "12000" } });
    fireEvent.change(spin(/APR/i), { target: { value: "7.5" } });
    fireEvent.change(spin(/Term remaining/i), { target: { value: "4" } });
    fireEvent.click(btn(/^Add$/));

    expect(carryLoan).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auto",
        balanceCents: 12_000 * 100,
        apr: 0.075,
        remainingTermMonths: 48,
      }),
    );
    expect(carryLoan.mock.calls[0][0]).not.toHaveProperty("creditLimitCents");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("drops the term field for a credit card and carries a credit limit instead", () => {
    renderForm();
    fireEvent.change(screen.getByRole("combobox", { name: /Type/i }), {
      target: { value: "creditCard" },
    });
    expect(screen.queryByRole("spinbutton", { name: /Term remaining/i })).toBeNull();
  });

  it("carries a credit card on its balance, with no term", () => {
    const { carryLoan } = renderForm();
    fireEvent.change(screen.getByRole("combobox", { name: /Type/i }), {
      target: { value: "creditCard" },
    });
    fireEvent.change(spin(/Balance today/i), { target: { value: "3000" } });
    fireEvent.click(btn(/^Add$/));

    const input = carryLoan.mock.calls[0][0];
    expect(input).toMatchObject({ kind: "creditCard", balanceCents: 3_000 * 100 });
    expect(input).toHaveProperty("creditLimitCents", 6_000 * 100);
    expect(input).not.toHaveProperty("remainingTermMonths");
  });
});
