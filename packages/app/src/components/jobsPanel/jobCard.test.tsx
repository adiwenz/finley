/**
 * @vitest-environment jsdom
 *
 * The extracted JobCard in isolation: it renders one job and routes every action through a
 * narrow callback, never a plan setter. The panel-level flows (add, coordination, warnings)
 * are covered against JobsPanel in `jobsPanel.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { dollarsToCents, jobPayPath, type Job } from "@finley/engine";

import { START_YEAR } from "../../config";
import type { JobOwner } from "../../jobOwners";
import type { JobEditDraft } from "../../planPeople";
import { JobCard } from "./jobCard";

const OWNER: JobOwner = {
  id: "primary",
  name: "Alex",
  birthYear: 1985,
  lifeExpectancy: 90,
  jobs: [],
  startMonth: -Infinity,
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
      uncounted={[]}
      initialEditDraft={EDIT_DRAFT}
      path={jobPayPath(JOB, { startMonth: (JOB.startYear - START_YEAR) * 12, endMonthExclusive: (JOB.endYear - START_YEAR) * 12 }, { inflationRate: 0.03 })}
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
    // Nothing cuts this job short, so the span reads as authored and says nothing more.
    expect(within(card).queryByText(/life expectancy/i)).toBeNull();
  });

  describe("a job authored past its owner's own death", () => {
    // Alex is born 1985 with an expectancy of 80, so they are gone in 2065 — while the job below
    // is authored to run to age 95 (2080). The engine ends the employment at the death, and the
    // chart on this card is drawn to that end.
    const OWNER_DIES_AT_80: JobOwner = { ...OWNER, lifeExpectancy: 80 };
    const JOB_TO_95: Job = { ...JOB, endYear: 1985 + 95 };
    /** The employment as the engine resolves it: capped at the death, not the authored end. */
    const CAPPED_SPAN = {
      startMonth: (JOB_TO_95.startYear - START_YEAR) * 12,
      endMonthExclusive: (1985 + 80 - START_YEAR) * 12,
    };

    it("keeps the AUTHORED ages and discloses where the job actually ends", () => {
      // Both facts, neither substituted for the other. Showing 25–80 would put an age on the card
      // that appears nowhere in the plan and cannot be edited; showing 25–95 alone would sit
      // directly above a chart ending at 80 with nothing to explain the gap.
      renderCard({
        owner: OWNER_DIES_AT_80,
        job: JOB_TO_95,
        path: jobPayPath(JOB_TO_95, CAPPED_SPAN, { inflationRate: 0.03 }),
      });
      const card = screen.getByLabelText("Engineer");
      expect(within(card).getByText(/age 25–95 · ends at 80 \(life expectancy\)/i)).toBeTruthy();
    });

    it("says nothing when a span is cut short by something OTHER than the death", () => {
      // A stop-working preview shortens the same span. Calling that a life expectancy would be a
      // lie, so the disclosure is gated on the end landing exactly on the owner's own.
      renderCard({
        owner: OWNER_DIES_AT_80,
        job: JOB_TO_95,
        path: jobPayPath(
          JOB_TO_95,
          { ...CAPPED_SPAN, endMonthExclusive: (1985 + 70 - START_YEAR) * 12 },
          { inflationRate: 0.03 },
        ),
      });
      const card = screen.getByLabelText("Engineer");
      expect(within(card).getByText(/age 25–95/i)).toBeTruthy();
      expect(within(card).queryByText(/life expectancy/i)).toBeNull();
    });
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
