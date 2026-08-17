/**
 * The life-change chooser: a two-column grid of what the reader can add to their plan.
 *
 * A grid of described cards rather than a dropdown, because "what do you want to change?" is a
 * browsing question — the reader is often not sure what the app can model, and a collapsed
 * `<select>` hides exactly the vocabulary they need. Each card carries a one-line gloss for the
 * same reason.
 *
 * The options are derived from the add-form's own `EVENT_KINDS`, so a life event the engine
 * gains is a compile error here rather than a card that quietly never appears.
 */

import { EVENT_KINDS, type EventKind } from "../addEventForm/addEventForm";
import { Icon, type IconName } from "../ds";

/** The glyph and gloss per event kind. Keyed by the engine's own type, so it cannot drift. */
const DETAIL: Record<EventKind, { readonly icon: IconName; readonly sub: string }> = {
  LoanEvent: { icon: "landmark", sub: "Borrow for a car, school, or anything else" },
  HomePurchaseEvent: { icon: "home", sub: "Price, down payment, mortgage" },
  OneTimeSpendEvent: { icon: "receipt", sub: "A wedding, a car, a big trip" },
  RelationshipEvent: { icon: "heart-handshake", sub: "Someone joins the household" },
  ChildEvent: { icon: "baby", sub: "Add a child or dependent" },
  SeparationEvent: { icon: "users", sub: "Separate, with support if there is any" },
};

export interface ChangeChooserProps {
  readonly onChoose: (kind: EventKind) => void;
}

export function ChangeChooser({ onChoose }: ChangeChooserProps) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {EVENT_KINDS.map(({ value, label }) => {
        const detail = DETAIL[value];
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChoose(value)}
            className="rounded-card border border-border-subtle bg-surface-card px-3.5 pt-3.5 pb-4 text-left transition-colors duration-150 ease-standard hover:border-leaf-300 hover:bg-surface-brand-soft"
          >
            <span className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-pill bg-surface-brand-soft">
              <Icon name={detail.icon} size={18} color="var(--leaf-700)" />
            </span>
            <span className="block text-[14.5px] leading-snug font-semibold text-leaf-900">
              {label}
            </span>
            <span className="mt-0.5 block text-[12.5px] leading-normal text-muted">
              {detail.sub}
            </span>
          </button>
        );
      })}
    </div>
  );
}
