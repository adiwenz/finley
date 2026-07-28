/**
 * The unified `allocations()` view — one ordered list folding together the three claims on
 * a month's cash: per-job pre-tax deferrals, budget line items, and goals. Reads unify
 * here, but each entry points at its **canonical home**, so a write lands where the fact
 * lives (deferral → job, expense/contribution → budget, goal semantics → goal). One home
 * per fact, so reads never contradict and undo/override ride on that home.
 *
 * **Merge order mirrors cash flow:** pre-tax deferrals come off gross above the tax line
 * and sort first; everything else is post-tax, ordered by flat waterfall priority, with the
 * category tier supplying the default when a line names none. Goals fold in as computed
 * goal-paced line items — a sinking-fund contribution to the goal's fund account, with
 * target/deadline/disposition still owned by the goal.
 *
 * Pure and jurisdiction-agnostic: imports only the standing authoring types and nothing
 * from `projection/*`.
 */

import type { Cents } from "./money";
import type { Job } from "./job";
import {
  type AmountSource,
  type BudgetCategory,
  type BudgetLine,
  type TaxTreatment,
  budgetLinePriority,
  orderBudgetLines,
  taxTreatmentForLine,
} from "./budgetLine";
import type { GoalTargetDate, SimGoal } from "./goal";

/** The canonical home a unified {@link Allocation} writes back to. */
export type AllocationHome =
  | { readonly kind: "job"; readonly jobId: string }
  | { readonly kind: "budgetLine"; readonly lineId: string }
  | { readonly kind: "goal"; readonly goalId: string };

/**
 * How an {@link Allocation}'s amount is expressed — the shape follows the home. A deferral
 * is a fraction of the job's gross (pre-tax, off the top); a budget line or goal carries an
 * {@link AmountSource}. The per-month dollar figure is resolved by the budget resolver /
 * waterfall, never stored here.
 */
export type AllocationSource =
  | {
      readonly kind: "deferral";
      readonly deferralFraction: number;
      readonly employerMatchFraction?: number;
    }
  | { readonly kind: "budget"; readonly amountSource: AmountSource }
  | { readonly kind: "goal"; readonly amountSource: AmountSource };

/**
 * One row of the unified view: a deferral, budget line, or goal. `id` is derived from the
 * home, so it is stable and unique across all three sources — a UI can key on it and a
 * resolved line maps back to its author.
 */
export interface Allocation {
  readonly id: string;
  readonly label: string;
  readonly home: AllocationHome;
  /** Pre-tax for a deferral; post-tax for expenses and goals. */
  readonly taxTreatment: TaxTreatment;
  /** The account this funds; null for a plain expense. */
  readonly targetAccountId: string | null;
  /** Flat waterfall priority (lower = funded first) within the item's tax band. */
  readonly priority: number;
  /** Descriptive category tier, when the item carries one (budget lines). */
  readonly category?: BudgetCategory;
  readonly source: AllocationSource;
}

export interface AllocationsInput {
  readonly jobs?: readonly Job[];
  readonly budgetLines?: readonly BudgetLine[];
  readonly goals?: readonly SimGoal[];
}

/**
 * Compile a {@link SimGoal} into the goal-paced budget line it *is*: a contribution to the
 * goal's fund account paced as a deadline sinking fund. An `asap` goal has no deadline to
 * pace against, so it gets a `literal` 0 marker — the waterfall fills asap goals
 * fill-order from the remainder.
 */
export function goalToLineItem(goal: SimGoal): BudgetLine {
  const amountSource: AmountSource =
    goal.targetDate === "asap"
      ? { kind: "literal", monthlyCents: 0 }
      : { kind: "goalPaced", targetCents: goal.targetCents, targetMonth: goal.targetDate };
  return {
    id: `goal:${goal.id}`,
    label: goal.name,
    target: { kind: "account", accountId: goal.fundAccountId, taxTreatment: "postTax" },
    category: "savings",
    amountSource,
    priority: goal.priority,
  };
}

const deferralId = (jobId: string): string => `deferral:${jobId}`;
const lineId = (id: string): string => `line:${id}`;

