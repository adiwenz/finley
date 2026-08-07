/**
 * @vitest-environment jsdom
 *
 * RelationshipForm — a partner joins the household. Pins that a partner can be authored WITH
 * their own jobs (the same job model the primary earner uses), scoped to them, and that a
 * partner with no jobs joins as before, leaving single-earner plans unchanged.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import type { Projection, RelationshipEvent } from "@finley/engine";
import { RelationshipForm } from "./relationshipForm";

afterEach(cleanup);

/** A partner already on the timeline, to seed the form's edit mode. Joins in 2028 (month 24). */
const EXISTING: RelationshipEvent = {
  type: "RelationshipEvent",
  id: "rel-1",
  sequenceNumber: 3,
  month: 24,
  person: {
    id: "p2",
    name: "Sam",
    birthYear: 1988,
    lifeExpectancy: 85,
    benefitClaimingAge: 68,
    jobs: [],
  },
};

/**
 * Renders the form in edit mode over {@link EXISTING}, returning the `reviseTransaction` spy.
 * An edit revises the event in place, so a test asserts the `(id, revision)` pair it submits.
 */
function renderEdit(event: RelationshipEvent = EXISTING) {
  const reviseTransaction = vi.fn();
  const onRevise = (write: (p: Projection) => void) =>
    write({ reviseTransaction } as unknown as Projection);
  render(
    <RelationshipForm
      defaultMonth={0}
      horizonMonths={600}
      onAdd={() => {}}
      edit={{ event, onRevise }}
    />,
  );
  return reviseTransaction;
}

/**
 * Renders the form wired to a stub {@link Projection}, returning the `marry` spy. The form
 * authors through the facade, so a test asserts the {@link MarryInput} it builds — the partner
 * arrives with jobs as inputs (no id, no owner: `marry` mints and stamps those).
 */
function renderForm(defaultMonth = 0) {
  const marry = vi.fn();
  const onAdd = (write: (p: Projection) => void) =>
    write({ marry } as unknown as Projection);
  render(<RelationshipForm defaultMonth={defaultMonth} horizonMonths={600} onAdd={onAdd} />);
  return marry;
}

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("RelationshipForm — partner jobs", () => {
  it("a partner joins with no jobs by default (unchanged behavior)", () => {
    const marry = renderForm();
    fireEvent.click(btn(/Add event/i));
    expect(marry).toHaveBeenCalledTimes(1);
    expect(marry.mock.calls[0][0].jobs).toEqual([]);
  });

  it("authors a job for the partner, handed to the facade to id and own", () => {
    const marry = renderForm();
    fireEvent.click(btn(/Add a job/i));
    enterNumber(spin(/Monthly salary/i), "2000");
    fireEvent.click(btn(/^Add$/)); // the JobForm's own submit
    fireEvent.click(btn(/Add event/i));
    const input = marry.mock.calls[0][0];
    expect(input.jobs).toHaveLength(1);
    const job = input.jobs[0];
    expect(job.salary.startingSalaryCents).toBe(2000 * 12 * 100);
    // The job arrives as an input: `marry` mints its id and stamps the partner as owner, so
    // the form invents neither.
    expect(job).not.toHaveProperty("id");
    expect(job).not.toHaveProperty("ownerId");
  });

  // The floor under "Their life expectancy" is the partner's OWN age. It used to be
  // `Math.max(60, age)`, so a partner entered at 40 could not be projected to anything under 60
  // — a number nobody typed, on a field that gave no reason for refusing what they did type.
  describe("the life-expectancy floor is the partner's own age", () => {
    it("lets a 40-year-old partner be projected to 41", () => {
      const marry = renderForm();
      enterNumber(spin(/Their age/i), "40");
      const expectancy = spin(/Their life expectancy/i);
      expect(Number(expectancy.min)).toBe(41);

      enterNumber(expectancy, "41");
      fireEvent.click(btn(/Add event/i));
      expect(marry.mock.calls[0][0].lifeExpectancy).toBe(41);
    });

    it("clamps only AT their age, which is the engine's own boundary", () => {
      // An expectancy equal to the age they already are is the month-0 death `invalidAge`
      // rejects, so the field stops one past it rather than committing a refused write.
      const marry = renderForm();
      enterNumber(spin(/Their age/i), "40");
      enterNumber(spin(/Their life expectancy/i), "40");
      fireEvent.click(btn(/Add event/i));
      expect(marry.mock.calls[0][0].lifeExpectancy).toBe(41);
    });

    it("follows the age field rather than being fixed at render", () => {
      renderForm();
      enterNumber(spin(/Their age/i), "76");
      expect(Number(spin(/Their life expectancy/i).min)).toBe(77);
    });

    it("bounds an EDIT by the partner's age today, not by a fixed floor", () => {
      // Sam is born 1988 and joins in 2028, so the form reads their age in the join year (40).
      renderEdit();
      expect(Number(spin(/Their life expectancy/i).min)).toBe(41);
    });
  });

  it("takes the partner's age at the year they join, and stores it as their birth year", () => {
    // The user thinks in an age; the engine reasons in a birth year, which drives when
    // their jobs stop and their benefit starts.
    const marry = renderForm(60); // joining in Year 5 → 2031
    expect(spin(/Their age in 2031/i)).toBeTruthy();
    enterNumber(spin(/Their age/i), "45");
    fireEvent.click(btn(/Add event/i));
    expect(marry.mock.calls[0][0].birthYear).toBe(2031 - 45);
  });

  it("defaults to a generic adult, anchored to today when they join now", () => {
    const marry = renderForm(0);
    expect(spin(/Their age in 2026/i)).toBeTruthy();
    fireEvent.click(btn(/Add event/i));
    expect(marry.mock.calls[0][0].birthYear).toBe(2026 - 40);
  });

  it("resolves an authored job's ages against the partner's own birth year", () => {
    const marry = renderForm(0);
    enterNumber(spin(/Their age/i), "30");
    fireEvent.click(btn(/Add a job/i));
    // A fresh job is seeded at the age they join.
    expect(Number(spin(/Start age/i).value)).toBe(30);
    enterNumber(spin(/Start age/i), "22");
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Add event/i));

    const input = marry.mock.calls[0][0];
    expect(input.birthYear).toBe(2026 - 30);
    // Their age 22, not the primary earner's: eight years before "now".
    expect(input.jobs[0].startYear).toBe(2026 - 8);
  });

  it("takes their own claiming age, defaulting to 67", () => {
    const marry = renderForm(0);
    fireEvent.click(btn(/Add event/i));
    const input = marry.mock.calls[0][0];
    expect(input.benefitClaimingAge).toBe(67);
  });

  it("offers no retirement age of their own — their jobs say when they stop", () => {
    // There used to be a "Their retirement age" field, which ended their open-ended jobs. Every
    // job now states its own end, so a second age here could only contradict one of them.
    renderForm(0);
    expect(screen.queryByRole("spinbutton", { name: /Their retirement age/i })).toBeNull();
  });

  it("lets a partner who has already retired join — their own clock, not the household's", () => {
    // A 68-year-old who stopped working at 62 is a real scenario: they join with no job, or
    // with one whose authored end is already behind them.
    const marry = renderForm(0);
    enterNumber(spin(/Their age/i), "68");
    enterNumber(spin(/Their Social Security claiming age/i), "70");
    fireEvent.click(btn(/Add event/i));

    const input = marry.mock.calls[0][0];
    expect(input.birthYear).toBe(2026 - 68);
    expect(input.benefitClaimingAge).toBe(70);
  });

  it("authors several jobs and can remove one before adding the partner", () => {
    const marry = renderForm();
    fireEvent.click(btn(/Add a job/i));
    enterNumber(spin(/Monthly salary/i), "2000");
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Add a job/i));
    enterNumber(spin(/Monthly salary/i), "3000");
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Remove job 1/i));
    fireEvent.click(btn(/Add event/i));
    const input = marry.mock.calls[0][0];
    expect(input.jobs).toHaveLength(1);
    expect(input.jobs[0].salary.startingSalaryCents).toBe(3000 * 12 * 100);
  });
});

