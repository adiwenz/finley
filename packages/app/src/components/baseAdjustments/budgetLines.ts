/**
 * App-side add / rename / delete for {@link BudgetLine}s — the structural editing beside the
 * panel's amount overrides. A line is either an **expense** (cash outflow) or a
 * **contribution** into a named account, funded by the sim.
 *
 * Contribution targets are limited to the engine's post-tax {@link CONTRIBUTION_TARGETS}
 * (brokerage, cash savings): a post-tax contribution into a pre-tax account would skip the
 * deduction, and pre-tax saving is the job's 401(k) deferral, authored on the job.
 */

import {
  CONTRIBUTION_TARGETS,
  withLinePatch,
  withoutLine,
  type BudgetCategory,
  type BudgetLine,
  type BudgetLineInput,
  type TaxTreatment,
} from "@finley/engine";

export const contributionTargets = CONTRIBUTION_TARGETS;

/**
 * The editable shape of a budget line, in the form's terms. Discriminated on `kind` so that
 * switching kind can never produce a mix — an expense with an account, or a contribution with
 * a "wants" category.
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

export function expenseLinesOf(lines: readonly BudgetLine[]): BudgetLine[] {
  return lines.filter((l) => l.target.kind === "expense");
}

export function contributionLinesOf(lines: readonly BudgetLine[]): BudgetLine[] {
  return lines.filter((l) => l.target.kind === "account");
}

const defaultContributionAccountId = (): string => contributionTargets[0]?.accountId ?? "brokerage";

export function blankLineDraft(kind: "expense" | "contribution"): BudgetLineDraft {
  return kind === "contribution"
    ? { kind: "contribution", label: "", monthlyCents: 500 * 100, accountId: defaultContributionAccountId() }
    : { kind: "expense", label: "", monthlyCents: 0, category: "needs" };
}

/** Seeds the edit form. A non-literal amount source reads back as 0. */
export function lineToDraft(line: BudgetLine): BudgetLineDraft {
  const monthlyCents =
    line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0;
  return line.target.kind === "account"
    ? { kind: "contribution", label: line.label, monthlyCents, accountId: line.target.accountId }
    : { kind: "expense", label: line.label, monthlyCents, category: line.category };
}

/** An unknown account falls back to post-tax. */
function treatmentFor(accountId: string): TaxTreatment {
  return contributionTargets.find((t) => t.accountId === accountId)?.taxTreatment ?? "postTax";
}

/** The line minus its id — the shape the facade's `addBudgetLine` mints an id onto. */
function lineBody(draft: BudgetLineDraft): Omit<BudgetLine, "id"> {
  const base = {
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

/** A draft as the input the facade mints a `line-N` id onto — the add path goes through it. */
export function budgetLineInputFromDraft(draft: BudgetLineDraft): BudgetLineInput {
  return lineBody(draft);
}

/**
 * Rewrites the line from the form's draft, but preserves what the form doesn't edit: span,
 * overrides, priority. A draft is a projection of a line, so this rebuilds and re-attaches
 * rather than patching field-wise like the engine's {@link withLinePatch}.
 */
export function updateLineFromDraft(
  lines: readonly BudgetLine[],
  id: string,
  draft: BudgetLineDraft,
): readonly BudgetLine[] {
  return withLinePatch(lines, id, lineBody(draft));
}

export function removeLine(lines: readonly BudgetLine[], id: string): readonly BudgetLine[] {
  return withoutLine(lines, id);
}
