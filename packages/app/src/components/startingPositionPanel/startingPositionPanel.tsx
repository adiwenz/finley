/**
 * What's already true on day one — a partner, child, loan, or home the household has when
 * the plan starts, as opposed to something that happens ON the timeline.
 *
 * Kept separate from {@link AddEventForm}'s "Add to timeline" menu on purpose: every one of
 * those forms answers "when did this happen?" (`MonthSelect` is their first field), and a
 * holding has no month — its whole point is that it opens at the now marker with today's
 * numbers, never a reconstructed past. Folding it into the timeline menu would mean either a
 * `MonthSelect` that lies or a picker where half the options silently skip a field the other
 * half require.
 */

import { useState } from "react";
import type { Projection, ProjectionResult } from "@finley/engine";
import { ExistingChildForm } from "./existingChildForm";
import { ExistingHomeForm } from "./existingHomeForm";
import { ExistingLoanForm } from "./existingLoanForm";
import { ExistingPartnerForm } from "./existingPartnerForm";
import styles from "./startingPositionPanel.module.css";

type Kind = "partner" | "child" | "loan" | "home";

const ITEMS: readonly { value: Kind; label: string; icon: string }[] = [
  { value: "partner", label: "Partner", icon: "\u{1F465}" },
  { value: "child", label: "Child", icon: "\u{1F476}" },
  { value: "loan", label: "Loan", icon: "\u{1F4B3}" },
  { value: "home", label: "Home", icon: "\u{1F3E1}" },
];

export function StartingPositionPanel({
  result,
  onAdd,
}: {
  /** The live run — read for the one partner the household may already have on day one. */
  result: ProjectionResult;
  onAdd: (write: (projection: Projection) => void) => void;
}) {
  const [open, setOpen] = useState<Kind | null>(null);

  // A partner already covering month 0 is the whole of what makes "add a starting partner"
  // impossible: one partnership at a time, and a starting one always begins in the past. Named
  // in the tile rather than left to a refusal after the form is filled in.
  const startingPartner = result.activePartnerAt(0);

  function toggle(kind: Kind) {
    setOpen((current) => (current === kind ? null : kind));
  }

  function onDone() {
    setOpen(null);
  }

  return (
    <div className={styles.panel}>
      <h2>Starting position</h2>
      <p className="hint">
        What&apos;s already true on day one — before anything on the timeline happens.
      </p>

      <div className={styles.items}>
        {ITEMS.map(({ value, label, icon }) => {
          const taken = value === "partner" && startingPartner !== null;
          return (
            <button
              key={value}
              type="button"
              className={styles.item}
              onClick={() => toggle(value)}
              aria-pressed={open === value}
              disabled={taken}
              title={
                taken
                  ? `You're already partnered with ${startingPartner?.name || "someone"}. ` +
                    `Add a separation first.`
                  : undefined
              }
            >
              <span className={styles.itemIcon}>{icon}</span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {open && (
        <div className={styles.form}>
          {open === "partner" && !startingPartner && (
            <ExistingPartnerForm
              onAdd={onAdd}
              onDone={onDone}
              primaryName={result.household.memberships[0]?.person.name}
            />
          )}
          {open === "child" && <ExistingChildForm onAdd={onAdd} onDone={onDone} />}
          {open === "loan" && <ExistingLoanForm onAdd={onAdd} onDone={onDone} />}
          {open === "home" && <ExistingHomeForm onAdd={onAdd} onDone={onDone} />}
        </div>
      )}
    </div>
  );
}
