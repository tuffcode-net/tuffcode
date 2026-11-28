export { BASE_SYSTEM_PROMPT, PLAN_MODE_PROMPT } from './base';
export { TOOL_NAMES, TOOL_SCHEMAS } from './tools';
export {
  CONFIG_TOOL,
  EXTRA_TOOL_NAMES,
  EXTRA_TOOL_SCHEMAS,
  MCP_TOOL,
  MEMORY_TOOL,
  SKILL_TOOL,
  TODO_TOOL,
  WEB_FETCH_TOOL,
} from './tools';
export type {
  ExtraToolName,
  ExtraToolSchema,
  ToolName,
  ToolParameterSchema,
  ToolParameterType,
  ToolParameters,
  ToolSchema,
} from './tools';
export {
  COUNCIL_PLANNER_PROMPT,
  COUNCIL_REVIEWER_PROMPT,
  COUNCIL_WORKER_BRIEF_TEMPLATE,
} from './council';
export {
  EXPLORER_PROMPT,
  NOTETAKER_PROMPT,
  PLANNER_PROMPT,
  REVIEWER_PROMPT,
  SUBAGENT_PROMPTS,
  SUBAGENT_ACTIONS,
  SUBAGENT_DEPTHS,
  SUBAGENT_PLANNER_TASKS,
  SUBAGENT_REWORK_LIMIT,
  SUBAGENT_RUN_MINUTES,
  SUBAGENT_TOOL,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_TOOL_PROFILES,
  describeToolProfile,
  isSubagentAction,
  isSubagentDepth,
  SUBAGENT_TYPES,
  WORKER_PROMPT,
  buildSubagentMessage,
  isSubagentType,
  parseNotetakerFacts,
} from './subagents';
export type {
  NotetakerFact,
  SubagentAction,
  SubagentMessageInput,
  SubagentToolDefinition,
  SubagentType,
} from './subagents';
export { parseSubagentFooter } from './footer';
export type { SubagentFooter } from './footer';
export { buildTurnContext, estimateTokens } from './context';
export type { ExecutionMode, TurnContextInput } from './context';
export {
  assemblePrompt,
  ABOUT_USER_HEADING,
  CUSTOM_INSTRUCTIONS_HEADING,
  PROJECT_RULES_HEADING,
  type AssembledPrompt,
  type PromptAssemblyInput,
  type PromptSection,
  type PromptSectionName,
} from './assemble';
export {
  buildCustomInstructions,
  buildPersonalSection,
  CUSTOM_INSTRUCTION_TOKEN_BUDGET,
} from './custom';
export type { PersonalProfile, ResponseStyleName } from './custom';

import { BASE_SYSTEM_PROMPT } from './base';

export interface BuildSystemPromptOptions {
  /** Standing rules from the brain, appended after the static prompt. */
  extraRules?: string[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  const rules = (options.extraRules ?? [])
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0);
  if (rules.length === 0) return BASE_SYSTEM_PROMPT;

  const block = ['', '## Additional rules', ...rules.map((rule, index) => `${index + 1}. ${rule}`)];
  return `${BASE_SYSTEM_PROMPT}\n${block.join('\n')}`;
}
