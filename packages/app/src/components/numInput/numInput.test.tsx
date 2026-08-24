/**
 * @vitest-environment jsdom
 *
 * What a number field SHOWS, and when what it holds becomes a fact.
 *
 * Two separate contracts meet here, and both had a hole in them. A figure is committed on leaving
 * the field, which had been read as the focus change — but a button need not take focus when it is
 * clicked, so "type the last number, click Save" left the figure uncommitted and the form wrote the
 * value from before the edit. And the committed value was printed raw, so an APR that had made one
 * round trip through binary floating point came back to the user as 7.000000000000001.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NumInput } from "./numInput";

afterEach(cleanup);

const spin = () => screen.getByRole("spinbutton") as HTMLInputElement;

/** A field wired to state the way a panel wires it, with a button that does not take focus. */
function Harness({
  initial = 0,
  onCommit,
}: {
  readonly initial?: number;
  readonly onCommit?: (v: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <NumInput
        label="APR"
        value={value}
        onChange={(v) => {
          setValue(v);
          onCommit?.(v);
        }}
        suffix="%"
      />
      <button onClick={() => screen.getByTestId("seen").setAttribute("data-v", String(value))}>
        Save
      </button>
      <span data-testid="seen" />
    </div>
  );
}

describe("NumInput — leaving the field is a pointer gesture, not a focus change", () => {
  it("commits a typed figure when the pointer goes down anywhere else", () => {
    const onCommit = vi.fn();
    render(<Harness initial={5} onCommit={onCommit} />);
    const field = spin();
    field.focus();
    fireEvent.change(field, { target: { value: "9" } });
    // Not committed yet: the field still has it, and nothing downstream has heard.
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByText("Save"));
    expect(onCommit).toHaveBeenCalledWith(9);
  });

  it("commits before the click, so a button acting on the form sees the typed figure", () => {
    render(<Harness initial={5} />);
    const field = spin();
    field.focus();
    fireEvent.change(field, { target: { value: "9" } });
    const save = screen.getByText("Save");
    fireEvent.pointerDown(save);
    fireEvent.click(save);
    // What the click read, not what the field ended up showing afterwards.
    expect(screen.getByTestId("seen").getAttribute("data-v")).toBe("9");
  });

  it("does not commit for a pointer landing inside its own field", () => {
    // Clicking one's own spinner, or repositioning the caret, is not leaving.
    const onCommit = vi.fn();
    render(<Harness initial={5} onCommit={onCommit} />);
    const field = spin();
    field.focus();
    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.pointerDown(field);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("stays quiet when there is nothing uncommitted to flush", () => {
    const onCommit = vi.fn();
    render(<Harness initial={5} onCommit={onCommit} />);
    fireEvent.pointerDown(screen.getByText("Save"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("still discards an abandoned edit rather than writing a figure nobody typed", () => {
    const onCommit = vi.fn();
    render(<Harness initial={5} onCommit={onCommit} />);
    const field = spin();
    field.focus();
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.pointerDown(screen.getByText("Save"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(field.value).toBe("5");
  });
});

describe("NumInput — what the field prints", () => {
  it("does not print floating-point noise", () => {
    // The exact figure a rate comes back as after one round trip through the plan.
    render(<Harness initial={7.000000000000001} />);
    expect(spin().value).toBe("7");
  });

  it("keeps a decimal the user would actually enter", () => {
    render(<Harness initial={6.375} />);
    expect(spin().value).toBe("6.375");
  });

  it("keeps a figure large enough to be money, to the cent", () => {
    render(<Harness initial={1_234_567.89} />);
    expect(spin().value).toBe("1234567.89");
  });

  it("shows a half-typed edit exactly as typed, noise rules and all", () => {
    // The draft is the user's; trimming it mid-entry is what makes a controlled field fight back.
    render(<Harness initial={7} />);
    fireEvent.change(spin(), { target: { value: "7.10" } });
    expect(spin().value).toBe("7.10");
  });
});
