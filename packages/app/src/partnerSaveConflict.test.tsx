/**
 * @vitest-environment jsdom
 *
 * A Save that cannot work says so, on the control that cannot work.
 *
 * Shortening a partner's life expectancy past something the plan already depends on — a job that
 * runs to a year they would no longer reach — is refused by the engine, and the refusal used to
 * arrive only after the click: the panel stayed open on the figure that had just been typed, the
 * button appeared to do nothing, and the explanation landed as a banner in the other column, next
 * to a chart rather than next to the field that caused it.
 *
 * The engine's own sentence names the year, the job and the person, so it is what gets shown. This
 * is the pattern the timeline's blocked Remove already uses: ask before the click, disable the
 * control, and print the reason beside it.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { enterNumber } from "./testing/numberField";
import { App } from "./main";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

/**
 * Open the partnering on a two-earner scenario for editing, with the Advanced section expanded —
 * `<details>` does not open itself under a synthetic click, and the expectancy field lives inside.
 */
function openPartnerEdit(): void {
  render(<App />);
  fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
    target: { value: "partner-even-split" },
  });
  fireEvent.click(screen.getAllByText("Edit")[0]);
  for (const details of document.querySelectorAll("details")) details.open = true;
}

const save = () => screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
const expectancy = () => screen.getByRole("spinbutton", { name: /Their life expectancy/i });

describe("a partner's life expectancy that the plan cannot take", () => {
  it("blocks Save and names what the figure collides with", () => {
    openPartnerEdit();
    expect(save().disabled).toBe(false);

    // Blake's job runs to 2056. An expectancy that has them gone before it ends is a job outliving
    // its owner, which the engine refuses outright.
    enterNumber(expectancy(), 60);

    expect(save().disabled).toBe(true);
    const note = screen.getByText(/a job must end while its owner is alive/);
    // Named, not merely refused: one sentence carrying the year the job runs to and whose it is.
    expect(note.textContent).toMatch(/2056/);
    expect(note.textContent).toMatch(/Blake/);
  });

  it("blocks it below the age their benefit is claimed at, on the same grounds", () => {
    // Blake claims at 67 — the same year their job ends — so an expectancy under the claiming age
    // is also one under the job's end. The block is stated once, by whichever fact it is that the
    // engine cannot reconcile.
    openPartnerEdit();
    enterNumber(expectancy(), 66);
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/must end while its owner is alive/)).toBeTruthy();
  });

  it("lets a valid figure through, and closes the panel on it", () => {
    openPartnerEdit();
    enterNumber(expectancy(), 60);
    expect(save().disabled).toBe(true);

    // Correcting the figure releases the button — the block belongs to the value, not to the form.
    enterNumber(expectancy(), 92);
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(/must end while its owner is alive/)).toBeNull();

    fireEvent.pointerDown(save());
    fireEvent.click(save());
    // The edit surface gives way to the add form again, which is what committing looks like.
    expect(screen.queryByText("Save changes")).toBeNull();
  });

  it("keeps the figure that was typed while the block stands", () => {
    // A refused Save must not also lose the edit: the number stays on screen to be corrected.
    openPartnerEdit();
    enterNumber(expectancy(), 60);
    fireEvent.pointerDown(save());
    fireEvent.click(save());
    expect((expectancy() as HTMLInputElement).value).toBe("60");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });
});
