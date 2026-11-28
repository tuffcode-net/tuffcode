/**
 * Phone layout rules for the shell. Above the phone breakpoint the sidebar is a
 * column beside the conversation; below it the sidebar is an overlay drawer that
 * never takes width from the chat, and the dock opens as a sheet over it.
 */

/** Below this window width the shell uses the phone layout. */
export const PHONE_BREAKPOINT_PX = 768;

/** Below this window width an open dock pushes the sidebar out instead of squeezing the chat. */
export const COMPACT_WINDOW_PX = 900;

export function isPhoneLayout(width: number): boolean {
  return width < PHONE_BREAKPOINT_PX;
}

/** A column in the window flow, an overlay drawer, or not rendered at all. */
export type SidebarMode = 'column' | 'drawer' | 'hidden';

export interface SidebarPresentation {
  mode: SidebarMode;
  /** Whether the sidebar is visible now: a column, or an open drawer. */
  open: boolean;
}

export interface SidebarPresentationInput {
  width: number;
  /** Settings owns the window and hides the sidebar entirely. */
  visible: boolean;
  /** The user's toggle state; the desktop column and the phone drawer share it. */
  requestedOpen: boolean;
  /** An open dock competes for the window on a compact desktop window. */
  dockVisible: boolean;
}

/**
 * How the shell renders the sidebar at this width. A phone gets an overlay drawer
 * that opens on request and never takes a column from the conversation, so an open
 * dock cannot hide it. A compact desktop window still pushes the column out for the
 * dock, and a wide window keeps the column exactly as toggled.
 */
/**
 * True only while the phone drawer covers the shell. A closed drawer must leave the
 * banner and the conversation interactive, so this is not the same as "phone layout".
 */
export function drawerInertsShell(presentation: SidebarPresentation): boolean {
  return presentation.mode === 'drawer' && presentation.open;
}

export function sidebarPresentation({
  width,
  visible,
  requestedOpen,
  dockVisible,
}: SidebarPresentationInput): SidebarPresentation {
  if (!visible) return { mode: 'hidden', open: false };
  if (isPhoneLayout(width)) return { mode: 'drawer', open: requestedOpen };
  const open = requestedOpen && !(width < COMPACT_WINDOW_PX && dockVisible);
  return { mode: open ? 'column' : 'hidden', open };
}
