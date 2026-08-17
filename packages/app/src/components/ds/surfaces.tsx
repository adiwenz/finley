/**
 * The surfaces every screen is assembled from: the card, the titled section, the summary tile,
 * the icon chip, and the dashed empty state.
 *
 * At most two background colours per page — the cream field and white cards — so these are the
 * only components that set one. A sunken cream block (`surface-sunken`) is the third tone and is
 * reserved for things nested INSIDE a card, never for a page region.
 *
 * No card ever has a coloured left border, and elevation carries the hierarchy instead: `sm` at
 * rest, `md` on hover for anything clickable.
 */

import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

export interface CardProps {
  readonly children: ReactNode;
  /** Adds the hover lift. Only for cards that are themselves a single click target. */
  readonly interactive?: boolean;
  readonly onClick?: () => void;
  /**
   * The clickable card's accessible name. Without it the button's name is its entire contents —
   * label, figure and caption run together — which is unusable to anyone navigating by name.
   */
  readonly label?: string;
  readonly className?: string;
}

export function Card({
  children,
  interactive = false,
  onClick,
  label,
  className = "",
}: CardProps) {
  const classes = [
    "rounded-card border border-border-subtle bg-surface-card shadow-sm",
    interactive
      ? "cursor-pointer transition-[box-shadow,transform] duration-[220ms] ease-out-soft hover:shadow-md hover:-translate-y-0.5"
      : "",
    className,
  ].join(" ");

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`${classes} w-full text-left`}
      >
        {children}
      </button>
    );
  }
  return <div className={classes}>{children}</div>;
}

export interface SectionProps {
  readonly title: string;
  readonly note?: string;
  /** Sits opposite the title — a tab strip or a filter, never a second primary action. */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A titled panel: the workspace's unit of content, at the 28px panel radius. */
export function Section({ title, note, aside, children, className = "" }: SectionProps) {
  return (
    <section
      className={[
        "rounded-panel border border-border-subtle bg-surface-card px-6 pt-5 pb-6 shadow-sm",
        className,
      ].join(" ")}
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-[20px] leading-snug font-bold tracking-tight text-leaf-900">
            {title}
          </h2>
          {note ? <p className="mt-0.5 text-[13.5px] text-muted">{note}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export interface SummaryTileProps {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

/** A headline figure with its eyebrow. The value is mono — it is a figure you can check. */
export function SummaryTile({ label, value, sub }: SummaryTileProps) {
  return (
    <div className="min-w-[186px] flex-1 rounded-card border border-border-subtle bg-surface-card px-5 py-4 shadow-sm">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 font-mono text-[25px] font-medium tracking-tight text-leaf-900">
        {value}
      </div>
      {sub ? <div className="text-[12.5px] text-muted">{sub}</div> : null}
    </div>
  );
}

export interface IconChipProps {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: string;
  /** The circle behind the glyph; defaults to the brand tint. */
  readonly background?: string;
}

/** The standard way to head a card or a list row: a tinted circle behind a leaf-green glyph. */
export function IconChip({ name, size = 32, color, background }: IconChipProps) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-pill"
      style={{
        width: size,
        height: size,
        background: background ?? "var(--surface-brand-soft)",
      }}
    >
      <Icon name={name} size={Math.round(size * 0.5)} color={color ?? "var(--leaf-700)"} />
    </span>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly body: string;
  readonly align?: "left" | "center";
}

/**
 * The dashed cream block that stands in for absent content. Its copy states what the reader
 * could add and why — never "no data", which tells them nothing they did not already know.
 */
export function EmptyState({ title, body, align = "center" }: EmptyStateProps) {
  return (
    <div
      className={[
        "rounded-card border border-dashed border-border-default bg-surface-sunken p-6",
        align === "center" ? "text-center" : "text-left",
      ].join(" ")}
    >
      <div className="font-display text-[17px] font-semibold text-leaf-900">{title}</div>
      <p className="mt-1 text-[14px] leading-normal text-ink-600">{body}</p>
    </div>
  );
}
