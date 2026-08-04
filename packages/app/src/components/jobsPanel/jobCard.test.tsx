/**
 * @vitest-environment jsdom
 *
 * The extracted JobCard in isolation: it renders one job and routes every action through a
 * narrow callback, never a plan setter. The panel-level flows (add, coordination, warnings)
 * are covered against JobsPanel in `jobsPanel.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { dollarsToCents, type Job } from "@finley/engine";
import { jobPayPathFor } from "../../planPeople";
import type { JobOwner } from "../../jobOwners";
import type { JobEditDraft } from "../../planPeople";
import { JobCard } from "./jobCard";

const OWNER: JobOwner = {
  id: "primary",
  name: "Alex",
  birthYear: 1985,
  jobs: [],
  startMonth: -Infinity,
  endMonth: null,
  writeTarget: "plan",
};

/** A job with one dated pay change, so the timeline shows a removable row. */
const JOB: Job = {
  id: "job-1",
  name: "Engineer",
  ownerId: "primary",
  startYear: 2010,
  endYear: 1985 + 65,
  salary: {
    startingSalaryCents: dollarsToCents(3_000 * 12),
    currentSalaryCents: dollarsToCents(5_000 * 12),
    realGrowthPct: 0,
  },
  payChanges: [{ id: "pc-1", month: 60, kind: "setTo", cents: dollarsToCents(6_000 * 12) }],
};

const EDIT_DRAFT: JobEditDraft = {
  name: "Engineer",
  monthlyCents: dollarsToCents(5_000),
  startingMonthlyCents: dollarsToCents(3_000),
  startAge: 25,
  endAge: 65,
  deferralPct: 0,
  employerMatchPct: 0,
  realGrowthPct: 0,
};

function renderCard(overrides: Partial<Parameters<typeof JobCard>[0]> = {}) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancel: vi.fn(),
    onStartPayChange: vi.fn(),
    onPickAge: vi.fn(),
    onSubmitPayChange: vi.fn(),
    onRemovePayChange: vi.fn(),
    onRemoveOverride: vi.fn(),
  };
  render(
    <JobCard
      owner={OWNER}
      job={JOB}
      label="Engineer"
      monthlyCents={dollarsToCents(5_000)}
      initialEditDraft={EDIT_DRAFT}
      path={jobPayPathFor(OWNER, JOB, 0.03, false)}
      lifeExpectancy={90}
      inTodaysDollars={false}
      severalOwners={false}
      isPrimaryOwner
      authoring={null}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

afterEach(cleanup);

describe("JobCard", () => {
  it("headlines the current pay and names the span", () => {
    renderCard();
    const card = screen.getByLabelText("Engineer");
    expect(within(card).getByTitle(/Current pay/).textContent).toBe("$5,000/mo now");
    expect(within(card).getByText(/age 25–65/i)).toBeTruthy();
  });

  it("fires onEdit and onDelete from the action buttons", () => {
    const h = renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Edit Engineer/i }));
    expect(h.onEdit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Delete Engineer/i }));
    expect(h.onDelete).toHaveBeenCalledOnce();
  });

  it("hosts JobForm while editing and saves the draft through onSaveEdit", () => {
    const h = renderCard({ authoring: { kind: "edit" } });
    expect(screen.getByRole("form", { name: /Save job/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(h.onSaveEdit).toHaveBeenCalledOnce();
  });

  it("removes a pay change through onRemovePayChange with the change's id", () => {
    const h = renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Remove pay change at age/i }));
    expect(h.onRemovePayChange).toHaveBeenCalledWith("pc-1");
  });
});
