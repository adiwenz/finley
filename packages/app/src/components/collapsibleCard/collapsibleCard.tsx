/**
 * A card that opens and closes, for a panel the user consults rather than watches.
 *
 * Some panels answer a question that is live the whole time — what the projection says, what
 * happens next on the timeline — and some hold settings that are set once and revisited. The
 * second kind costs a screenful of everything else to leave open, so it starts CLOSED and the
 * user opens it when they have a reason to.
 *
 * Built on `<details>` rather than a `useState` toggle: the open/closed state, the keyboard
 * behaviour, and the fact that a closed section's contents are hidden from find-in-page and the
 * accessibility tree all come from the element itself, and none of them are worth reimplementing.
 * The heading lives INSIDE the `<summary>` so the section keeps its place in the document
 * outline while being the thing you click — a panel that lost its `<h2>` on the way into a
 * disclosure would be a section nobody can navigate to.
 */

import type { ReactNode } from "react";

export function CollapsibleCard({
  title,
  className,
  children,
}: {
  /** The section's heading — rendered as the `<h2>` the panel would otherwise carry itself. */
  title: string;
  /** Extra classes for the card, as the plain `<div className="card …">` wrappers take. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={`card collapsible${className ? ` ${className}` : ""}`}>
      <summary>
        <h2>{title}</h2>
      </summary>
      {children}
    </details>
  );
}
