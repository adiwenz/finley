/**
 * @vitest-environment jsdom
 *
 * RelationshipForm — a partner joins the household (issue #118). Pins that the partner
 * can be authored WITH their own jobs (the same job model and form the primary earner
 * uses), scoped to the partner, and that a partner with no authored jobs joins exactly
 * as before (single-earner plans unchanged).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RelationshipForm } from "./relationshipForm";

afterEach(cleanup);

/** Render the form with a spy for the emitted event, returning the spy. */
function renderForm() {
  const onAdd = vi.fn();
  render(
    <RelationshipForm defaultMonth={0} nextId={2} horizonMonths={600} onAdd={onAdd} />,
  );
  return onAdd;
}

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("RelationshipForm — partner jobs (issue #118)", () => {
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
    fireEvent.click(btn(/Add event/i)); // emit the RelationshipEvent
    const event = onAdd.mock.calls[0][0];
    expect(event.person.jobs).toHaveLength(1);
    const job = event.person.jobs[0];
    expect(job.salary.startingSalaryCents).toBe(2000 * 12 * 100);
    // The job belongs to the partner, not the primary earner.
    expect(job.ownerId).toBe(event.person.id);
  });

  it("authors several jobs and can remove one before adding the partner", () => {
    const onAdd = renderForm();
    // First job: $2,000/mo
    fireEvent.click(btn(/Add a job/i));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "2000" } });
    fireEvent.click(btn(/^Add$/));
    // Second job: $3,000/mo
    fireEvent.click(btn(/Add a job/i));
    fireEvent.change(spin(/Monthly salary/i), { target: { value: "3000" } });
    fireEvent.click(btn(/^Add$/));
    // Remove the first job
    fireEvent.click(btn(/Remove job 1/i));
    fireEvent.click(btn(/Add event/i));
    const event = onAdd.mock.calls[0][0];
    expect(event.person.jobs).toHaveLength(1);
    expect(event.person.jobs[0].salary.startingSalaryCents).toBe(3000 * 12 * 100);
  });
});
