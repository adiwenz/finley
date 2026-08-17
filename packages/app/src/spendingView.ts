/**
 * The Spending workspace's headline figures and its phases.
 *
 * "Phases" answers a question the budget editor cannot: what the household will actually be
 * spending later, and because of what. A budget states today; the projection states every month
 * after it, and the interesting months are the ones a life change moved. So a phase is always
 * anchored to an event — never an arbitrary decade — and names it.
 *
 * Every figure is the projection's own monthly spend at that month, debt payments included,
 * so a phase can never disagree with the chart above it.
 */

import type { Cents, Ledger, Plan, ProjectionResult } from "@finley/engine";
import { START_YEAR } from "./config";
import { summarizeEvent } from "./ledgerView";
import { formatDollars } from "./format";
import { abbreviateDollars } from "./homeView";

export interface SpendingPhase {
  /** "Today", or "Age 47". */
  readonly when: string;
  /** "$4,310/mo" — what the household spends then. */
  readonly value: string;
  /** What put it there: "Current budget", or the life change that moved it. */
  readonly why: string;
}

export interface SpendingView {
  /** The workspace's summary tiles, in order. */
  readonly tiles: readonly { readonly label: string; readonly value: string; readonly sub: string }[];
  readonly phases: readonly SpendingPhase[];
}

/** Total monthly outgoings at a month: budget lines plus what the household owes on debt. */
function spendAt(result: ProjectionResult, month: number): Cents {
  const row = result.series.months.find((m) => m.month === month) ?? result.series.months[0];
  const flows = row?.flows;
  return (flows?.expensesCents ?? 0) + (flows?.liabilityPaymentsCents ?? 0);
}

/** The most phases worth showing. Past three the strip stops being a comparison and becomes a list. */
const MAX_PHASES = 3;

export function spendingView(
  plan: Plan,
  ledger: Ledger,
  result: ProjectionResult,
  retirementMonth: number | null,
): SpendingView {
  const today = spendAt(result, 0);
  const ageAt = (month: number) => START_YEAR + Math.floor(month / 12) - plan.primary.birthYear;

  const tiles = [
    { label: "Today", value: formatDollars(today), sub: "per month" },
    { label: "Yearly", value: abbreviateDollars(today * 12), sub: "at today’s rate" },
  ];

  if (retirementMonth !== null) {
    tiles.push({
      label: `At age ${ageAt(retirementMonth)}`,
      value: formatDollars(spendAt(result, retirementMonth)),
      sub: "when you could stop working",
    });
  }

  // "Today" always leads: a phase strip with no present tense gives the reader nothing to
  // measure the later figures against.
  const phases: SpendingPhase[] = [
    { when: "Today", value: `${formatDollars(today)}/mo`, why: "Current budget" },
  ];

  // Only future changes, and only the earliest few — a phase behind the reader is history, not
  // a plan. Ordered by when they land, so the strip reads forward in time.
  const upcoming = [...ledger.events]
    .filter((event) => event.month > 0)
    .sort((a, b) => a.month - b.month)
    .slice(0, MAX_PHASES - 1);

  for (const event of upcoming) {
    phases.push({
      when: `Age ${ageAt(event.month)}`,
      value: `${formatDollars(spendAt(result, event.month))}/mo`,
      why: summarizeEvent(event).label,
    });
  }

  return { tiles, phases };
}
