/**
 * The one path every glyph resolves through.
 *
 * The design system's icon set is Lucide at 2px stroke on a 24px grid, addressed by its
 * kebab-case name. The map is explicit rather than a dynamic lookup for two reasons: only the
 * named glyphs reach the bundle, and the house vocabulary is readable in one place — adding an
 * icon to a screen is a deliberate line here, which is what keeps the set from sprawling.
 *
 * No emoji and no unicode glyphs as icons: a checkmark is `circle-check`, an arrow is
 * `arrow-right`.
 */

import {
  ArrowLeft,
  ArrowRight,
  Baby,
  BookOpen,
  Briefcase,
  BriefcaseBusiness,
  Calculator,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  GraduationCap,
  HeartHandshake,
  Home,
  Landmark,
  PiggyBank,
  Plus,
  Receipt,
  ShieldCheck,
  Sprout,
  Target,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";

const ICONS = {
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  baby: Baby,
  "book-open": BookOpen,
  briefcase: Briefcase,
  "briefcase-business": BriefcaseBusiness,
  calculator: Calculator,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  circle: Circle,
  "circle-check": CircleCheck,
  "circle-dot": CircleDot,
  "graduation-cap": GraduationCap,
  "heart-handshake": HeartHandshake,
  home: Home,
  landmark: Landmark,
  "piggy-bank": PiggyBank,
  plus: Plus,
  receipt: Receipt,
  "shield-check": ShieldCheck,
  sprout: Sprout,
  target: Target,
  "trash-2": Trash2,
  "trending-up": TrendingUp,
  "triangle-alert": TriangleAlert,
  users: Users,
  wallet: Wallet,
  x: X,
} satisfies Record<string, LucideIcon>;

/** Every glyph the app may name. Widening it means adding to {@link ICONS}. */
export type IconName = keyof typeof ICONS;

export interface IconProps {
  readonly name: IconName;
  /** 14px inline with caption text, 16–18px in buttons, 20–21px in nav, 40–48px in icon chips. */
  readonly size?: number;
  /** Defaults to `currentColor`, so an icon inherits the text colour beside it. */
  readonly color?: string;
  readonly className?: string;
}

export function Icon({ name, size = 16, color, className }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      color={color}
      strokeWidth={2}
      absoluteStrokeWidth
      className={className}
      aria-hidden
    />
  );
}
