import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ThemeId } from '@tuffcode/contracts';
import type { BundledLanguage, Highlighter, ShikiTransformer } from 'shiki';
import { cn } from './cn';
import { paletteFor } from './themes/palettes';

export type MarkdownTheme = ThemeId;

/**
 * Shiki paints its own page background on the `<pre>`; the design system wants
 * the canvas and border to come from tokens instead.
 */
const stripBackground: ShikiTransformer = {
  name: 'tuffcode-strip-background',
  pre(node) {
    node.properties.style = '';
  },
};

let highlighterPromise: Promise<Highlighter> | null = null;

/** Lazily load one Shiki highlighter for the whole renderer. */
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import('shiki').then((shiki) =>
    shiki.createHighlighter({ themes: ['github-dark-default', 'github-light-default'], langs: [] }),
  );
  return highlighterPromise;
}

async function highlightCode(
  code: string,
  lang: string,
  theme: MarkdownTheme,
): Promise<string | null> {
  try {
    const highlighter = await getHighlighter();
    const syntax = paletteFor(theme).syntax;
    if (!highlighter.getLoadedThemes().includes(syntax)) {
      await highlighter.loadTheme(syntax);
    }
    if (!highlighter.getLoadedLanguages().includes(lang)) {
      await highlighter.loadLanguage(lang as BundledLanguage);
    }
    return highlighter.codeToHtml(code, {
      lang,
      theme: syntax,
      transformers: [stripBackground],
    });
  } catch {
    return null;
  }
}

/** react-markdown hands every custom component the hast `node`; never forward it to the DOM. */
function withoutNode<P extends { node?: unknown }>(props: P): Omit<P, 'node'> {
  const { node: _node, ...rest } = props;
  return rest;
}

interface CodeBlockProps {
  code: string;
  lang: string;
  theme: MarkdownTheme;
}

function CodeBlock({ code, lang, theme }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!lang) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    setHtml(null);
    void highlightCode(code, lang, theme).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  if (html) {
    return (
      <div
        className="my-3 overflow-x-auto rounded-md border border-border bg-surface-raised p-3 font-mono text-[13px] leading-5 [&_pre]:m-0 [&_pre]:bg-transparent"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="my-3 overflow-x-auto rounded-md border border-border bg-surface-raised p-3 font-mono text-[13px] leading-5 text-foreground">
      <code>{code}</code>
    </pre>
  );
}

function languageOf(className: string | undefined): string {
  const match = /language-([\w-]+)/.exec(className ?? '');
  return match?.[1] ?? '';
}

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => (typeof child === 'string' ? child : ''))
    .join('');
}

/**
 * Anchor props for one rendered markdown link. With a click hook the host owns the
 * navigation (the desktop bridge opens the system browser), so the anchor must not
 * open a second window; without one the browser keeps its usual new-tab behavior.
 */
export function linkProps(
  href: string | undefined,
  className: string | undefined,
  onLinkClick: ((href: string) => void) | undefined,
): AnchorHTMLAttributes<HTMLAnchorElement> {
  const merged = cn('text-info-foreground underline underline-offset-2 hover:text-info', className);
  if (onLinkClick === undefined) {
    return { href, className: merged, rel: 'noreferrer', target: '_blank' };
  }
  return {
    href,
    className: merged,
    onClick: (event) => {
      event.preventDefault();
      if (href !== undefined) onLinkClick(href);
    },
    // A middle click never fires `click`; without this it asks Electron for a window,
    // which the shell denies, so the gesture would do nothing at all.
    onAuxClick: (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      if (href !== undefined) onLinkClick(href);
    },
  };
}

export interface MarkdownProps {
  /** Markdown source. Raw HTML is never rendered. */
  content: string;
  theme?: MarkdownTheme;
  className?: string;
  /**
   * Hands link clicks to the host instead of the browser. The desktop shell opens
   * web links in the system browser and refuses every other scheme.
   */
  onLinkClick?: (href: string) => void;
}

