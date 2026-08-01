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
import type { Projection } from "@finley/engine";
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
  onAdd,
}: {
  onAdd: (write: (projection: Projection) => void) => void;
}) {
  const [open, setOpen] = useState<Kind | null>(null);

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
        {ITEMS.map(({ value, label, icon }) => (
          <button
            key={value}
            type="button"
            className={styles.item}
            onClick={() => toggle(value)}
            aria-pressed={open === value}
          >
            <span className={styles.itemIcon}>{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {open && (
        <div className={styles.form}>
          {open === "partner" && <ExistingPartnerForm onAdd={onAdd} onDone={onDone} />}
          {open === "child" && <ExistingChildForm onAdd={onAdd} onDone={onDone} />}
          {open === "loan" && <ExistingLoanForm onAdd={onAdd} onDone={onDone} />}
          {open === "home" && <ExistingHomeForm onAdd={onAdd} onDone={onDone} />}
        </div>
      )}
    </div>
  );
}
