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
 * The editable shape of a budget line, in the terms the form speaks. `kind` chooses
 * expense vs. account contribution; `accountId` names the target for a contribution
 * (ignored for an expense). Dollars are cents; category is the needs/wants/savings tier.
 */
export interface BudgetLineDraft {
  readonly label: string;
  readonly category: BudgetCategory;
  readonly monthlyCents: number;
  readonly kind: "expense" | "contribution";
  readonly accountId?: string;
}

/** Expense lines of a budget, in authored order. */
export function expenseLinesOf(lines: readonly BudgetLine[]): BudgetLine[] {
  return lines.filter((l) => l.target.kind === "expense");
}

/** Account-contribution lines of a budget, in authored order. */
export function contributionLinesOf(lines: readonly BudgetLine[]): BudgetLine[] {
  return lines.filter((l) => l.target.kind === "account");
}

/** The starting draft for a new line of the given kind. */
export function blankLineDraft(kind: "expense" | "contribution"): BudgetLineDraft {
  return kind === "contribution"
    ? {
        label: "",
        category: "savings",
        monthlyCents: 500 * 100,
        kind: "contribution",
        accountId: contributionTargets[0]?.accountId,
      }
    : { label: "", category: "needs", monthlyCents: 0, kind: "expense" };
}

/** Read an existing line back into a {@link BudgetLineDraft} to seed the edit form. */
export function lineToDraft(line: BudgetLine): BudgetLineDraft {
  const monthlyCents =
    line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0;
  return line.target.kind === "account"
    ? { label: line.label, category: line.category, monthlyCents, kind: "contribution", accountId: line.target.accountId }
    : { label: line.label, category: line.category, monthlyCents, kind: "expense" };
}

/** The post-tax treatment the engine assigns an account target (default post-tax). */
function treatmentFor(accountId: string | undefined): TaxTreatment {
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
    category: draft.category,
  };
  return draft.kind === "contribution"
    ? {
        ...base,
        target: {
          kind: "account" as const,
          accountId: draft.accountId ?? contributionTargets[0]?.accountId ?? "brokerage",
          taxTreatment: treatmentFor(draft.accountId),
        },
      }
    : { ...base, target: { kind: "expense" as const } };
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
