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
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

/**
 * The complement follows the keystroke.
 *
 * Waiting for the field to be left is what put 0/30 on screen on the way from 70/30 to 0/100 — a
 * pair that sums to 30, shown to someone who has not done anything wrong and cannot tell which
 * half the plan would take. These fields are the one place a number is not a fact about the plan
 * but half of a pair, so the pair is kept whole while it is being typed, and anything the commit
 * would refuse is still left to the commit to refuse and explain.
 */
describe("SharedSplitFields — while the household is still typing", () => {
  /** Type into a field WITHOUT leaving it — the half-gesture `enterNumber` completes. */
  const type = (field: HTMLElement, value: string) =>
    fireEvent.change(field, { target: { value } });

  const sums100 = () => expect(Number(spin(/Alex/).value) + Number(spin(/Blake/).value)).toBe(100);

  it("moves the partner's share as the primary's is typed", () => {
    render(<Harness initial={30} />);
    type(spin(/Alex/), "65");
    expect(spin(/Blake/).value).toBe("35");
    sums100();
  });

  it("moves the primary's share as the partner's is typed", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "35");
    expect(spin(/Alex/).value).toBe("65");
    sums100();
  });

  it("takes the primary to 0 and the partner to 100, with no blur in between", () => {
    render(<Harness initial={30} />);
    type(spin(/Alex/), "0");
    expect(spin(/Blake/).value).toBe("100");
    sums100();
  });

  it("takes the partner to 0 and the primary to 100", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "0");
    expect(spin(/Alex/).value).toBe("100");
    sums100();
  });

  it("persists what was typed when the form is saved without the field losing focus", () => {
    // The gesture that used to lose the edit: type, then click straight through to the button.
    const onChange = vi.fn();
    render(<Harness initial={50} onChange={onChange} />);
    type(spin(/Blake/), "35");
    expect(onChange).toHaveBeenLastCalledWith(35);
  });

  it("leaves a figure past 100 to the commit, which clamps it and says so", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "130");
    // Nothing moved on the keystroke: 130 is not an answer, and 100/-30 is not a split.
    expect(spin(/Alex/).value).toBe("70");
    fireEvent.blur(spin(/Blake/));
    expect(spin(/Blake/).value).toBe("100");
    expect(spin(/Alex/).value).toBe("0");
    expect(screen.getByText(/130/)).toBeTruthy();
  });

  it("leaves a negative figure to the commit in the same way", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "-5");
    expect(spin(/Alex/).value).toBe("70");
    fireEvent.blur(spin(/Blake/));
    expect(spin(/Blake/).value).toBe("0");
    expect(spin(/Alex/).value).toBe("100");
    expect(screen.getByText(/-5/)).toBeTruthy();
  });

  it("does not read an emptied field as 0%", () => {
    // Blanking a field is on the way to typing something, not an answer of its own. The split
    // stands until a figure replaces it, and abandoning the edit restores what was there.
    render(<Harness initial={30} />);
    type(spin(/Blake/), "");
    expect(spin(/Alex/).value).toBe("70");
    fireEvent.blur(spin(/Blake/));
    expect(spin(/Blake/).value).toBe("30");
  });

  it("does not read a half-typed figure as an answer", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "-");
    expect(spin(/Alex/).value).toBe("70");
  });

  it("keeps the pair at 100 through every keystroke of a multi-digit figure", () => {
    // "6" then "65": both are answers, and both must leave the pair whole.
    render(<Harness initial={30} />);
    type(spin(/Blake/), "6");
    sums100();
    type(spin(/Blake/), "65");
    sums100();
    expect(spin(/Alex/).value).toBe("35");
  });
});
