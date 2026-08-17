/**
 * Pill tabs — the app's only tab style.
 *
 * The selected tab is a white pill with `shadow-xs` sitting in a sunken cream track, which is
 * the design system's second selected-tab treatment (the first, a 3px green underline, belongs
 * to marketing pages). Changing tabs transitions at 220ms rather than the 150ms controls use:
 * a view swap should read as a settle, not a click.
 *
 * `onChange` hands back the tab's value, not an event — a tab strip has no input to read from.
 */

export interface Tab<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface TabsProps<T extends string> {
  readonly tabs: readonly Tab<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Names the strip for assistive tech when the surrounding heading does not. */
  readonly label?: string;
  readonly className?: string;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className = "",
}: TabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={[
        "inline-flex items-center gap-1 rounded-pill bg-surface-sunken p-1",
        className,
      ].join(" ")}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.value)}
            className={[
              "rounded-pill px-4 py-2 font-sans text-[13.5px] font-semibold whitespace-nowrap",
              "transition-[background-color,color,box-shadow] duration-[220ms] ease-out-soft",
              selected
                ? "bg-surface-card text-leaf-900 shadow-xs"
                : "bg-transparent text-ink-600 hover:text-leaf-800",
            ].join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
