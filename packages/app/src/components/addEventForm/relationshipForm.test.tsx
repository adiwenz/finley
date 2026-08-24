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
import { PLAN_DEFAULTS } from "../../planDefaults";
import { RelationshipForm } from "./relationshipForm";
import { readerOf, runOf } from "../../testing/projectionHarness";
import { usJurisdiction } from "@finley/rules";

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
/** A single-earner run: nobody is partnered, so the form's own overlap gate never fires. */
const UNPARTNERED = runOf(PLAN_DEFAULTS);

function renderEdit(event: RelationshipEvent = EXISTING) {
  const reviseTransaction = vi.fn();
  const onRevise = (write: (p: Projection) => void) =>
    write({ reviseTransaction } as unknown as Projection);
  render(
    <RelationshipForm
      result={UNPARTNERED}
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
  render(
    <RelationshipForm
      result={UNPARTNERED}
      defaultMonth={defaultMonth}
      horizonMonths={600}
      onAdd={onAdd}
    />,
  );
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
      accountBalances: {
        savingsBalanceCents: 0,
        retirementBalanceCents: 0,
        brokerageBalanceCents: 0,
      },
      // The event on the timeline states no split, which MEANS 50/50 — so an untouched edit
      // sends back the default rather than a blank, and the partnership is unchanged.
      partnerSharePercent: 50,
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

describe("RelationshipForm — one partnership at a time", () => {
  /** A run where the household is already partnered with Blake from 2028 (month 24) onward. */
  function partneredRun() {
    const p = readerOf(PLAN_DEFAULTS);
    p.marry({ month: 24, name: "Blake", birthYear: 1990, lifeExpectancy: 90 });
    return p.run(usJurisdiction);
  }

  it("names the partnership in the way and refuses to submit onto it", () => {
    const marry = vi.fn();
    const onAdd = (write: (p: Projection) => void) => write({ marry } as unknown as Projection);
    render(
      <RelationshipForm
        result={partneredRun()}
        defaultMonth={60}
        horizonMonths={600}
        onAdd={onAdd}
      />,
    );

    expect(screen.getByText(/already partnered with Blake in 2031/i)).toBeTruthy();
    expect((btn(/Add event/i) as HTMLButtonElement).disabled).toBe(true);
  });

  it("still refuses a date BEFORE the partnership, which this one would run into", () => {
    // The half a date check cannot see. Month 0 is occupied by nobody, so "is somebody partnered
    // on this date" says yes; the partnership authored there has no separation and would still be
    // running when Blake arrives in 2031, which is the overlap the ledger refuses. The form asks
    // the same span question, so the button and the write agree.
    const marry = vi.fn();
    const onAdd = (write: (p: Projection) => void) => write({ marry } as unknown as Projection);
    render(
      <RelationshipForm
        result={partneredRun()}
        defaultMonth={60}
        horizonMonths={600}
        onAdd={onAdd}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: /When/i }), { target: { value: "0" } });

    expect(screen.queryByText(/already partnered/i)).toBeNull();
    expect(
      screen.getByText(/would still be running when you partner with Blake in 2028/i),
    ).toBeTruthy();
    expect((btn(/Add event/i) as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * The whole PROPOSED interval, not just its first day.
 *
 * A partnership being authored has no separation yet, so it runs from its date to the end of that
 * partner's life. That is what a date check could never see: Year 6 is unoccupied, and a
 * partnership starting there is still running when Casey arrives in Year 7. The engine has always
 * refused this on replay; what these pin is that the button refuses it first, for the same reason
 * and in the same words, so a user is never invited to make a write that cannot land.
 */
describe("RelationshipForm — a partnership booked ahead of this one", () => {
  const SEPARATION_MONTH = 60;
  const JOIN_MONTH = 84;

  /** Blake from month 0, gone at 60; Casey from 84 — the sequential household. */
  function sequentialRun() {
    const p = readerOf(PLAN_DEFAULTS);
    p.marry({ month: 0, name: "Blake", birthYear: 1990, lifeExpectancy: 88, partnerSharePercent: 30 });
    p.separate({
      month: SEPARATION_MONTH,
      partnerPersonId: p.run(usJurisdiction).activePartnerAt(0)!.id,
    });
    p.marry({ month: JOIN_MONTH, name: "Casey", birthYear: 1992, lifeExpectancy: 95 });
    return p.run(usJurisdiction);
  }

  function renderAt(month: number, result = sequentialRun()) {
    const marry = vi.fn();
    const onAdd = (write: (p: Projection) => void) => write({ marry } as unknown as Projection);
    render(
      <RelationshipForm result={result} defaultMonth={month} horizonMonths={600} onAdd={onAdd} />,
    );
    return marry;
  }

  const addButton = () => btn(/Add event/i) as HTMLButtonElement;

  it("refuses a date inside a partnership that is already running", () => {
    renderAt(24);
    expect(screen.getByText(/already partnered with Blake/i)).toBeTruthy();
    expect(addButton().disabled).toBe(true);
  });

  it("refuses a date whose partnership would still be running when the next one begins", () => {
    // The reported case. Month 72 is Year 6: Blake left in Year 5, so nothing occupies it, and
    // the button used to be live right up until the engine threw.
    renderAt(72);
    expect(screen.getByText(/would still be running when you partner with Casey/i)).toBeTruthy();
    expect(addButton().disabled).toBe(true);
  });

  it("names WHICH partnership is in the way, since the two are fixed by different edits", () => {
    renderAt(72);
    const warning = screen.getByText(/would still be running/i).textContent!;
    expect(warning).toContain("Casey");
    expect(warning).toMatch(/Add a separation before then/i);
  });

  it("allows a partnership whose own span ends before the next one begins", () => {
    // The gap is real: this partner does not live to reach Casey, so the two never overlap. The
    // span's far end is the partner's own life, which is why the expectancy field revalidates.
    renderAt(60);
    enterNumber(spin(/Their age in/i), "80");
    enterNumber(spin(/Their life expectancy/i), "81");
    expect(screen.queryByText(/would still be running/i)).toBeNull();
    expect(addButton().disabled).toBe(false);
  });

  it("allows a partnership beginning the very month the last one ended", () => {
    // Separation is processed before the join, so the spans sit end to end rather than overlap.
    // Blake's ends at 60 exclusive; a partner arriving AT 60 is legal, and would be legal
    // whatever the split either partnership was authored with.
    const p = readerOf(PLAN_DEFAULTS);
    p.marry({ month: 0, name: "Blake", birthYear: 1990, lifeExpectancy: 88, partnerSharePercent: 30 });
    p.separate({
      month: SEPARATION_MONTH,
      partnerPersonId: p.run(usJurisdiction).activePartnerAt(0)!.id,
    });
    renderAt(SEPARATION_MONTH, p.run(usJurisdiction));
    expect(screen.queryByText(/hint warn/i)).toBeNull();
    expect(addButton().disabled).toBe(false);
  });

  it("revalidates when the date moves, without remounting the form", () => {
    renderAt(72);
    expect(addButton().disabled).toBe(true);
    // Past Casey entirely: Casey's own span is what this one would now sit behind, and Casey
    // never separates, so it collides the other way and stays refused.
    fireEvent.change(screen.getByRole("combobox", { name: /When/i }), {
      target: { value: String(JOIN_MONTH + 12) },
    });
    expect(screen.getByText(/already partnered with Casey/i)).toBeTruthy();
    expect(addButton().disabled).toBe(true);
  });

  it("still opens a brand-new partnership at 50/50, whatever the last one was authored at", () => {
    // The split rides on the relationship. Blake's 70/30 above is Blake's, and Casey's default is
    // reached by the same field opening on the same number.
    renderAt(60);
    expect(spin(/Partner/).value).toBe("50");
  });
});

/** The same rule when the partnership already exists and its date is being corrected. */
describe("RelationshipForm — editing a partnership into an overlap", () => {
  function withCasey() {
    const p = readerOf(PLAN_DEFAULTS);
    p.marry({ month: 120, name: "Casey", birthYear: 1992, lifeExpectancy: 95 });
    return p.run(usJurisdiction);
  }

  function renderEditAt(event: RelationshipEvent, result: ReturnType<typeof withCasey>) {
    const reviseTransaction = vi.fn();
    const onRevise = (write: (p: Projection) => void) =>
      write({ reviseTransaction } as unknown as Projection);
    render(
      <RelationshipForm
        result={result}
        defaultMonth={0}
        horizonMonths={600}
        onAdd={() => {}}
        edit={{ event, onRevise }}
      />,
    );
    return reviseTransaction;
  }

  it("refuses a correction that would run the partnership into a later one", () => {
    renderEditAt(EXISTING, withCasey());
    expect(screen.getByText(/would still be running when you partner with Casey/i)).toBeTruthy();
    expect((btn(/Save changes/i) as HTMLButtonElement).disabled).toBe(true);
  });

  it("never treats a partnership as conflicting with itself", () => {
    // The partner being edited IS on the timeline. Measuring the correction against the version
    // it replaces would refuse every edit that changed nothing.
    const p = readerOf(PLAN_DEFAULTS);
    p.marry({ month: 24, name: "Sam", birthYear: 1988, lifeExpectancy: 85 });
    const run = p.run(usJurisdiction);
    const sam = run.household.memberships[1]!.person;
    renderEditAt({ ...EXISTING, person: { ...EXISTING.person, id: sam.id } }, run);
    expect(screen.queryByText(/still be running|already partnered/i)).toBeNull();
    expect((btn(/Save changes/i) as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * Opening Edit on a partnership that ALREADY ENDED.
 *
 * The span a correction is measured against is the one on the timeline, separation included. Read
 * as open-ended instead, every relationship with a successor reported a collision with that
 * successor the moment its own form opened — Save disabled, a warning about Casey, and nothing
 * changed to warrant either. The candidate's far end is a fact the ledger holds, not a blank.
 */
describe("RelationshipForm — editing a partnership that a separation already ended", () => {
  const SEPARATION_MONTH = 60;
  const JOIN_MONTH = 84;

  /** Blake from month 0, gone at 60; Casey from 84 — the chain the false positive appeared in. */
  function chain() {
    const p = readerOf(PLAN_DEFAULTS);
    p.marry({ month: 0, name: "Blake", birthYear: 1990, lifeExpectancy: 88, partnerSharePercent: 30 });
    p.separate({
      month: SEPARATION_MONTH,
      partnerPersonId: p.run(usJurisdiction).activePartnerAt(0)!.id,
    });
    p.marry({ month: JOIN_MONTH, name: "Casey", birthYear: 1992, lifeExpectancy: 95 });
    const run = p.run(usJurisdiction);
    const person = (name: string) =>
      run.household.memberships.find((m) => m.person.name === name)!.person;
    return { run, blake: person("Blake"), casey: person("Casey") };
  }

  const eventFor = (person: { id: string }, month: number, name: string): RelationshipEvent => ({
    ...EXISTING,
    month,
    person: { ...EXISTING.person, id: person.id, name },
  });

  function renderEdit(event: RelationshipEvent, result: ReturnType<typeof chain>["run"]) {
    const reviseTransaction = vi.fn();
    const onRevise = (write: (p: Projection) => void) =>
      write({ reviseTransaction } as unknown as Projection);
    render(
      <RelationshipForm
        result={result}
        defaultMonth={0}
        horizonMonths={600}
        onAdd={() => {}}
        edit={{ event, onRevise }}
      />,
    );
    return reviseTransaction;
  }

  const saveButton = () => btn(/Save changes/i) as HTMLButtonElement;

  it("opens clean: nothing has changed, so there is nothing to refuse", () => {
    const { run, blake } = chain();
    renderEdit(eventFor(blake, 0, "Blake"), run);
    expect(screen.queryByText(/still be running|already partnered/i)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("saves a change to the split alone, which moves neither end of the span", () => {
    const { run, blake } = chain();
    const revise = renderEdit(eventFor(blake, 0, "Blake"), run);
    enterNumber(spin(/Blake/), "65");
    fireEvent.click(saveButton());
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0]![1]).toMatchObject({ partnerSharePercent: 65 });
  });

  it("opens the LAST partnership in the chain clean too, having nothing behind it", () => {
    // Casey never separates, so this span really is open-ended — and still collides with nothing,
    // because Blake's ended long before it began.
    const { run, casey } = chain();
    renderEdit(eventFor(casey, JOIN_MONTH, "Casey"), run);
    expect(screen.queryByText(/still be running|already partnered/i)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("still refuses a start date moved back into the partnership before it", () => {
    // Casey pulled back to Year 4, while Blake is still here. A real overlap, and the same
    // refusal as before — the fix narrows what counts as one, it does not remove the check.
    const { run, casey } = chain();
    renderEdit(eventFor(casey, JOIN_MONTH, "Casey"), run);
    fireEvent.change(screen.getByRole("combobox", { name: /When/i }), { target: { value: "48" } });
    expect(screen.getByText(/already partnered with Blake/i)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("refuses a life expectancy that outlives the separation and runs into Casey", () => {
    // Blake's span ends at the SEPARATION, whatever their expectancy — so the far end that used
    // to be read here is not the one that matters, and raising it changes nothing.
    const { run, blake } = chain();
    renderEdit(eventFor(blake, 0, "Blake"), run);
    enterNumber(spin(/Their life expectancy/i), "99");
    expect(screen.queryByText(/still be running/i)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });
});

/**
 * What a partner brings is editable, and the edit survives the click that saves it.
 *
 * `NumInput` turns a typed figure into a fact on BLUR, which assumes that reaching for Save takes
 * focus out of the field first. A button is not obliged to take focus when it is clicked, and on
 * macOS it does not — so the commonest gesture there is, type the last number and click Save,
 * submitted the balance the field held BEFORE the edit. The form closed on success, the figure
 * reverted, and nothing said an edit had been dropped. Name and split were unaffected only
 * because neither waits for a blur, which is what made this look like a rule about brought money.
 */
describe("RelationshipForm — the money a partner brings", () => {
  /** A partner already on the timeline holding $1,000 / $2,000 / $3,000. */
  const FUNDED: RelationshipEvent = {
    ...EXISTING,
    accounts: {
      savingsBalanceCents: 100_000,
      savingsReturnPct: 1,
      retirementBalanceCents: 200_000,
      retirementReturnPct: 5,
      brokerageBalanceCents: 300_000,
      brokerageReturnPct: 5,
    },
  };
  const balances = (revise: ReturnType<typeof renderEdit>) =>
    revise.mock.calls[0][1].accountBalances;

  /** Click Save the way a mouse does: pointer down first, and no blur of its own. */
  const clickSave = () => {
    const save = btn(/Save changes/i);
    fireEvent.pointerDown(save);
    fireEvent.click(save);
  };

  it("opens on the balances the partner already has", () => {
    renderEdit(FUNDED);
    expect(spin(/Their cash savings/i).value).toBe("1000");
    expect(spin(/Their retirement account/i).value).toBe("2000");
    expect(spin(/Their brokerage/i).value).toBe("3000");
  });

  it("raises a brought balance, without the field being left first", () => {
    const revise = renderEdit(FUNDED);
    const field = spin(/Their cash savings/i);
    field.focus();
    fireEvent.change(field, { target: { value: "7777" } });
    clickSave();
    expect(balances(revise).savingsBalanceCents).toBe(777_700);
    // The two nobody touched are sent back as they were, not blanked by the one that changed.
    expect(balances(revise).retirementBalanceCents).toBe(200_000);
    expect(balances(revise).brokerageBalanceCents).toBe(300_000);
  });

  it("lowers a brought balance the same way, including to nothing", () => {
    const revise = renderEdit(FUNDED);
    const field = spin(/Their brokerage/i);
    field.focus();
    fireEvent.change(field, { target: { value: "0" } });
    clickSave();
    expect(balances(revise).brokerageBalanceCents).toBe(0);
    expect(balances(revise).savingsBalanceCents).toBe(100_000);
  });

  it("carries every brought balance when all three are edited in turn", () => {
    const revise = renderEdit(FUNDED);
    for (const [label, typed] of [
      [/Their cash savings/i, "11"],
      [/Their retirement account/i, "22"],
      [/Their brokerage/i, "33"],
    ] as const) {
      enterNumber(spin(label), typed);
    }
    clickSave();
    expect(balances(revise)).toEqual({
      savingsBalanceCents: 1_100,
      retirementBalanceCents: 2_200,
      brokerageBalanceCents: 3_300,
    });
  });

  it("still commits an edit the user did leave before saving", () => {
    // The blur path is unchanged; the pointer-down commit only covers the gesture it misses.
    const revise = renderEdit(FUNDED);
    enterNumber(spin(/Their cash savings/i), "555");
    fireEvent.click(btn(/Save changes/i));
    expect(balances(revise).savingsBalanceCents).toBe(55_500);
  });
});
