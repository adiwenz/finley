/**
 * App-side add / rename / delete for line-item budget {@link BudgetLine}s (§12/§15,
 * issue #72) — the structural editing the Base + Adjustments panel lacked (it could only
 * override amounts). A line is either an **expense** (a cash outflow) or a **contribution**
 * into a named account (recurring saving/investment, now funded by the sim). These pure
 * list transforms mirror `goalsView`/`planPeople`: the panel calls them through `setLines`.
 *
 * Contribution targets are limited to the engine's post-tax {@link CONTRIBUTION_TARGETS}
 * (brokerage, cash savings) — a post-tax contribution into a pre-tax account would skip
 * the deduction; pre-tax saving is the job's 401(k) deferral, authored on the job (§11).
 */

import {
  CONTRIBUTION_TARGETS,
  type BudgetCategory,
  type BudgetLine,
  type TaxTreatment,
} from "@finley/engine";

/** The account targets a contribution line may fund (post-tax only), for the UI picker. */
export const contributionTargets = CONTRIBUTION_TARGETS;

/**
 * The editable shape of a budget line, in the terms the form speaks — a discriminated union
 * on `kind` so illegal combinations are unrepresentable: an **expense** carries a
 * needs/wants/savings `category` and no account; a **contribution** names its target
 * `accountId` (and is inherently the savings tier). Dollars are cents. Switching kind can
 * only ever produce one of these two shapes, never a mix (an expense with an account, or a
 * contribution with a "wants" category).
 */
export type BudgetLineDraft =
  | {
      readonly kind: "expense";
      readonly label: string;
      readonly monthlyCents: number;
      readonly category: BudgetCategory;
    }
  | {
      readonly kind: "contribution";
      readonly label: string;
      readonly monthlyCents: number;
      readonly accountId: string;
    };

/** Expense lines of a budget, in authored order. */
export function expenseLinesOf(lines: readonly BudgetLine[]): BudgetLine[] {
  return lines.filter((l) => l.target.kind === "expense");
}

/** Account-contribution lines of a budget, in authored order. */
export function contributionLinesOf(lines: readonly BudgetLine[]): BudgetLine[] {
  return lines.filter((l) => l.target.kind === "account");
}

/** The account a fresh contribution draft targets — the first post-tax target. */
const defaultContributionAccountId = (): string => contributionTargets[0]?.accountId ?? "brokerage";

/** The starting draft for a new line of the given kind. */
export function blankLineDraft(kind: "expense" | "contribution"): BudgetLineDraft {
  return kind === "contribution"
    ? { kind: "contribution", label: "", monthlyCents: 500 * 100, accountId: defaultContributionAccountId() }
    : { kind: "expense", label: "", monthlyCents: 0, category: "needs" };
}

/** Read an existing line back into a {@link BudgetLineDraft} to seed the edit form. */
export function lineToDraft(line: BudgetLine): BudgetLineDraft {
  const monthlyCents =
    line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0;
  return line.target.kind === "account"
    ? { kind: "contribution", label: line.label, monthlyCents, accountId: line.target.accountId }
    : { kind: "expense", label: line.label, monthlyCents, category: line.category };
}

/** The post-tax treatment the engine assigns an account target (default post-tax). */
function treatmentFor(accountId: string): TaxTreatment {
  return contributionTargets.find((t) => t.accountId === accountId)?.taxTreatment ?? "postTax";
}

/** A stable, collision-free id for a freshly added line. */
function nextLineId(lines: readonly BudgetLine[]): string {
  const ids = new Set(lines.map((l) => l.id));
  let n = lines.length + 1;
  while (ids.has(`line-${n}`)) n++;
  return `line-${n}`;
}

/** Build a {@link BudgetLine} (literal monthly amount) from a draft under `id`. */
function lineFromDraft(id: string, draft: BudgetLineDraft): BudgetLine {
  const base = {
    id,
    label: draft.label.trim() || "Untitled",
    amountSource: { kind: "literal" as const, monthlyCents: Math.max(0, draft.monthlyCents) },
  };
  return draft.kind === "contribution"
    ? {
        ...base,
        // A contribution is inherently a savings-tier line, whatever account it funds.
        category: "savings",
        target: {
          kind: "account" as const,
          accountId: draft.accountId,
          taxTreatment: treatmentFor(draft.accountId),
        },
      }
    : { ...base, category: draft.category, target: { kind: "expense" as const } };
}

/** Append a new line from a form draft. */
export function addLineFromDraft(lines: readonly BudgetLine[], draft: BudgetLineDraft): BudgetLine[] {
  return [...lines, lineFromDraft(nextLineId(lines), draft)];
}

/**
 * Rewrite the line with `id` from a form draft, preserving the parts the form doesn't
 * edit (span + dated overrides). Changing kind/target/label/category/base amount all ride.
 */
export function updateLineFromDraft(
  lines: readonly BudgetLine[],
  id: string,
  draft: BudgetLineDraft,
): BudgetLine[] {
  return lines.map((l) => {
    if (l.id !== id) return l;
    const rebuilt = lineFromDraft(l.id, draft);
    return {
      ...rebuilt,
      ...(l.span ? { span: l.span } : {}),
      ...(l.overrides ? { overrides: l.overrides } : {}),
      ...(l.priority !== undefined ? { priority: l.priority } : {}),
    };
  });
}

/** Drop the line with `id`. */
export function removeLine(lines: readonly BudgetLine[], id: string): BudgetLine[] {
  return lines.filter((l) => l.id !== id);
}
