import { z } from 'zod';
import { PermissionModeSchema, ReasoningEffortSchema, type GoalAutonomy } from './entities.js';
import { THEME_IDS, type ThemeId } from './themes.js';

export const ThemeSchema = z.enum(THEME_IDS);
export type Theme = ThemeId;

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const UpdateChannelSchema = z.enum(['stable', 'beta']);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export const InterfaceSizeSchema = z.enum(['compact', 'default', 'comfortable']);
export type InterfaceSize = z.infer<typeof InterfaceSizeSchema>;

export const CursorStyleSchema = z.enum(['block', 'bar', 'underline']);
export type CursorStyle = z.infer<typeof CursorStyleSchema>;

export const SubagentModelChoiceSchema = z.object({
  providerId: z.string().optional(),
  model: z.string().optional(),
  fallbackModel: z.string().optional(),
  /** Absent or null inherits the provider's own reasoning effort. */
  effort: ReasoningEffortSchema.nullable().optional(),
});
export type SubagentModelChoice = z.infer<typeof SubagentModelChoiceSchema>;

/**
 * Autonomy for a goal started from either entry point. Settings carry no council
 * field, so the permission default is the user's stated trust level: full auto means
 * the council may merge without a captain, anything stricter leaves the decision to
 * the user. The composer and the `/council` command must agree, so both call this.
 */
export function councilAutonomy(
  settings: Pick<Settings, 'defaultPermissionMode'> | null | undefined,
): GoalAutonomy {
  return settings?.defaultPermissionMode === 'full-auto' ? 'auto' : 'manual';
}

export const SubagentModelsSchema = z.object({
  explorer: SubagentModelChoiceSchema.default({}),
  reviewer: SubagentModelChoiceSchema.default({}),
  notetaker: SubagentModelChoiceSchema.default({}),
  worker: SubagentModelChoiceSchema.default({}),
  planner: SubagentModelChoiceSchema.default({}),
});
export type SubagentModels = z.infer<typeof SubagentModelsSchema>;

/** Every subagent type starts with an empty model choice. */
export const emptySubagentModels = (): SubagentModels => ({
  explorer: {},
  reviewer: {},
  notetaker: {},
  worker: {},
  planner: {},
});

