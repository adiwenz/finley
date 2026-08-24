/**
 * @vitest-environment jsdom
 *
 * The shared-expense split, as the household actually types it.
 *
 * Two fields holding ONE value. The pair can never be left in a state that does not add up,
 * because neither field is independently editable: whichever one is touched, the other becomes
 * its complement. That is what makes "the percentages always sum to 100" a property of the
 * control rather than a rule to validate afterwards, and it is why there is no error state to
 * design — the household is never asked to do the subtraction and can never get it wrong.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useState } from "react";
import { enterNumber } from "../../testing/numberField";
import { DEFAULT_PARTNER_SHARE_PERCENT, SharedSplitFields } from "./sharedSplitFields";

afterEach(cleanup);

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;

/** The control wired to state the way a form wires it, so the complement is really re-rendered. */
function Harness({
  initial = DEFAULT_PARTNER_SHARE_PERCENT,
  onChange,
}: {
  readonly initial?: number;
  readonly onChange?: (percent: number) => void;
}) {
  const [percent, setPercent] = useState(initial);
  return (
    <SharedSplitFields
      primaryName="Alex"
      partnerName="Blake"
      partnerPercent={percent}
      onChange={(next) => {
        setPercent(next);
        onChange?.(next);
      }}
    />
  );
}

describe("SharedSplitFields", () => {
  it("opens every new partnership at 50/50", () => {
    render(<Harness />);
    expect(spin(/Alex/).value).toBe("50");
    expect(spin(/Blake/).value).toBe("50");
  });

  it("asks the question in the household's own words", () => {
    render(<Harness />);
    expect(screen.getByText(/How do you divide shared expenses\?/i)).toBeTruthy();
    expect(
      screen.getByText(/If one person can’t cover their share, the other may help/i),
    ).toBeTruthy();
  });

  it("updates the other percentage when either one is edited", () => {
    render(<Harness />);
    enterNumber(spin(/Blake/), "30");
    expect(spin(/Alex/).value).toBe("70");
    enterNumber(spin(/Alex/), "25");
    expect(spin(/Blake/).value).toBe("75");
  });

  it("always sums to 100, at every whole number either field can hold", () => {
    for (let typed = 0; typed <= 100; typed++) {
      cleanup();
      render(<Harness />);
      enterNumber(spin(/Blake/), String(typed));
      expect(Number(spin(/Alex/).value) + Number(spin(/Blake/).value)).toBe(100);
    }
  });

  it("takes 0/100 and 100/0 as ordinary answers", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    enterNumber(spin(/Blake/), "0");
    expect(spin(/Alex/).value).toBe("100");
    expect(onChange).toHaveBeenLastCalledWith(0);
    enterNumber(spin(/Blake/), "100");
    expect(spin(/Alex/).value).toBe("0");
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it("clamps a percentage there is no room for, and says it did", () => {
    // Consistent with the engine, which refuses anything outside 0–100 outright: the two together
    // mean a figure past the ends is never quietly recorded, wherever it was entered.
    render(<Harness />);
    enterNumber(spin(/Blake/), "130");
    expect(spin(/Blake/).value).toBe("100");
    expect(spin(/Alex/).value).toBe("0");
    expect(screen.getByText(/130/)).toBeTruthy();
  });

  it("names the partner before they have a name", () => {
    render(
      <SharedSplitFields primaryName="Alex" partnerName="  " partnerPercent={50} onChange={vi.fn()} />,
    );
    expect(spin(/Partner/).value).toBe("50");
  });
});
