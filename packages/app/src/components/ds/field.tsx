/**
 * Form fields: text input, select, and switch.
 *
 * All three share the label/hint/error frame, because the system's error rule is a swap rather
 * than an addition — an error message REPLACES the hint, so the field never grows a line and
 * shifts the form under the reader's cursor. Errors explain and never scold.
 *
 * Inputs are 14px-radius with a hairline border; focus adds the green ring AND a green border,
 * both from tokens. Money and rates render in mono, which is a signal rather than decoration:
 * a monospaced figure is one the reader is invited to check.
 */

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

interface FrameProps {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}

function Frame({ label, hint, error, htmlFor, children }: FrameProps) {
  const caption = error ?? hint;
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={htmlFor} className="font-sans text-[14px] font-semibold text-ink-900">
          {label}
        </label>
      ) : null}
      {children}
      {caption ? (
        <span
          className={[
            "font-sans text-[13px] leading-snug",
            error ? "text-berry-600" : "text-muted",
          ].join(" ")}
        >
          {caption}
        </span>
      ) : null}
    </div>
  );
}

const CONTROL = [
  "w-full rounded-input border bg-surface-card px-3.5 py-2.5",
  "font-sans text-[15px] text-ink-900 outline-none",
  "transition-[border-color,box-shadow] duration-150 ease-standard",
  "focus:border-border-focus focus:shadow-[var(--focus-ring)]",
  "disabled:opacity-45 disabled:cursor-not-allowed",
].join(" ");

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  /** Renders the value in mono — for currency, rates, and other checkable figures. */
  readonly numeric?: boolean;
}

export function Input({
  label,
  hint,
  error,
  numeric = false,
  className = "",
  id,
  ...rest
}: InputProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <Frame label={label} hint={hint} error={error} htmlFor={fieldId}>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={[
          CONTROL,
          error ? "border-berry-500" : "border-border-default",
          numeric ? "font-mono text-right" : "",
          className,
        ].join(" ")}
        {...rest}
      />
    </Frame>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly options: readonly SelectOption[];
}

export function Select({
  label,
  hint,
  error,
  options,
  className = "",
  id,
  ...rest
}: SelectProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <Frame label={label} hint={hint} error={error} htmlFor={fieldId}>
      <select
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={[
          CONTROL,
          "appearance-none pr-9",
          // The chevron is a background image rather than an overlaid element so the whole
          // control stays one hit target and the native popup still opens from anywhere on it.
          "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22 fill=%22none%22 stroke=%22%234C5A50%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M4 6l4 4 4-4%22/></svg>')] bg-[length:16px_16px] bg-[position:right_14px_center] bg-no-repeat",
          error ? "border-berry-500" : "border-border-default",
          className,
        ].join(" ")}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Frame>
  );
}

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** The control's accessible name when no visible label sits beside it. */
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * The knob is the one element in the system that overshoots (`ease-grow`) — deliberately the
 * only playful motion, so it stays a signature rather than a habit.
 */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-[26px] w-[46px] shrink-0 items-center rounded-pill px-[3px]",
        "transition-colors duration-150 ease-standard",
        "disabled:opacity-45 disabled:cursor-not-allowed",
        checked ? "bg-leaf-600" : "bg-ink-200",
      ].join(" ")}
    >
      <span
        className={[
          "block h-5 w-5 rounded-pill bg-white shadow-xs",
          "transition-transform duration-[220ms] ease-grow",
          checked ? "translate-x-5" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
}
