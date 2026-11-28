// oxlint-disable-next-line import/no-unassigned-import -- the design tokens ship with the package entry
import './tokens.css';

export { cn } from './cn';
export { disabledState, focusRing } from './states';

export {
  STATUS_DOT_CLASS,
  STATUS_LABEL,
  STATUS_TEXT_CLASS,
  STATUS_TONE,
  THREAD_STATUSES,
  type StatusKey,
  type StatusTone,
  type ThreadStatus,
} from './status';

export { Button, buttonVariants, type ButtonProps, type ButtonVariantProps } from './button';
export { IconButton, type IconButtonProps } from './icon-button';
export { Input, type InputProps } from './input';
export { Textarea, type TextareaProps } from './textarea';
export { Select, type SelectOption, type SelectProps } from './select';
export {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  type DialogContentProps,
  type DialogDescriptionProps,
  type DialogTitleProps,
} from './dialog';
export {
  PopoverClose,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  type PopoverContentProps,
} from './popover';
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  type TooltipContentProps,
} from './tooltip';
export {
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTab,
  type TabsListProps,
  type TabsTabProps,
} from './tabs';
export { Badge, badgeVariants, type BadgeProps } from './badge';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardDescriptionProps,
  type CardProps,
  type CardTitleProps,
} from './card';
export { Separator, type SeparatorProps } from './separator';
export { ScrollArea, type ScrollAreaProps } from './scroll-area';
export { Kbd, type KbdProps } from './kbd';
export { Spinner, type SpinnerProps } from './spinner';
export { EmptyState, type EmptyStateProps } from './empty-state';
export { StatusDot, type StatusDotProps } from './status-dot';
// The renderer-heavy pieces live behind subpath exports (`@tuffcode/ui/markdown`,
// `/diff`, `/terminal`) so importing a button does not pull Shiki, the diff viewer and
// xterm into the initial chunk. Types are erased, so they can stay here.
export type { MarkdownProps, MarkdownTheme } from './markdown';
export type { DiffFile, DiffLineComment, DiffLineContext, DiffViewerProps } from './diff';
export type { TerminalHandle, TerminalProps } from './terminal';
export {
  TERMINAL_CURSOR_STYLE,
  TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  terminalOptions,
  type TerminalAppearance,
  type TerminalCursorStyle,
  type TerminalOptions,
} from './terminal-options';
export { PERMISSION_LABEL } from './labels';
export {
  ANSI_NAMES,
  PALETTES,
  THEME_TOKEN_NAMES,
  paletteFor,
  paletteToXterm,
  type AnsiName,
  type ThemePalette,
  type ThemeTokenName,
} from './themes/palettes';
export { applyThemePalette } from './themes/apply';
