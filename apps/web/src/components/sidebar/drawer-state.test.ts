import { describe, expect, it } from 'vitest';
import {
  COMPACT_WINDOW_PX,
  PHONE_BREAKPOINT_PX,
  drawerInertsShell,
  isPhoneLayout,
  sidebarPresentation,
} from './drawer-state';

const base = { visible: true, requestedOpen: true, dockVisible: false };

describe('isPhoneLayout', () => {
  it('turns on below the 768px breakpoint', () => {
    expect(PHONE_BREAKPOINT_PX).toBe(768);
    expect(isPhoneLayout(390)).toBe(true);
    expect(isPhoneLayout(PHONE_BREAKPOINT_PX - 1)).toBe(true);
    expect(isPhoneLayout(PHONE_BREAKPOINT_PX)).toBe(false);
    expect(isPhoneLayout(1280)).toBe(false);
  });
});

describe('sidebarPresentation', () => {
  it('renders an open drawer on a phone', () => {
    expect(sidebarPresentation({ ...base, width: 390 })).toEqual({ mode: 'drawer', open: true });
  });

  it('renders a closed drawer on a phone before the user opens it', () => {
    expect(sidebarPresentation({ ...base, width: 390, requestedOpen: false })).toEqual({
      mode: 'drawer',
      open: false,
    });
  });

  it('keeps the drawer available on a phone while the dock is open', () => {
    expect(sidebarPresentation({ ...base, width: 390, dockVisible: true })).toEqual({
      mode: 'drawer',
      open: true,
    });
  });

  it('hides the column behind an open dock on a compact desktop window', () => {
    expect(
      sidebarPresentation({ ...base, width: COMPACT_WINDOW_PX - 1, dockVisible: true }),
    ).toEqual({ mode: 'hidden', open: false });
  });

  it('keeps the column at the compact width when no dock is open', () => {
    expect(sidebarPresentation({ ...base, width: COMPACT_WINDOW_PX - 1 })).toEqual({
      mode: 'column',
      open: true,
    });
  });

  it('keeps the column on a wide window even with the dock open', () => {
    expect(sidebarPresentation({ ...base, width: 1440, dockVisible: true })).toEqual({
      mode: 'column',
      open: true,
    });
  });

  it('hides the sidebar under settings at every width', () => {
    expect(sidebarPresentation({ ...base, width: 390, visible: false })).toEqual({
      mode: 'hidden',
      open: false,
    });
    expect(sidebarPresentation({ ...base, width: 1440, visible: false })).toEqual({
      mode: 'hidden',
      open: false,
    });
  });
});

describe('drawerInertsShell', () => {
  it('leaves the phone shell live while the drawer is closed', () => {
    const closed = sidebarPresentation({ ...base, width: 390, requestedOpen: false });
    expect(closed.mode).toBe('drawer');
    // The regression: treating the phone layout itself as an open drawer made the
    // banner and the conversation inert, so no tap reached them.
    expect(drawerInertsShell(closed)).toBe(false);
  });

  it('inerts the shell only while the drawer covers it', () => {
    expect(drawerInertsShell(sidebarPresentation({ ...base, width: 390 }))).toBe(true);
    expect(drawerInertsShell(sidebarPresentation({ ...base, width: 1440 }))).toBe(false);
    expect(
      drawerInertsShell(
        sidebarPresentation({ ...base, width: 390, visible: false }),
      ),
    ).toBe(false);
  });
});
