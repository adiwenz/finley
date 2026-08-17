/**
 * Buttons and icon buttons.
 *
 * Three variants, and the system allows exactly one `primary` per view — the green CTA is the
 * screen's single strongest call, so a second one on the same screen is a design bug rather than
 * a styling choice. `secondary` is the 2px outline (the only 2px border in the system besides a
 * checked radio); `ghost` is the quiet one that fills with `surface-brand-soft` on hover.
 *
 * Hover darkens one step and press scales to .97 with no colour change — never an opacity fade,
 * which is the system's explicit non-pattern for both states.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./icon";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-leaf-700 text-on-brand shadow-xs hover:bg-leaf-800 active:bg-leaf-900 border border-transparent",
  secondary:
    "bg-transparent text-leaf-800 border-2 border-leaf-800 hover:bg-surface-brand-soft",
  ghost:
    "bg-transparent text-leaf-800 border border-transparent hover:bg-surface-brand-soft",
};

const SIZES: Record<Size, string> = {
  sm: "h-[38px] px-4 text-[14px]",
  md: "h-11 px-5 text-[15px]",
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  readonly variant?: Variant;
  readonly size?: Size;
  readonly fullWidth?: boolean;
  readonly iconLeft?: IconName;
  readonly iconRight?: IconName;
  readonly children?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  iconLeft,
  iconRight,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-pill font-sans font-semibold",
        "transition-[background-color,color,box-shadow,transform] duration-150 ease-standard",
        "active:scale-[0.97] disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100",
        VARIANTS[variant],
        SIZES[size],
        fullWidth ? "w-full" : "",
        className,
      ].join(" ")}
      {...rest}
    >
      {iconLeft ? <Icon name={iconLeft} size={16} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={16} /> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  readonly name: IconName;
  /** Required: an icon-only control has no text, so this IS its accessible name. */
  readonly label: string;
  readonly size?: Size;
}

export function IconButton({ name, label, size = "md", className = "", ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={[
        "inline-flex items-center justify-center rounded-pill text-ink-600",
        "transition-[background-color,color,box-shadow,transform] duration-150 ease-standard",
        "hover:bg-surface-brand-soft hover:text-leaf-800 active:scale-[0.97]",
        "disabled:opacity-45 disabled:cursor-not-allowed",
        size === "sm" ? "h-8 w-8" : "h-10 w-10",
        className,
      ].join(" ")}
      {...rest}
    >
      <Icon name={name} size={size === "sm" ? 16 : 18} />
    </button>
  );
}
