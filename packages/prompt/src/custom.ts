/**
 * User-authored custom instructions from settings.
 *
 * The text is trimmed, normalized to LF, capped at 4000 tokens, and truncated at a
 * sentence boundary so the block never crowds out the base prompt or ends mid-word.
 * An empty or whitespace-only value returns undefined, so callers omit the section
 * instead of rendering an empty heading.
 */
import { estimateTokens } from './context';

export const CUSTOM_INSTRUCTION_TOKEN_BUDGET = 4000;

/** The token budget at four characters per token, the same ratio `estimateTokens` uses. */
const MAX_CUSTOM_INSTRUCTION_CHARS = CUSTOM_INSTRUCTION_TOKEN_BUDGET * 4;

const SENTENCE_END = /[.!?](?=\s|$)/g;

/** Length of the longest prefix that ends on a sentence or paragraph boundary. */
function sentenceCutLength(text: string): number {
  let end = -1;
  for (const match of text.matchAll(SENTENCE_END)) {
    end = Math.max(end, (match.index ?? 0) + 1);
  }
  // A paragraph break closes the previous sentence even without punctuation.
  end = Math.max(end, text.lastIndexOf('\n'));
  return end;
}

function truncateAtSentence(text: string): string {
  const window = text.slice(0, MAX_CUSTOM_INSTRUCTION_CHARS);
  const sentenceEnd = sentenceCutLength(window);
  if (sentenceEnd > 0) return window.slice(0, sentenceEnd).trimEnd();

  // One long sentence: fall back to the last word boundary inside the window.
  const whitespace = window.search(/\s+\S*$/);
  if (whitespace > 0) return window.slice(0, whitespace).trimEnd();
  return window.trimEnd();
}

export interface PersonalProfile {
  name: string;
  role: string;
  about: string;
}

export type ResponseStyleName = 'default' | 'concise' | 'detailed';

const STYLE_LINE: Record<ResponseStyleName, string | null> = {
  default: null,
  concise: 'Prefers short answers: lead with the result and skip background unless asked.',
  detailed: 'Prefers thorough answers: explain the reasoning, trade-offs and next steps.',
};

/** "About the user" lines from Your Tuffcode, or undefined when nothing is set. */
export function buildPersonalSection(
  profile: PersonalProfile,
  style: ResponseStyleName = 'default',
): string | undefined {
  const one = (value: string, max: number): string => value.replace(/\s+/g, ' ').trim().slice(0, max);
  const lines: string[] = [];
  const name = one(profile.name, 80);
  const role = one(profile.role, 120);
  const about = profile.about.replace(/\r\n?/g, '\n').trim().slice(0, 2000);
  if (name.length > 0) lines.push(`Name: ${name} (address the user this way).`);
  if (role.length > 0) lines.push(`Role: ${role}.`);
  if (about.length > 0) lines.push(about);
  const styleLine = STYLE_LINE[style];
  if (styleLine !== null) lines.push(styleLine);
  return lines.length === 0 ? undefined : lines.join('\n');
}

export function buildCustomInstructions(text: string): string | undefined {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return undefined;
  if (estimateTokens(normalized) <= CUSTOM_INSTRUCTION_TOKEN_BUDGET) return normalized;
  return truncateAtSentence(normalized);
}
