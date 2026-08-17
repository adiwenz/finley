/**
 * The design-system surface the app builds screens from.
 *
 * Screens import from here and never from a sibling file directly, so this list IS the set of
 * primitives in play — a screen reaching past it is visible as a deep import in review.
 */

export { Icon, type IconName, type IconProps } from "./icon";
export { Button, IconButton, type ButtonProps, type IconButtonProps } from "./button";
export { Tabs, type Tab, type TabsProps } from "./tabs";
export {
  Input,
  Select,
  Switch,
  type InputProps,
  type SelectProps,
  type SelectOption,
  type SwitchProps,
} from "./field";
export {
  Card,
  Section,
  SummaryTile,
  IconChip,
  EmptyState,
  type CardProps,
  type SectionProps,
  type SummaryTileProps,
  type IconChipProps,
  type EmptyStateProps,
} from "./surfaces";
export { Drawer, type DrawerProps } from "./drawer";
