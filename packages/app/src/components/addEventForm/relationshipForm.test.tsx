/**
 * @vitest-environment jsdom
 *
 * RelationshipForm — a partner joins the household. Pins that a partner can be authored WITH
 * their own jobs (the same job model the primary earner uses), scoped to them, and that a
 * partner with no jobs joins as before, leaving single-earner plans unchanged.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Projection } from "@finley/engine";
import { RelationshipForm } from "./relationshipForm";

afterEach(cleanup);

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
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "2000" } });
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

  it("takes the partner's age at the year they join, and stores it as their birth year", () => {
    // The user thinks in an age; the engine reasons in a birth year, which drives when
    // their jobs stop and their benefit starts.
    const marry = renderForm(60); // joining in Year 5 → 2031
    expect(spin(/Their age in 2031/i)).toBeTruthy();
    fireEvent.change(spin(/Their age/i), { target: { value: "45" } });
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
    fireEvent.change(spin(/Their age/i), { target: { value: "30" } });
    fireEvent.click(btn(/Add a job/i));
    // A fresh job is seeded at the age they join.
    expect(Number(spin(/Start age/i).value)).toBe(30);
    fireEvent.change(spin(/Start age/i), { target: { value: "22" } });
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Add event/i));

    const input = marry.mock.calls[0][0];
    expect(input.birthYear).toBe(2026 - 30);
    // Their age 22, not the primary earner's: eight years before "now".
    expect(input.jobs[0].startYear).toBe(2026 - 8);
  });

  it("takes their own retirement and claiming ages, defaulting to 65 and 67", () => {
    const marry = renderForm(0);
    fireEvent.click(btn(/Add event/i));
    const input = marry.mock.calls[0][0];
    expect(input.retirementTargetAge).toBe(65);
    expect(input.benefitClaimingAge).toBe(67);
  });

  it("lets a partner who has already retired join — their own clock, not the household's", () => {
    // Their retirement age is NOT chained to their current age (the primary earner's is):
    // a 68-year-old who stopped working at 62 is a real scenario.
    const marry = renderForm(0);
    fireEvent.change(spin(/Their age/i), { target: { value: "68" } });
    fireEvent.change(spin(/Their retirement age/i), { target: { value: "62" } });
    fireEvent.change(spin(/Their Social Security claiming age/i), { target: { value: "70" } });
    fireEvent.click(btn(/Add event/i));

    const input = marry.mock.calls[0][0];
    expect(input.birthYear).toBe(2026 - 68);
    expect(input.retirementTargetAge).toBe(62);
    expect(input.benefitClaimingAge).toBe(70);
  });

  it("authors several jobs and can remove one before adding the partner", () => {
    const marry = renderForm();
    fireEvent.click(btn(/Add a job/i));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "2000" } });
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Add a job/i));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "3000" } });
    fireEvent.click(btn(/^Add$/));
    fireEvent.click(btn(/Remove job 1/i));
    fireEvent.click(btn(/Add event/i));
    const input = marry.mock.calls[0][0];
    expect(input.jobs).toHaveLength(1);
    expect(input.jobs[0].salary.startingSalaryCents).toBe(3000 * 12 * 100);
  });
});