export function Markdown({ content, theme = 'dark', className, onLinkClick }: MarkdownProps) {
  const components = useMemo<Components>(
    () => ({
      h1: ({ className: cls, ...props }) => (
        <h1
          className={cn('mt-6 mb-3 text-xl font-semibold tracking-tight first:mt-0', cls)}
          {...withoutNode(props)}
        />
      ),
      h2: ({ className: cls, ...props }) => (
        <h2
          className={cn('mt-5 mb-2 text-lg font-semibold tracking-tight', cls)}
          {...withoutNode(props)}
        />
      ),
      h3: ({ className: cls, ...props }) => (
        <h3 className={cn('mt-4 mb-2 text-base font-semibold', cls)} {...withoutNode(props)} />
      ),
      h4: ({ className: cls, ...props }) => (
        <h4 className={cn('mt-4 mb-1 text-sm font-semibold', cls)} {...withoutNode(props)} />
      ),
      p: ({ className: cls, ...props }) => (
        <p className={cn('my-3 leading-6 first:mt-0 last:mb-0', cls)} {...withoutNode(props)} />
      ),
      a: ({ className: cls, href, children, ...props }) => (
        <a {...linkProps(href, cls, onLinkClick)} {...withoutNode(props)}>
          {children}
        </a>
      ),
      ul: ({ className: cls, ...props }) => (
        <ul className={cn('my-3 ml-5 list-disc space-y-1', cls)} {...withoutNode(props)} />
      ),
      ol: ({ className: cls, ...props }) => (
        <ol className={cn('my-3 ml-5 list-decimal space-y-1', cls)} {...withoutNode(props)} />
      ),
      li: ({ className: cls, ...props }) => (
        <li className={cn('leading-6', cls)} {...withoutNode(props)} />
      ),
      blockquote: ({ className: cls, ...props }) => (
        <blockquote
          className={cn('my-3 border-l-2 border-border pl-3 text-muted-foreground', cls)}
          {...withoutNode(props)}
        />
      ),
      hr: ({ className: cls, ...props }) => (
        <hr className={cn('my-5 border-0 border-t border-border', cls)} {...withoutNode(props)} />
      ),
      table: ({ className: cls, ...props }) => (
        <div className="my-3 overflow-x-auto">
          <table className={cn('w-full border-collapse text-sm', cls)} {...withoutNode(props)} />
        </div>
      ),
      thead: ({ className: cls, ...props }) => (
        <thead className={cn('border-b border-border', cls)} {...withoutNode(props)} />
      ),
      th: ({ className: cls, ...props }) => (
        <th
          className={cn('px-2 py-1.5 text-left text-xs font-medium text-muted-foreground', cls)}
          {...withoutNode(props)}
        />
      ),
      td: ({ className: cls, ...props }) => (
        <td
          className={cn('border-t border-border px-2 py-1.5 align-top', cls)}
          {...withoutNode(props)}
        />
      ),
      strong: ({ className: cls, ...props }) => (
        <strong className={cn('font-semibold text-foreground', cls)} {...withoutNode(props)} />
      ),
      pre: ({ children }) => {
        const child = Children.toArray(children)[0];
        if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
          return <pre className="my-3 overflow-x-auto font-mono text-[13px]">{children}</pre>;
        }
        const code = textOf(child.props.children).replace(/\n$/, '');
        return <CodeBlock code={code} lang={languageOf(child.props.className)} theme={theme} />;
      },
      code: ({ className: cls, children, ...props }) => (
        <code
          className={cn(
            'rounded-sm bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground',
            cls,
          )}
          {...withoutNode(props)}
        >
          {children}
        </code>
      ),
      img: ({ className: cls, alt = '', ...props }) => (
        <img
          className={cn('my-3 max-w-full rounded-md border border-border', cls)}
          alt={alt}
          {...withoutNode(props)}
        />
      ),
    }),
    [theme, onLinkClick],
  );

  return (
    <div className={cn('text-sm text-foreground', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
}
