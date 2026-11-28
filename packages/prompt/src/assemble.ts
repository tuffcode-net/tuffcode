/**
 * One prompt assembly path shared by the turn runner and `prompt.preview`.
 *
 * Section order is fixed: base prompt, custom instructions, project rules, skills,
 * available skills, brain always block, retrieved memory, turn context, user message.
 * Empty optional sections are omitted, so a preview can never show a heading the
 * adapter never receives. Everything except the user message is joined into the system
 * prompt; the user message travels as the turn text.
 */
import { BASE_SYSTEM_PROMPT, CHILD_BASE_SYSTEM_PROMPT, PLAN_MODE_PROMPT } from './base';
import { buildTurnContext, estimateTokens, type TurnContextInput } from './context';
import { buildCustomInstructions, buildPersonalSection, type PersonalProfile, type ResponseStyleName } from './custom';

export const CUSTOM_INSTRUCTIONS_HEADING = '## Custom instructions';
export const ABOUT_USER_HEADING = '## About the user';
export const PROJECT_RULES_HEADING = '## Project rules';
export const REVIEW_COMMENTS_HEADING = '## Review comments';

const BRAIN_NOTES_HEADING = '## Brain notes';
const RETRIEVED_MEMORY_HEADING = '## Retrieved memory';
const SKILLS_HEADING = '## Skills for this message';
const AVAILABLE_SKILLS_HEADING = '## Available skills';

export type PromptSectionName =
  | 'base'
  | 'plan-mode'
  | 'about-user'
  | 'custom-instructions'
  | 'project-rules'
  | 'review-comments'
  | 'skills'
  | 'available-skills'
  | 'brain-always'
  | 'retrieved-memory'
  | 'turn-context'
  | 'user-message';

export interface PromptSection {
  name: PromptSectionName;
  text: string;
  tokens: number;
}

export interface PromptAssemblyInput {
  /**
   * Who the prompt is for. A child gets the scoped base prompt and no skill sections,
   * because its profile offers no skill tool and its brief is the whole task.
   */
  role?: 'main' | 'child';
  /** Raw `settings.customInstructions`; trimmed and capped here. */
  customInstructions?: string;
  /** Rendered project rule blocks from the repository, already budgeted. */
  projectRules?: string;
  /** Unresolved inline review comments from the Changes panel. */
  reviewComments?: string;
  /** Your Tuffcode profile; empty fields are left out. */
  profile?: PersonalProfile;
  responseStyle?: ResponseStyleName;
  /** Rendered brain always block: identity, rules, preferences, project, note. */
  brainAlways?: string;
  /** Rendered memory entries retrieved for this turn. */
  retrievedMemory?: string;
  /** Bodies of the skills the message mentions with `$name`, already rendered. */
  skills?: string;
  /** Name and description lines of the other skills the `skill` tool can load. */
  availableSkills?: string;
  turnContext: TurnContextInput;
  userMessage: string;
}

export interface AssembledPrompt {
  sections: PromptSection[];
  /** Every section except the user message, in assembly order. */
  systemPrompt: string;
  /** The head that does not change per turn: base through the skills list. */
  staticPrefix: string;
  /** Brain, retrieved memory and turn context, which can change every turn. */
  dynamicPrompt: string;
  /** Tokens across all sections, the user message included. */
  total: number;
}

function section(name: PromptSectionName, text: string): PromptSection {
  return { name, text, tokens: estimateTokens(text) };
}

export function assemblePrompt(input: PromptAssemblyInput): AssembledPrompt {
  const isChild = input.role === 'child';
  const custom = buildCustomInstructions(input.customInstructions ?? '');
  const projectRules = input.projectRules?.trim() ?? '';
  const brainAlways = input.brainAlways?.trim() ?? '';
  const retrieved = input.retrievedMemory?.trim() ?? '';
  const skills = input.skills?.trim() ?? '';
  const available = input.availableSkills?.trim() ?? '';

  const sections = [section('base', isChild ? CHILD_BASE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT)];
  // Plan mode is a mode, not a default: shipping its rubric on a work turn both costs
  // tokens and tells the model not to build.
  if (input.turnContext.mode === 'plan') {
    sections.push(section('plan-mode', PLAN_MODE_PROMPT));
  }
  const personal =
    input.profile === undefined ? undefined : buildPersonalSection(input.profile, input.responseStyle);
  if (personal !== undefined) {
    sections.push(section('about-user', `${ABOUT_USER_HEADING}\n${personal}`));
  }
  if (custom !== undefined) {
    sections.push(section('custom-instructions', `${CUSTOM_INSTRUCTIONS_HEADING}\n${custom}`));
  }
  if (projectRules.length > 0) {
    sections.push(
      section(
        'project-rules',
        `${PROJECT_RULES_HEADING}\nRules committed in this repository. Follow them for this turn.\n${projectRules}`,
      ),
    );
  }
  const reviewComments = input.reviewComments?.trim() ?? '';
  if (reviewComments.length > 0) {
    sections.push(
      section(
        'review-comments',
        `${REVIEW_COMMENTS_HEADING}\nUnresolved inline comments from the Changes panel. Address each one this turn.\n${reviewComments}`,
      ),
    );
  }
  if (!isChild && skills.length > 0) {
    sections.push(section('skills', `${SKILLS_HEADING}\n${skills}`));
  }
  if (!isChild && available.length > 0) {
    sections.push(
      section(
        'available-skills',
        `${AVAILABLE_SKILLS_HEADING}\nLoad one with the skill tool only when its description matches the task.\n${available}`,
      ),
    );
  }
  if (brainAlways.length > 0) {
    sections.push(section('brain-always', `${BRAIN_NOTES_HEADING}\n${brainAlways}`));
  }
  if (retrieved.length > 0) {
    sections.push(section('retrieved-memory', `${RETRIEVED_MEMORY_HEADING}\n${retrieved}`));
  }
  sections.push(section('turn-context', buildTurnContext(input.turnContext)));
  sections.push(section('user-message', input.userMessage));

  const systemSections = sections.filter((entry) => entry.name !== 'user-message');
  // Only base, plan mode, the profile and custom instructions are stable per thread.
  // Project rules with globs, skill mentions, the available-skill list and everything
  // from the brain on are message-dependent, so they must sit after the cache breakpoint.
  const splitAt = systemSections.findIndex((entry) =>
    [
      'project-rules',
      // Review comments change whenever the user comments, so they belong after the
      // breakpoint even when a project has no rule files at all.
      'review-comments',
      'skills',
      'available-skills',
      'brain-always',
      'retrieved-memory',
      'turn-context',
    ].includes(entry.name),
  );
  const staticSections = splitAt === -1 ? systemSections : systemSections.slice(0, splitAt);
  const dynamicSections = splitAt === -1 ? [] : systemSections.slice(splitAt);

  return {
    sections,
    systemPrompt: systemSections.map((entry) => entry.text).join('\n\n'),
    staticPrefix: staticSections.map((entry) => entry.text).join('\n\n'),
    dynamicPrompt: dynamicSections.map((entry) => entry.text).join('\n\n'),
    total: sections.reduce((sum, entry) => sum + entry.tokens, 0),
  };
}
