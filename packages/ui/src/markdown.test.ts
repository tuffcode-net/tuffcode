import { describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import { linkProps } from './markdown';

/** The only part of a React click event the link handler reads. */
function clickEvent() {
  const preventDefault = vi.fn();
  return { event: { preventDefault } as unknown as MouseEvent<HTMLAnchorElement>, preventDefault };
}

describe('markdown link props', () => {
  it('lets the browser open the link in a new tab when no click hook is given', () => {
    const props = linkProps('https://example.com/docs', undefined, undefined);

    expect(props.href).toBe('https://example.com/docs');
    expect(props.target).toBe('_blank');
    expect(props.rel).toBe('noreferrer');
    expect(props.onClick).toBeUndefined();
    expect(props.className).toContain('text-info-foreground');
    expect(props.className).toContain('underline');
  });

  it('keeps the caller class alongside the link treatment', () => {
    const props = linkProps('https://example.com', 'font-medium', undefined);

    expect(props.className).toContain('font-medium');
    expect(props.className).toContain('underline-offset-2');
  });

  it('hands the click to the host instead of opening a window', () => {
    const onLinkClick = vi.fn();
    const props = linkProps('https://example.com/docs', undefined, onLinkClick);
    const { event, preventDefault } = clickEvent();

    expect(props.target).toBeUndefined();
    expect(props.rel).toBeUndefined();
    props.onClick?.(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onLinkClick).toHaveBeenCalledTimes(1);
    expect(onLinkClick).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('forwards the href untouched so the desktop bridge owns the scheme check', () => {
    const onLinkClick = vi.fn();
    const props = linkProps('mailto:help@example.com', undefined, onLinkClick);
    const { event } = clickEvent();

    props.onClick?.(event);

    expect(onLinkClick).toHaveBeenCalledWith('mailto:help@example.com');
  });

  it('preventDefaults an anchor without an href rather than calling the hook', () => {
    const onLinkClick = vi.fn();
    const props = linkProps(undefined, undefined, onLinkClick);
    const { event, preventDefault } = clickEvent();

    props.onClick?.(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it('sends a middle click to the hook instead of asking for a window', () => {
    const onLinkClick = vi.fn();
    const props = linkProps('https://example.com/docs', undefined, onLinkClick);
    const preventDefault = vi.fn();
    const middle = { button: 1, preventDefault } as unknown as MouseEvent<HTMLAnchorElement>;

    props.onAuxClick?.(middle);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onLinkClick).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('ignores a right click on a link', () => {
    const onLinkClick = vi.fn();
    const props = linkProps('https://example.com/docs', undefined, onLinkClick);
    const preventDefault = vi.fn();
    const right = { button: 2, preventDefault } as unknown as MouseEvent<HTMLAnchorElement>;

    props.onAuxClick?.(right);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it('keeps the plain browser new-tab gesture when no hook is given', () => {
    const props = linkProps('https://example.com/docs', undefined, undefined);
    expect(props.onAuxClick).toBeUndefined();
  });
});
