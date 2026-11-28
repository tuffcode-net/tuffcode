import type { SubagentFooterStatus } from '@tuffcode/contracts';

/**
 * The footer every child prompt asks for: `STATUS`, `SUMMARY`, `FILES` and
 * `OPEN QUESTIONS`. A child writes prose around it and may write it in Markdown, so the
 * parser is deliberately tolerant: a missing section is null, an unrecognised status is
 * null, and nothing here rejects. The child's raw answer is the report; these fields are
 * a convenience the parent reads, never a replacement for the text.
 */

export interface SubagentFooter {
  /** The status the child declared, or null when it stated none it recognised. */
  status: SubagentFooterStatus | null;
  summary: string | null;
  /** One entry per path the child listed, in the order it listed them. */
  files: string[];
  openQuestions: string | null;
}

/**
 * One section header. The leading class accepts the Markdown a child commonly writes
 * (`**STATUS:**`, `- STATUS:`, `### SUMMARY:`, `> FILES:`); the value may share the line.
 */
const HEADER = /^[\s>*_#-]*\*{0,2}\s*(STATUS|SUMMARY|FILES|OPEN QUESTIONS)\s*\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/i;

function parseStatus(lines: readonly string[]): SubagentFooterStatus | null {
  const first = (lines[0] ?? '').trim().toLowerCase().replace(/[.;:,!]+$/g, '');
  // "done | partial | blocked" is the prompt's own template line, not a declaration.
  if (first.length === 0 || first.includes('|') || first.includes('/')) return null;
  const word = first.split(/\s+/)[0] ?? '';
  return word === 'done' || word === 'partial' || word === 'blocked' ? word : null;
}

function joinSection(lines: readonly string[]): string | null {
  const text = lines.join('\n').trim();
  return text.length === 0 ? null : text;
}

function parseFiles(lines: readonly string[]): string[] {
  const files: string[] = [];
  for (const line of lines) {
    const flat = line.replace(/^\s*(?:[-*+]|\d+\.)\s*/, '').trim();
    if (flat.length === 0) continue;
    for (const part of flat.split(',')) {
      const file = part.trim();
      if (file.length === 0 || file.toLowerCase() === 'none') continue;
      if (!files.includes(file)) files.push(file);
    }
  }
  return files;
}

/**
 * Reads the footer out of a child's last answer. Only the first occurrence of each
 * section counts, so a quoted earlier report inside the answer cannot override the
 * real footer. A section runs until the next recognised header.
 */
export function parseSubagentFooter(text: string): SubagentFooter {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const match = HEADER.exec(rawLine);
    if (match !== null) {
      const key = (match[1] ?? '').toUpperCase();
      current = sections.has(key) ? null : key;
      if (current === null) continue;
      const value = (match[2] ?? '').trim();
      sections.set(key, value.length === 0 ? [] : [value]);
      continue;
    }
    if (current === null) continue;
    sections.get(current)?.push(rawLine);
  }
  return {
    status: parseStatus(sections.get('STATUS') ?? []),
    summary: joinSection(sections.get('SUMMARY') ?? []),
    files: parseFiles(sections.get('FILES') ?? []),
    openQuestions: joinSection(sections.get('OPEN QUESTIONS') ?? []),
  };
}
