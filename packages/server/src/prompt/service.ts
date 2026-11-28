/**
 * Prompt planning for one turn: brain selection plus the shared assembler.
 *
 * The runner and `prompt.preview` both call `planPrompt`, so what the preview shows is
 * byte-for-byte what the adapter receives. Nothing here reads planning documents; the
 * only files it reads are the repository's own rule files (`AGENTS.md`, `CLAUDE.md`,
 * `.tuffcode/rules/*.md`) and the skill bodies the message asks for. The other
 * user-authored input is `settings.customInstructions`.
 */
import type { Project, Settings, Thread } from '@tuffcode/contracts';
import { assemblePrompt, estimateTokens, type AssembledPrompt } from '@tuffcode/prompt';
import { assembleBrain, type BrainAssembly } from '../brain/service.js';
import { renderBrainEntries } from '../brain/selector.js';
import type { Repos } from '../db/repos/index.js';
import { discoverSkills, readSkillBody, skillRoots } from '../skills/discover.js';
import {
  SKILL_BODY_TOKEN_BUDGET,
  availableSkillsList,
  expandSkillMentions,
  renderSkillSections,
} from '../skills/inject.js';
import { pluginSkillRoots } from '../skills/roots.js';
import { SELF_CONFIG_SKILL, matchesSelfConfigIntent } from '../skills/system.js';
import { loadProjectRules } from './rules.js';
import { subagentChildFor } from '../runner/turn-options.js';

export interface PromptPlanInput {
  thread: Thread;
  project: Project;
  /** The user message for this turn; it is the last section, not the system prompt. */
  message: string;
  settings: Settings;
  now?: Date;
}

export interface PromptPlan {
  assembly: AssembledPrompt;
  brain: BrainAssembly;
  /** `$name` mentions that matched no skill, so the caller can warn once. */
  unknownSkills: string[];
  /** Comments this prompt carried; the runner stamps them delivered after a complete turn. */
  reviewCommentIds: string[];
}

interface SkillPlan {
  skills: string;
  availableSkills: string;
  unknown: string[];
}

/**
 * Skills for one message: mentioned bodies plus the list the `skill` tool loads from.
 * Discovery failures are a skills problem, never a reason to fail the turn.
 */
function planSkills(
  repos: Repos,
  projectPath: string,
  message: string,
  settings: Settings,
): SkillPlan {
  if (!settings.capabilities.skills) return { skills: '', availableSkills: '', unknown: [] };
  try {
    const plugins = pluginSkillRoots(repos);
    const discovered = discoverSkills(projectPath, {
      pluginRoots: plugins,
      onWarning: () => undefined,
    });
    if (discovered.length === 0) return { skills: '', availableSkills: '', unknown: [] };
    const roots = skillRoots(projectPath, plugins);
    const readBody = (skill: { path: string }): string => readSkillBody(skill.path, roots);
    const expansion = expandSkillMentions(message, discovered, readBody);
    const sections = [...expansion.sections];
    // A request to change Tuffcode itself loads the built-in body for this turn, so the
    // model routes config changes through the tool instead of editing the database.
    if (
      matchesSelfConfigIntent(message) &&
      !sections.some((section) => section.name === SELF_CONFIG_SKILL)
    ) {
      const skill = discovered.find((candidate) => candidate.name === SELF_CONFIG_SKILL);
      if (skill !== undefined) {
        const body = readBody(skill).trim();
        const used = sections.reduce((sum, section) => sum + estimateTokens(section.body), 0);
        if (used + estimateTokens(body) <= SKILL_BODY_TOKEN_BUDGET) {
          sections.push({ name: skill.name, body });
        } else {
          expansion.skipped.push(skill.name);
        }
      }
    }
    return {
      skills: renderSkillSections(sections),
      availableSkills: availableSkillsList(
        discovered,
        sections.map((section) => section.name),
      ),
      unknown: expansion.unknown,
    };
  } catch {
    return { skills: '', availableSkills: '', unknown: [] };
  }
}

/** Inline comments the agent has not been told about yet, bounded for the prompt. */
export const REVIEW_COMMENT_LIMIT = 100;
export const REVIEW_COMMENT_CHARS = 500;
/** Tokens the rendered list may take; the heading and instruction add a few more. */
export const REVIEW_COMMENT_TOKEN_BUDGET = 2000;

interface RenderedReviewComments {
  text: string;
  /** Ids of the comments that made it into `text`, for the delivery stamp. */
  ids: string[];
}

/**
 * Newest first, because the comments the user just wrote are the ones that matter.
 * Comments a previous turn already carried are skipped; they stay open, so the panel
 * can show them as sent rather than resolved. Past the count or token budget the list
 * says how many were left out instead of dropping them silently.
 */
function renderReviewComments(repos: Repos, threadId: string): RenderedReviewComments {
  const open = repos.comments
    .list(threadId)
    .filter((comment) => !comment.resolved && comment.deliveredAt === null)
    .reverse();
  const kept: { id: string; line: string }[] = [];
  for (const comment of open.slice(0, REVIEW_COMMENT_LIMIT)) {
    const body = comment.body.replace(/\s+/g, ' ').trim();
    const clipped =
      body.length <= REVIEW_COMMENT_CHARS ? body : `${body.slice(0, REVIEW_COMMENT_CHARS - 3)}...`;
    kept.push({
      id: comment.id,
      line: `- ${comment.filePath}:${comment.line} (${comment.side}): ${clipped}`,
    });
  }
  let omitted = open.length - kept.length;
  const render = (): string => {
    const lines = kept.map((entry) => entry.line);
    if (omitted > 0) {
      lines.push(`... ${omitted} more comment${omitted === 1 ? '' : 's'} omitted`);
    }
    return lines.join('\n');
  };
  while (kept.length > 0 && estimateTokens(render()) > REVIEW_COMMENT_TOKEN_BUDGET) {
    kept.pop();
    omitted += 1;
  }
  return { text: render(), ids: kept.map((entry) => entry.id) };
}

export function planPrompt(repos: Repos, input: PromptPlanInput): PromptPlan {
  const { thread, project, message, settings } = input;
  const now = input.now ?? new Date();
  const brain = assembleBrain(repos, settings, {
    projectId: project.id,
    threadId: thread.id,
    mode: thread.executionMode,
    message,
    now,
  });

  const skillPlan = planSkills(repos, project.path, message, settings);
  const projectRules = loadProjectRules(project.path, message);
  // Only a subagent row makes this a child turn. Council planner, task and review
  // threads also carry a parentThreadId, and they keep the main prompt: they have a
  // conversation, and they are offered the skill tool.
  const role = subagentChildFor(repos, thread.id) === undefined ? 'main' : 'child';
  const reviewComments = renderReviewComments(repos, thread.id);
  const assembly = assemblePrompt({
    role,
    customInstructions: settings.customInstructions,
    projectRules: projectRules.text,
    reviewComments: reviewComments.text,
    profile: settings.profile,
    responseStyle: settings.responseStyle,
    skills: skillPlan.skills,
    availableSkills: skillPlan.availableSkills,
    brainAlways: renderBrainEntries(brain.slice.always),
    retrievedMemory: renderBrainEntries(brain.slice.retrieved),
    turnContext: {
      date: now.toISOString().slice(0, 10),
      mode: thread.executionMode,
      cwd: thread.worktreePath ?? project.path,
      projectName: project.name,
      brainSlice: '',
    },
    userMessage: message,
  });

  return { assembly, brain, unknownSkills: skillPlan.unknown, reviewCommentIds: reviewComments.ids };
}
