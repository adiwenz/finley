/**
 * Which budget-line form is disclosed, and what a list can do about it. Expense rows and the
 * contributions list open into the same slot — one form at a time — so the state and the
 * actions live here rather than inside either list.
 */

import type { BudgetLineDraft } from "./budgetLines";

export type LineAuthoring = { readonly kind: "edit"; readonly id: string } | { readonly kind: "new" };

/** What a line list can do to the authored budget: disclose a form, save it, delete a line. */
export interface LineFormActions {
  /** Open this line's edit form, or close it if it is the one already open. */
  readonly onToggle: (id: string) => void;
  readonly onSubmit: (id: string, draft: BudgetLineDraft) => void;
  readonly onClose: () => void;
  readonly onDelete: (id: string) => void;
}
