/**
 * @vitest-environment jsdom
 *
 * RelationshipForm — a partner joins the household. Pins that a partner can be authored WITH
 * their own jobs (the same job model the primary earner uses), scoped to them, and that a
 * partner with no jobs joins as before, leaving single-earner plans unchanged.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RelationshipForm } from "./relationshipForm";

afterEach(cleanup);

function renderForm(defaultMonth = 0) {
  const onAdd = vi.fn();
  render(
    <RelationshipForm defaultMonth={defaultMonth} nextId={2} horizonMonths={600} onAdd={onAdd} />,
  );
  return onAdd;
}

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("RelationshipForm — partner jobs", () => {
  it("a partner joins with no jobs by default (unchanged behavior)", () => {
    const onAdd = renderForm();
    fireEvent.click(btn(/Add event/i));
    expect(onAdd).toHaveBeenCalledTimes(1);
    const event = onAdd.mock.calls[0][0];
    expect(event.type).toBe("RelationshipEvent");
    expect(event.person.jobs).toEqual([]);
  });

  it("authors a job for the partner, scoped to the partner as its owner", () => {
    const onAdd = renderForm();
    fireEvent.click(btn(/Add a job/i));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "2000" } });
    fireEvent.click(btn(/^Add$/)); // the JobForm's own submit
    fireEvent.click(btn(/Add event/i));
    const event = onAdd.mock.calls[0][0];
    expect(event.person.jobs).toHaveLength(1);
    const job = event.person.jobs[0];
    expect(job.salary.startingSalaryCents).toBe(2000 * 12 * 100);
    expect(job.ownerId).toBe(event.person.id);
  });

  it("takes the partner's age at the year they join, and stores it as their birth year", () => {
    // The user thinks in an age; the engine reasons in a birth year, which drives when
    // their jobs stop and their benefit starts.
    const onAdd = renderForm(60); // joining in Year 5 → 2031
    expect(spin(/Their age in 2031/i)).toBeTruthy();
    fireEvent.change(spin(/Their age/i), { target: { value: "45" } });
    fireEvent.click(btn(/Add event/i));
    expect(onAdd.mock.calls[0][0].person.birthYear).toBe(2031 - 45);
  });

  it("defaults to a generic adult, anchored to today when they join now", () => {
    const onAdd = renderForm(0);
    expect(spin(/Their age in 2026/i)).toBeTruthy();
    fireEvent.click(btn(/Add event/i));
    expect(onAdd.mock.calls[0][0].person.birthYear).toBe(2026 - 40);
  });

  it("resolves an authored job's ages against the partner's own birth year", () => {
    const onAdd = renderForm(0);
    fireEvent.change(spin(/Their age/i), { target: { value: "30" } });
    fireEvent.click(btn(/Add a job/i));
    // A fresh job is seeded at the age they join.
    expect(Number(spin(/Start age/i).value)).toBe(30);
    fireEvent.change(spin(/Start age/i), { target: { value: "22" } });
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Add event/i));

    const event = onAdd.mock.calls[0][0];
    expect(event.person.birthYear).toBe(2026 - 30);
    // Their age 22, not the primary earner's: eight years before "now".
    expect(event.person.jobs[0].startYear).toBe(2026 - 8);
  });

  it("takes their own retirement and claiming ages, defaulting to 65 and 67", () => {
    const onAdd = renderForm(0);
    fireEvent.click(btn(/Add event/i));
    const defaults = onAdd.mock.calls[0][0].person;
    expect(defaults.retirementTargetAge).toBe(65);
    expect(defaults.benefitClaimingAge).toBe(67);
  });

  it("lets a partner who has already retired join — their own clock, not the household's", () => {
    // Their retirement age is NOT chained to their current age (the primary earner's is):
    // a 68-year-old who stopped working at 62 is a real scenario.
    const onAdd = renderForm(0);
    fireEvent.change(spin(/Their age/i), { target: { value: "68" } });
    fireEvent.change(spin(/Their retirement age/i), { target: { value: "62" } });
    fireEvent.change(spin(/Their Social Security claiming age/i), { target: { value: "70" } });
    fireEvent.click(btn(/Add event/i));

    const person = onAdd.mock.calls[0][0].person;
    expect(person.birthYear).toBe(2026 - 68);
    expect(person.retirementTargetAge).toBe(62);
    expect(person.benefitClaimingAge).toBe(70);
  });

  it("authors several jobs and can remove one before adding the partner", () => {
    const onAdd = renderForm();
    fireEvent.click(btn(/Add a job/i));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "2000" } });
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Add a job/i));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "3000" } });
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Remove job 1/i));
    fireEvent.click(btn(/Add event/i));
    const event = onAdd.mock.calls[0][0];
    expect(event.person.jobs).toHaveLength(1);
    expect(event.person.jobs[0].salary.startingSalaryCents).toBe(3000 * 12 * 100);
  });
});