function deferralAllocations(jobs: readonly Job[]): Allocation[] {
  const out: Allocation[] = [];
  jobs.forEach((job, index) => {
    if (job.deferral === undefined) return;
    out.push({
      id: deferralId(job.id),
      label: `${job.id} pre-tax deferral`,
      home: { kind: "job", jobId: job.id },
      taxTreatment: "preTax",
      targetAccountId: job.deferral.fundAccountId,
      // Above the tax line, ahead of every post-tax item; authored job order among them.
      priority: index,
      source: {
        kind: "deferral",
        deferralFraction: job.deferral.deferralFraction,
        ...(job.deferral.employerMatchFraction !== undefined
          ? { employerMatchFraction: job.deferral.employerMatchFraction }
          : {}),
      },
    });
  });
  return out;
}

/** One post-tax row for a budget line or a goal compiled by {@link goalToLineItem}. */
function postTaxAllocation(line: BudgetLine, home: AllocationHome): Allocation {
  const isGoal = home.kind === "goal";
  // A goal line already carries its `goal:<id>` id; a budget line is prefixed here so its
  // unified id never collides with a raw source id.
  const id = home.kind === "budgetLine" ? lineId(home.lineId) : line.id;
  return {
    id,
    label: line.label,
    home,
    taxTreatment: taxTreatmentForLine(line),
    targetAccountId: line.target.kind === "account" ? line.target.accountId : null,
    priority: budgetLinePriority(line),
    category: line.category,
    source: isGoal
      ? { kind: "goal", amountSource: line.amountSource }
      : { kind: "budget", amountSource: line.amountSource },
  };
}

/**
 * The unified, ordered allocation view: deferrals first, then budget lines and goals in
 * one post-tax band ordered by flat waterfall priority.
 */
export function allocations(input: AllocationsInput): Allocation[] {
  const deferrals = deferralAllocations(input.jobs ?? []);

  // Budget lines and goals share one post-tax priority band: goals compile to lines and
  // both sort by flat priority via `orderBudgetLines`, with `homeByLineId` keeping the two
  // distinguishable afterwards.
  const budgetLines = input.budgetLines ?? [];
  const goalLines = (input.goals ?? []).map(goalToLineItem);
  const homeByLineId = new Map<string, AllocationHome>();
  for (const line of budgetLines) homeByLineId.set(line.id, { kind: "budgetLine", lineId: line.id });
  for (const goal of input.goals ?? []) homeByLineId.set(`goal:${goal.id}`, { kind: "goal", goalId: goal.id });

  const postTax = orderBudgetLines([...budgetLines, ...goalLines]).map((line) => {
    const home = homeByLineId.get(line.id) ?? { kind: "budgetLine", lineId: line.id };
    return postTaxAllocation(line, home);
  });

  return [...deferrals, ...postTax];
}

/** The unified id for a budget-line allocation, for callers keying the view. */
export function budgetLineAllocationId(id: string): string {
  return lineId(id);
}

/**
 * A proposed edit to one allocation, named for the fact being changed. Each kind belongs to
 * exactly one home, which is what makes routing total; {@link routeAllocationWrite}
 * validates the pairing.
 */
export type AllocationEdit =
  | { readonly kind: "deferralFraction"; readonly value: number }
  | { readonly kind: "monthlyCents"; readonly value: Cents }
  | { readonly kind: "priority"; readonly value: number }
  | {
      readonly kind: "goalTarget";
      readonly targetCents: Cents;
      readonly targetDate: GoalTargetDate;
    };

export interface WriteRoute {
  readonly home: AllocationHome;
  readonly edit: AllocationEdit;
}

const EDIT_HOME_KIND: Record<AllocationEdit["kind"], AllocationHome["kind"]> = {
  deferralFraction: "job",
  monthlyCents: "budgetLine",
  priority: "budgetLine",
  goalTarget: "goal",
};

/**
 * Route a write on an {@link Allocation} to its canonical home — never a fourth
 * "allocation" record. Throws when the edit kind does not belong to the allocation's home
 * (e.g. a goal-target edit on a job deferral).
 */
export function routeAllocationWrite(allocation: Allocation, edit: AllocationEdit): WriteRoute {
  const expected = EDIT_HOME_KIND[edit.kind];
  if (allocation.home.kind !== expected) {
    throw new Error(
      `Allocation "${allocation.id}" lives in a ${allocation.home.kind} home; ` +
        `a ${edit.kind} edit routes to a ${expected} home.`,
    );
  }
  return { home: allocation.home, edit };
}
