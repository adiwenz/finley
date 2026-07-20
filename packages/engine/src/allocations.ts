/**
 * The unified `allocations()` view (§13, §14, §15 of JOBS_HOUSEHOLD_REDESIGN,
 * issue #69, slice 6) — one ordered list that folds together the three things that
 * compete for a month's cash: per-job pre-tax 401(k) deferrals, budget line items,
 * and goals. This is a **single-source + derived selector**, not a UI-only shim:
 * reads unify here, but each entry keeps a pointer to its **canonical home**, so a
 * write always lands where the fact actually lives (401k → job, expense/contribution
 * → budget, goal semantics → goal). That is the §13/§20 "API papering over the
 * split" applied to the allocation surface: reads never contradict because there is
 * exactly one home per fact, and undo/override ride on that home.
 *
 * **Merge order mirrors cash flow (§13):** pre-tax deferrals come off gross *above
 * the tax line*, so they sort first; everything else is post-tax and sorts by the
 * user's flat waterfall priority (§15) — the category tier supplying the default when
 * a line names no explicit priority. Goals fold in as **computed goal-paced line
 * items** (§14, #26): a goal is a sinking-fund contribution to its fund account, with
 * its target/deadline/disposition still owned by the goal.
 *
 * Pure and jurisdiction-agnostic: it imports only the standing authoring types
 * ({@link Job}, {@link BudgetLine}, {@link SimGoal}) and nothing from `projection/*`,
 * so the selector stays clear of the simulator core.
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

/**
 * The canonical home a unified {@link Allocation} writes back to (§13/§20). One home
 * per fact: a job's deferral lives on the job, a budget line on the budget, a goal's
 * semantics on the goal. A write routed here is the single place that fact is edited.
 */
export type AllocationHome =
  | { readonly kind: "job"; readonly jobId: string }
  | { readonly kind: "budgetLine"; readonly lineId: string }
  | { readonly kind: "goal"; readonly goalId: string };

/**
 * How a unified {@link Allocation}'s amount is expressed — the shape depends on the
 * home. A deferral is a fraction of the job's gross (pre-tax, off the top); a budget
 * line or a goal carries an {@link AmountSource} (a goal always the `goalPaced`
 * sinking-fund source, §14). This is a read projection; the per-month dollar figure
 * is resolved by the budget resolver / the waterfall, never stored here.
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
 * One row of the unified view: a deferral, a budget line, or a goal, tagged with its
 * canonical {@link AllocationHome}, tax treatment, and flat waterfall priority. The
 * `id` is stable and unique across all three sources (derived from the home), so a UI
 * can key on it and a resolved line maps back to its author (§Q27).
 */
export interface Allocation {
  readonly id: string;
  readonly label: string;
  readonly home: AllocationHome;
  /** Pre-tax for a deferral; post-tax for expenses and goals (§12/§13). */
  readonly taxTreatment: TaxTreatment;
  /** The account this funds (deferral fund / contribution target / goal fund); null for a plain expense. */
  readonly targetAccountId: string | null;
  /** Flat waterfall priority (lower = funded first) within the item's tax band (§15). */
  readonly priority: number;
  /** Descriptive category tier, when the item carries one (budget lines). */
  readonly category?: BudgetCategory;
  readonly source: AllocationSource;
}

/** The standing inputs the unified view reads across (§13). */
export interface AllocationsInput {
  readonly jobs?: readonly Job[];
  readonly budgetLines?: readonly BudgetLine[];
  readonly goals?: readonly SimGoal[];
}

/**
 * Compile a {@link SimGoal} into the computed goal-paced budget line it *is* (§14,
 * #26): a contribution to the goal's fund account whose amount source is the
 * deadline-paced sinking fund. A dated goal becomes a `goalPaced` line targeting its
 * `targetDate`; an `asap` goal has no deadline to pace against, so it carries a
 * `fillToLimit`-shaped remainder role — represented here as a `literal` 0 marker so
 * it is never dated-paced (the waterfall fills asap goals fill-order from the
 * remainder, §15). The goal keeps ownership of target/deadline/disposition; this line
 * is a derived read, not a second source of truth.
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

/** Stable unified id for a job deferral. */
const deferralId = (jobId: string): string => `deferral:${jobId}`;
/** Stable unified id for a budget line. */
const lineId = (id: string): string => `line:${id}`;

/** The pre-tax deferral rows — one per job that carries a deferral (§11/§13). */
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
      // Pre-tax deferrals sort above the tax line, ahead of every post-tax item; keep
      // authored job order among them.
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

/**
 * One post-tax row for a budget line or a goal (a goal arrives already compiled to a
 * line via {@link goalToLineItem}). `home` distinguishes the two so a write routes
 * back correctly even though both read as a `budget`/`goal` source.
 */
function postTaxAllocation(line: BudgetLine, home: AllocationHome): Allocation {
  const isGoal = home.kind === "goal";
  // A goal line already carries its `goal:<id>` id from goalToLineItem; a budget line
  // is prefixed here so its unified id never collides with a raw source id.
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
 * The unified, ordered allocation view (§13/§14, AC1). Pre-tax deferrals sort first
 * (they come off gross above the tax line); budget lines and goals merge into one
 * post-tax band ordered by flat waterfall priority (§15), goals folded in as computed
 * goal-paced line items (§14). Every row carries a stable id and its canonical home,
 * so reads unify while writes stay routable (AC2 — see {@link routeAllocationWrite}).
 */
export function allocations(input: AllocationsInput): Allocation[] {
  const deferrals = deferralAllocations(input.jobs ?? []);

  // Budget lines and goals share one post-tax priority band. Goals compile to lines
  // first (§14), then both sort by the same flat priority via `orderBudgetLines`, with
  // the home recovered from the id prefix so the two stay distinguishable.
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

/** A stable id for a budget-line allocation (exported for callers keying the view). */
export function budgetLineAllocationId(id: string): string {
  return lineId(id);
}

/**
 * A proposed edit to one allocation, expressed in terms of the fact being changed.
 * Each kind belongs to exactly one home — that is what makes routing total: a
 * `deferralFraction` is a job fact, a `monthlyCents`/`priority` a budget-line fact, a
 * `goalTarget` a goal fact. {@link routeAllocationWrite} validates the pairing.
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

/** A routed write: the canonical home the edit lands on, plus the edit itself (§13/§20). */
export interface WriteRoute {
  readonly home: AllocationHome;
  readonly edit: AllocationEdit;
}

/** Which home a given edit kind is allowed to target — the §20 routing table, in code. */
const EDIT_HOME_KIND: Record<AllocationEdit["kind"], AllocationHome["kind"]> = {
  deferralFraction: "job",
  monthlyCents: "budgetLine",
  priority: "budgetLine",
  goalTarget: "goal",
};

/**
 * Route a write on a unified {@link Allocation} to its **canonical home** (§13/§20,
 * AC2). A deferral edit lands on the job, an expense/contribution edit on the budget
 * line, a goal-field edit on the goal — never a fourth "allocation" record, so reads
 * never contradict and undo/override ride on the existing home. Throws when the edit
 * kind does not belong to the allocation's home (e.g. a goal-target edit on a job
 * deferral), which is the pairing the unified view exists to keep honest.
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