/** "Your Tuffcode": who the user is, rendered into the prompt as a short About section. */
export const ProfileSchema = z.object({
  name: z.string().max(80),
  role: z.string().max(120),
  about: z.string().max(2000),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ResponseStyleSchema = z.enum(['default', 'concise', 'detailed']);
export type ResponseStyle = z.infer<typeof ResponseStyleSchema>;

/**
 * Feature switches. Brain memory has its own `brainEnabled` field (older than this
 * object), so it is not repeated here; the Capabilities section writes that field.
 */
export const CapabilitiesSchema = z.object({
  skills: z.boolean(),
  connectors: z.boolean(),
  subagents: z.boolean(),
  todo: z.boolean(),
  worktrees: z.boolean(),
  webFetch: z.boolean(),
  browser: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const DEFAULT_CAPABILITIES: Capabilities = {
  skills: true,
  connectors: true,
  subagents: true,
  todo: true,
  worktrees: true,
  webFetch: true,
  browser: true,
};

export const NotificationSettingsSchema = z.object({
  turnFinished: z.boolean(),
  approvalNeeded: z.boolean(),
  subagentFinished: z.boolean(),
  councilEscalation: z.boolean(),
  sound: z.boolean(),
  /** Only notify while the window is not focused. */
  onlyWhenUnfocused: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  turnFinished: true,
  approvalNeeded: true,
  subagentFinished: true,
  councilEscalation: true,
  sound: true,
  onlyWhenUnfocused: true,
};

/** Custom instructions are stored up to this length; the prompt budget is in the prompt package. */
export const CUSTOM_INSTRUCTIONS_MAX_CHARS = 16000;

const SettingsFields = {
  theme: ThemeSchema,
  shell: z.string().nullable(),
  defaultPermissionMode: PermissionModeSchema,
  defaultProviderId: z.string().nullable(),
  defaultModelId: z.string().nullable(),
  worktreeRoot: z.string().nullable(),
  logLevel: LogLevelSchema,
  brainEnabled: z.boolean(),
  updateChannel: UpdateChannelSchema,
  keybindings: z.record(z.string(), z.string()),
  interfaceSize: InterfaceSizeSchema,
  fontSize: z.number().int().min(12).max(20),
  sidebarWidth: z.number().int().min(208).max(360),
  panelAnimation: z.boolean(),
  enabledTools: z.string().array(),
  terminalScrollback: z.number().int().nonnegative(),
  terminalFontSize: z.number().int().min(11).max(20),
  cursorStyle: CursorStyleSchema,
  checkUpdatesOnStart: z.boolean(),
  customInstructions: z.string().max(CUSTOM_INSTRUCTIONS_MAX_CHARS),
  profile: ProfileSchema,
  responseStyle: ResponseStyleSchema,
  /** False pauses automatic memory capture; recall keeps working while `brainEnabled` is on. */
  brainCapture: z.boolean(),
  capabilities: CapabilitiesSchema,
  notifications: NotificationSettingsSchema,
  /** Block system sleep while any agent turn is running. */
  keepAwake: z.boolean(),
  subagentModels: SubagentModelsSchema,
  subagentConcurrency: z.number().int().min(1).max(8),
  contextWarningThreshold: z.number().min(0.5).max(0.95),
  autoCompact: z.boolean(),
  maxOutputTokens: z.number().int().min(256).max(65536),
  showContextMeter: z.boolean(),
  paneLayout: z.unknown().optional(),
};

export const SettingsSchema = z.object({
  theme: SettingsFields.theme.default('dark'),
  shell: SettingsFields.shell.default(null),
  defaultPermissionMode: SettingsFields.defaultPermissionMode.default('ask'),
  defaultProviderId: SettingsFields.defaultProviderId.default(null),
  defaultModelId: SettingsFields.defaultModelId.default(null),
  worktreeRoot: SettingsFields.worktreeRoot.default(null),
  logLevel: SettingsFields.logLevel.default('info'),
  brainEnabled: SettingsFields.brainEnabled.default(true),
  updateChannel: SettingsFields.updateChannel.default('stable'),
  keybindings: SettingsFields.keybindings.default(() => ({})),
  interfaceSize: SettingsFields.interfaceSize.default('default'),
  fontSize: SettingsFields.fontSize.default(14),
  sidebarWidth: SettingsFields.sidebarWidth.default(256),
  panelAnimation: SettingsFields.panelAnimation.default(false),
  enabledTools: SettingsFields.enabledTools.default(() => [
    'bash',
    'read',
    'edit',
    'write',
    'glob',
    'grep',
  ]),
  terminalScrollback: SettingsFields.terminalScrollback.default(5000),
  terminalFontSize: SettingsFields.terminalFontSize.default(13),
  cursorStyle: SettingsFields.cursorStyle.default('bar'),
  checkUpdatesOnStart: SettingsFields.checkUpdatesOnStart.default(true),
  customInstructions: SettingsFields.customInstructions.default(''),
  profile: SettingsFields.profile.default(() => ({ name: '', role: '', about: '' })),
  responseStyle: SettingsFields.responseStyle.default('default'),
  brainCapture: SettingsFields.brainCapture.default(true),
  capabilities: SettingsFields.capabilities.default(() => ({ ...DEFAULT_CAPABILITIES })),
  notifications: SettingsFields.notifications.default(() => ({ ...DEFAULT_NOTIFICATIONS })),
  keepAwake: SettingsFields.keepAwake.default(false),
  subagentModels: SettingsFields.subagentModels.default(emptySubagentModels),
  subagentConcurrency: SettingsFields.subagentConcurrency.default(4),
  contextWarningThreshold: SettingsFields.contextWarningThreshold.default(0.8),
  autoCompact: SettingsFields.autoCompact.default(true),
  maxOutputTokens: SettingsFields.maxOutputTokens.default(8192),
  showContextMeter: SettingsFields.showContextMeter.default(true),
  paneLayout: SettingsFields.paneLayout,
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = z.object(SettingsFields).partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
