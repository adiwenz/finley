/**
 * @vitest-environment jsdom
 *
 * The owner picker on the Add Job form, in isolation: switching "Whose job?" re-reads the whole
 * form against the new owner's clock. See {@link JobFormOwner.currentAge} for why — a start age
 * left over from the previous owner silently reinterprets the job as historical or future
 * employment nobody typed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dollarsToCents } from "@finley/engine";

import { enterNumber } from "../../testing/numberField";
import type { NewJobDraft } from "../../planPeople";
import { JobForm, type JobFormOwner } from "./jobForm";

afterEach(cleanup);

/** Younger, first in the list — the primary person, and the picker's default. */
const YOUNGER: JobFormOwner = { id: "primary", name: "Alex", currentAge: 35, lifeExpectancy: 90 };
/** Older, second in the list — a partner. */
const OLDER: JobFormOwner = { id: "p-1", name: "Sam", currentAge: 40, lifeExpectancy: 85 };

const spin = (label: RegExp | string) => screen.getByRole("spinbutton", { name: label }) as HTMLInputElement;

function renderForm(owners: readonly JobFormOwner[], initial: NewJobDraft) {
  const onSubmit = vi.fn();
  render(
    <JobForm
      ownership="choose"
      initial={initial}
      owners={owners}
      currentAge={owners[0]!.currentAge}
      lifeExpectancy={owners[0]!.lifeExpectancy}
      submitLabel="Add"
      onCancel={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

const blankDraft = (ownerId: string, currentAge: number): NewJobDraft => ({
  ownerId,
  name: "",
  monthlyCents: dollarsToCents(3_000),
  startingMonthlyCents: dollarsToCents(3_000),
  startAge: currentAge,
  endAge: 65,
  realGrowthPct: 0,
  deferralPct: 0,
  employerMatchPct: 0,
});

describe("JobForm — the owner picker resets start age", () => {
  it("switching to an OLDER owner resets start age to their current age", () => {
    renderForm([YOUNGER, OLDER], blankDraft(YOUNGER.id, YOUNGER.currentAge));
    expect(spin(/Start age/).value).toBe("35");

    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: OLDER.id } });

    expect(spin(/Start age/).value).toBe("40");
  });

  it("switching to a YOUNGER owner resets start age to their current age", () => {
    renderForm([YOUNGER, OLDER], blankDraft(OLDER.id, OLDER.currentAge));
    expect(spin(/Start age/).value).toBe("40");

    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: YOUNGER.id } });

    expect(spin(/Start age/).value).toBe("35");
  });

  it("resets a MANUALLY EDITED start age too, discarding the previous owner's value", () => {
    renderForm([YOUNGER, OLDER], blankDraft(YOUNGER.id, YOUNGER.currentAge));
    enterNumber(spin(/Start age/), 20); // the user backdates the primary person's job
    expect(spin(/Start age/).value).toBe("20");

    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: OLDER.id } });

    // The hand-typed 20 does not survive the owner change — it reads as Sam's history otherwise.
    expect(spin(/Start age/).value).toBe("40");
  });

  it("submits the new owner's current age as start age, not the previous owner's", () => {
    const onSubmit = renderForm([YOUNGER, OLDER], blankDraft(YOUNGER.id, YOUNGER.currentAge));

    fireEvent.change(screen.getByLabelText("Whose job"), { target: { value: OLDER.id } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OLDER.id, startAge: 40 }));
  });
});
