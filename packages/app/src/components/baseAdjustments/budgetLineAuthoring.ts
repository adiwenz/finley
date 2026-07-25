/**
 * Which budget-line form is disclosed, if any (§12/§15).
 *
 * One form at a time across the whole editor — the expense rows and the contributions
 * list both open into the same slot — which is why this lives with the panel that
 * arbitrates it rather than inside either list. Its own tiny module so both child
 * editors can name the type without importing each other.
 */
export type LineAuthoring = { readonly kind: "edit"; readonly id: string } | { readonly kind: "new" };