describe("RelationshipForm — editing an existing partner", () => {
  it("opens pre-filled from the event, in the age vocabulary it was authored in", () => {
    renderEdit();
    expect((screen.getByPlaceholderText(/Partner's name/i) as HTMLInputElement).value).toBe("Sam");
    // Age is read against the join year (2028), the same anchor the add form uses.
    expect(Number(spin(/Their age in 2028/i).value)).toBe(2028 - 1988);
    expect(Number(spin(/Their Social Security claiming age/i).value)).toBe(68);
  });

  it("submits a marry revision through reviseTransaction, keeping the event id", () => {
    const revise = renderEdit();
    fireEvent.click(btn(/Save changes/i));
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledWith("rel-1", {
      type: "marry",
      month: 24,
      name: "Sam",
      birthYear: 1988,
      // Seeded from the partner on the timeline and sent back unchanged — a revision is the only
      // way to edit an expectancy, since nothing defaults one.
      lifeExpectancy: 85,
      benefitClaimingAge: 68,
    });
  });

  it("re-derives the birth year when the corrected age changes", () => {
    const revise = renderEdit();
    enterNumber(spin(/Their age/i), "45");
    fireEvent.click(btn(/Save changes/i));
    // Same join year, new age → the engine's birth year shifts to match.
    expect(revise.mock.calls[0][1].birthYear).toBe(2028 - 45);
  });

  it("does not author jobs — a revision cannot touch them, so the section is absent", () => {
    renderEdit();
    expect(screen.queryByRole("button", { name: /Add a job/i })).toBeNull();
  });
});

/**
 * A partnering already behind us is an ANCHOR: dated at its true past month, which the plan's
 * year picker cannot reach. Editing one has to speak the terms it was authored in — how long you
 * have been together, and how old they are today — or the past becomes uneditable and the date
 * silently reads as Year 0.
 */
describe("RelationshipForm — editing a partner already in the household", () => {
  /** Together five years (month -60), 40 today. The Starting position form's own vocabulary. */
  const ANCHORED: RelationshipEvent = {
    ...EXISTING,
    month: -60,
    person: { ...EXISTING.person, birthYear: 2026 - 40 },
  };

  it("asks how long you have been together, not for a year on the timeline", () => {
    renderEdit(ANCHORED);
    expect(screen.queryByRole("combobox", { name: /When/i })).toBeNull();
    expect(Number(spin(/Together for/i).value)).toBe(5);
    // Their age is read against today, because they are already here.
    expect(Number(spin(/Their age today/i).value)).toBe(40);
  });

  it("moves the anniversary further into the past, leaving their age today alone", () => {
    const revise = renderEdit(ANCHORED);
    enterNumber(spin(/Together for/i), "8");
    fireEvent.click(btn(/Save changes/i));
    expect(revise.mock.calls[0][1]).toMatchObject({ type: "marry", month: -96, birthYear: 2026 - 40 });
  });

  it("re-derives the birth year from their age today, not from the year they got together", () => {
    const revise = renderEdit(ANCHORED);
    enterNumber(spin(/Their age today/i), "44");
    fireEvent.click(btn(/Save changes/i));
    expect(revise.mock.calls[0][1]).toMatchObject({ month: -60, birthYear: 2026 - 44 });
  });
});
