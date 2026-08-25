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

  it("clamps a figure past 100 on the keystroke, and says it did", () => {
    // Waiting for the blur showed 150 beside a complement of 0 — a split summing to 150. There is
    // no in-range figure 150 is on its way to, so there is nothing to protect by waiting.
    render(<Harness initial={30} />);
    type(spin(/Blake/), "150");
    expect(spin(/Blake/).value).toBe("100");
    expect(spin(/Alex/).value).toBe("0");
    sums100();
    expect(screen.getByText(/150/)).toBeTruthy();
  });

  it("holds a negative figure while it is being typed, and bounds it on the way out", () => {
    // The other direction is NOT the same, and treating it as such mangled the typing: "-10"
    // went "-", then "-1" snapped to 0, then the next keystroke landed on that 0 to give "00".
    // 150 is on its way to nothing; every negative is a prefix of a figure still being entered,
    // so it stands as typed and the pair reports itself unfinished until the field is left.
    render(<Harness initial={30} />);
    type(spin(/Blake/), "-5");
    expect(spin(/Blake/).value).toBe("-5");
    expect(screen.getByText(/add up to 100/)).toBeTruthy();

    fireEvent.blur(spin(/Blake/));
    expect(spin(/Blake/).value).toBe("0");
    expect(spin(/Alex/).value).toBe("100");
    sums100();
    expect(screen.getByText(/-5/)).toBeTruthy();
  });

  it("takes a negative typed one character at a time without mangling it", () => {
    // The reported transient, keystroke by keystroke: "-10" must never read back as "00".
    render(<Harness initial={30} />);
    // A lone "-" is not a number, and a number input reports it as nothing at all — that is the
    // DOM's own answer, and it is the one keystroke the field never had trouble with.
    type(spin(/Blake/), "-");
    expect(spin(/Blake/).value).toBe("");
    for (const typed of ["-1", "-10"]) {
      type(spin(/Blake/), typed);
      expect(spin(/Blake/).value).toBe(typed);
    }
    fireEvent.blur(spin(/Blake/));
    expect(spin(/Blake/).value).toBe("0");
    sums100();
  });

  it("clamps a figure in exponent notation, which a number field accepts", () => {
    // `1e5` is one keystroke past `1e`, and a number input hands it over as a whole 100000.
    render(<Harness initial={30} />);
    type(spin(/Blake/), "1e5");
    expect(spin(/Blake/).value).toBe("100");
    expect(spin(/Alex/).value).toBe("0");
    sums100();
  });

  it("leaves the clamp standing through the blur that follows it", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "150");
    fireEvent.blur(spin(/Blake/));
    expect(spin(/Blake/).value).toBe("100");
    expect(spin(/Alex/).value).toBe("0");
    expect(screen.getByText(/150/)).toBeTruthy();
  });

  it("clears the field, then takes the next figure typed into it whole", () => {
    // Emptying is not an answer and clamps to nothing; the figure that replaces it is.
    render(<Harness initial={30} />);
    type(spin(/Blake/), "");
    expect(spin(/Blake/).value).toBe("");
    expect(screen.queryByText(/isn't allowed here/)).toBeNull();
    type(spin(/Blake/), "65");
    expect(spin(/Blake/).value).toBe("65");
    expect(spin(/Alex/).value).toBe("35");
    sums100();
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

/**
 * The pair holds through the clamp.
 *
 * A clamped field used to keep the bounded figure as its own uncommitted text, which is a copy of
 * a value it had just handed away. The copy went stale the moment the other half was edited: the
 * clamped side stayed pinned at 100 while its partner moved to 70, showing a 170% split that no
 * further typing could talk back down, because every keystroke in the other field only ever moved
 * the value the pinned field was no longer reading.
 */
describe("SharedSplitFields — after a figure has been clamped", () => {
  const type = (field: HTMLElement, value: string) =>
    fireEvent.change(field, { target: { value } });
  const sums100 = () => expect(Number(spin(/Alex/).value) + Number(spin(/Blake/).value)).toBe(100);

  it("keeps editing the other field after the partner's share was clamped", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "150");
    expect(spin(/Blake/).value).toBe("100");
    // The gesture that used to freeze the pair: straight into the other field, no blur between.
    type(spin(/Alex/), "70");
    expect(spin(/Blake/).value).toBe("30");
    sums100();
    type(spin(/Alex/), "60");
    expect(spin(/Blake/).value).toBe("40");
    sums100();
  });

  it("keeps editing the other field after the primary's share was clamped", () => {
    // The same field, reached from the other side — neither half is the special one.
    render(<Harness initial={30} />);
    type(spin(/Alex/), "200");
    expect(spin(/Alex/).value).toBe("100");
    expect(spin(/Blake/).value).toBe("0");
    type(spin(/Blake/), "35");
    expect(spin(/Alex/).value).toBe("65");
    sums100();
  });

  it("clamps the primary's field the way it clamps the partner's", () => {
    render(<Harness initial={30} />);
    type(spin(/Alex/), "150");
    expect(spin(/Alex/).value).toBe("100");
    expect(spin(/Blake/).value).toBe("0");
    sums100();
    expect(screen.getByText(/150/)).toBeTruthy();
  });

  it("survives alternating edits that each clamp, in either direction", () => {
    render(<Harness initial={30} />);
    for (const [field, typed] of [
      [/Blake/, "150"],
      [/Alex/, "120"],
      [/Blake/, "1e5"],
      [/Alex/, "200"],
    ] as const) {
      type(spin(field), typed);
      sums100();
    }
    // Ends where the last gesture put it, not where the first clamp pinned a field.
    expect(spin(/Alex/).value).toBe("100");
    expect(spin(/Blake/).value).toBe("0");
  });
});

/**
 * The one thing the pair cannot say.
 *
 * An emptied field is not 0% — it is on the way to a figure. There is no complement to show for
 * it, so for that moment the control is not displaying a split at all, and the percentage still
 * behind it is the one the user has begun to replace. Saving then wrote a figure nobody was
 * looking at, so the form is told and refuses.
 */
describe("SharedSplitFields — a share the user has emptied", () => {
  const type = (field: HTMLElement, value: string) =>
    fireEvent.change(field, { target: { value } });

  /** The control wired the way a form wires it, Save and all. */
  function SaveHarness({ initial = 30 }: { readonly initial?: number }) {
    const [percent, setPercent] = useState(initial);
    const [incomplete, setIncomplete] = useState(false);
    const [saved, setSaved] = useState<number | null>(null);
    return (
      <>
        <SharedSplitFields
          primaryName="Alex"
          partnerName="Blake"
          partnerPercent={percent}
          onChange={setPercent}
          onIncompleteChange={setIncomplete}
        />
        <button disabled={incomplete} onClick={() => setSaved(percent)}>
          Save
        </button>
        <span data-testid="saved">{saved === null ? "—" : String(saved)}</span>
      </>
    );
  }
  const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

  it("refuses to save while a share is empty", () => {
    render(<SaveHarness />);
    expect(save().disabled).toBe(false);
    type(spin(/Blake/), "");
    expect(save().disabled).toBe(true);
    // Clicking anyway writes nothing — the percentage behind the blank is not the answer.
    fireEvent.click(save());
    expect(screen.getByTestId("saved").textContent).toBe("—");
  });

  it("says which share it is waiting for", () => {
    render(<SaveHarness />);
    type(spin(/Blake/), "");
    expect(screen.getByText(/Enter a percentage for Blake/)).toBeTruthy();
    type(spin(/Blake/), "65");
    expect(screen.queryByText(/Enter a percentage for/)).toBeNull();
    // Named for whichever half is blank, not for the partner by default.
    type(spin(/Alex/), "");
    expect(screen.getByText(/Enter a percentage for Alex/)).toBeTruthy();
  });

  it("refuses while a half-typed figure is all there is", () => {
    render(<SaveHarness />);
    type(spin(/Blake/), "-");
    expect(save().disabled).toBe(true);
  });

  it("saves again once the field is filled, and saves what is on screen", () => {
    render(<SaveHarness />);
    type(spin(/Blake/), "");
    type(spin(/Blake/), "65");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(screen.getByTestId("saved").textContent).toBe("65");
  });

  it("saves again once an abandoned edit is left, restoring what was there", () => {
    // Blanking then leaving the field is not an answer either; the committed split stands.
    render(<SaveHarness />);
    type(spin(/Blake/), "");
    fireEvent.blur(spin(/Blake/));
    expect(save().disabled).toBe(false);
    expect(spin(/Blake/).value).toBe("30");
    fireEvent.click(save());
    expect(screen.getByTestId("saved").textContent).toBe("30");
  });

  it("lets Save through again, without going back to the field that was cleared", () => {
    // Blanking a half is a legitimate first move in retyping it, and the other half is a complete
    // answer on its own — it names both shares. So typing there is a way out of the blank state,
    // and it was not treated as one: Save stayed refused until the cleared field was retyped.
    render(<SaveHarness initial={30} />);
    type(spin(/Alex/), "");
    expect(save().disabled).toBe(true);
    type(spin(/Blake/), "45");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(screen.getByTestId("saved").textContent).toBe("45");
  });

  it("still refuses while the half being typed is itself unusable", () => {
    // "-" is not an answer to either share, so it cannot refill the other one.
    render(<SaveHarness initial={30} />);
    type(spin(/Alex/), "");
    type(spin(/Blake/), "-");
    expect(save().disabled).toBe(true);
  });
});

/**
 * An emptied half is refilled by typing in the other one.
 *
 * Blanking a field is a legitimate first move in retyping it, and the pair correctly refuses to
 * save while it is showing a figure and a gap. But the other half is a complete answer on its own —
 * it names both shares — so typing there was a way out of the blank state and was not treated as
 * one: the emptied field stayed empty, Save stayed refused, and the only remaining fix was to go
 * back and retype the field the user had deliberately cleared.
 */
describe("SharedSplitFields — refilling an emptied half from the other one", () => {
  const type = (field: HTMLElement, value: string) =>
    fireEvent.change(field, { target: { value } });

  it("refills the primary's share when the partner's is typed", () => {
    render(<Harness initial={30} />);
    type(spin(/Alex/), "");
    expect(spin(/Alex/).value).toBe("");
    type(spin(/Blake/), "40");
    expect(spin(/Alex/).value).toBe("60");
    expect(Number(spin(/Alex/).value) + Number(spin(/Blake/).value)).toBe(100);
  });

  it("refills the partner's share when the primary's is typed", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "");
    type(spin(/Alex/), "25");
    expect(spin(/Blake/).value).toBe("75");
  });
});

/**
 * A clamp note is about the field it happened in, and only for as long as that field still holds
 * the figure the clamp produced.
 *
 * Neither was true. A note was raised at the keystroke and cleared only by another keystroke in
 * the SAME field — so correcting the split from the other half (which is the whole point of a pair
 * that always sums to 100) left "250% isn't allowed here" standing over a field now reading 30,
 * and clamping each half in turn put two notes on screen at once, describing two figures the
 * control no longer had between them.
 */
describe("SharedSplitFields — how long a clamp note stands", () => {
  const type = (field: HTMLElement, value: string) =>
    fireEvent.change(field, { target: { value } });
  const notes = () => screen.queryAllByText(/isn't allowed here/);

  it("clears the note when the field is corrected from its complement", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "250");
    expect(notes()).toHaveLength(1);

    // Nothing is typed into Blake's field again; the correction arrives as its complement.
    type(spin(/Alex/), "70");
    expect(spin(/Blake/).value).toBe("30");
    expect(notes()).toHaveLength(0);
  });

  it("clears the note when the same field is retyped", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "250");
    expect(notes()).toHaveLength(1);
    type(spin(/Blake/), "40");
    expect(notes()).toHaveLength(0);
  });

  it("never shows two notes at once, however many clamps in a row", () => {
    render(<Harness initial={30} />);
    type(spin(/Blake/), "250");
    type(spin(/Alex/), "180");
    expect(notes()).toHaveLength(1);
    type(spin(/Blake/), "999");
    expect(notes()).toHaveLength(1);
    expect(screen.getByText(/999/)).toBeTruthy();
  });

  it("keeps the note while the clamped figure is what the field still holds", () => {
    // The clamp's own arrival must not be mistaken for a correction from elsewhere — the value
    // does change (that is the clamp landing), and the note has to survive it.
    render(<Harness initial={30} />);
    type(spin(/Blake/), "250");
    fireEvent.blur(spin(/Blake/));
    expect(spin(/Blake/).value).toBe("100");
    expect(notes()).toHaveLength(1);
  });
});
