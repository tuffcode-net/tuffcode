import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  PermissionOption,
  RequestPermissionRequest,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { AdapterEvent } from '@tuffcode/contracts';
import {
  buildPromptBlocks,
  choosePermissionOption,
  decidePermission,
  emptyTranslationState,
  mapStopReason,
  translatePermissionRequest,
  translateSessionUpdate,
  type TranslationState,
} from './translate.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/acp/${name}`, import.meta.url), 'utf8')) as T;
}

function translateAll(updates: SessionUpdate[], turnId = 'turn-1'): AdapterEvent[] {
  let state: TranslationState = emptyTranslationState;
  const events: AdapterEvent[] = [];
  for (const update of updates) {
    const result = translateSessionUpdate(update, turnId, state);
    state = result.state;
    events.push(...result.events);
  }
  return events;
}

describe('translateSessionUpdate', () => {
  it('maps the recorded session update stream onto contract events', () => {
    const updates = loadFixture<SessionUpdate[]>('session-updates.json');
    const events = translateAll(updates);

    expect(events).toEqual([
      { type: 'reasoning.delta', turnId: 'turn-1', text: 'Checking the worktree layout.' },
      { type: 'text.delta', turnId: 'turn-1', text: 'I will update the config.' },
      {
        type: 'tool.started',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        name: 'read',
        input: { path: 'package.json' },
      },
      {
        type: 'tool.delta',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        text: '{"name":"tuffcode"}',
      },
      {
        type: 'tool.finished',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        output: '{"name":"tuffcode"}',
        isError: false,
      },
      {
        type: 'tool.started',
        turnId: 'turn-1',
        toolCallId: 'call-2',
        name: 'Run tests',
        input: null,
      },
      {
        type: 'tool.finished',
        turnId: 'turn-1',
        toolCallId: 'call-2',
        output: '1 passed',
        isError: false,
      },
      {
        type: 'tool.started',
        turnId: 'turn-1',
        toolCallId: 'plan:default',
        name: 'plan',
        input: {
          planId: 'default',
          entries: [
            { content: 'Read files', priority: 'high', status: 'completed' },
            { content: 'Apply edit', priority: 'high', status: 'in_progress' },
          ],
        },
      },
      {
        type: 'tool.delta',
        turnId: 'turn-1',
        toolCallId: 'plan:default',
        text: '- [x] Read files\n- [~] Apply edit',
      },
      { type: 'usage', turnId: 'turn-1', inputTokens: 1200, costUsd: 0.012 },
      {
        type: 'tool.finished',
        turnId: 'turn-1',
        toolCallId: 'plan:default',
        output: '',
        isError: false,
      },
    ]);
  });

  it('emits only appended text when a tool content collection grows', () => {
    const first: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-9',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'line one\n' } }],
    };
    const second: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-9',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'line one\nline two\n' } }],
    };

    const started = translateSessionUpdate(first, 't', emptyTranslationState);
    expect(started.events).toEqual([
      { type: 'tool.started', turnId: 't', toolCallId: 'call-9', name: 'call-9', input: null },
      { type: 'tool.delta', turnId: 't', toolCallId: 'call-9', text: 'line one\n' },
    ]);

    const grown = translateSessionUpdate(second, 't', started.state);
    expect(grown.events).toEqual([
      { type: 'tool.delta', turnId: 't', toolCallId: 'call-9', text: 'line two\n' },
    ]);
  });

  it('replaces the whole text when a tool rewrites its content', () => {
    const first = translateSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-10',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'old output' } }],
      },
      't',
      emptyTranslationState,
    );
    const replaced = translateSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-10',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'new output' } }],
      },
      't',
      first.state,
    );

    expect(replaced.events).toEqual([
      { type: 'tool.delta', turnId: 't', toolCallId: 'call-10', text: 'new output' },
      {
        type: 'tool.finished',
        turnId: 't',
        toolCallId: 'call-10',
        output: 'new output',
        isError: true,
      },
    ]);
  });

  it('maps markdown plans and ignores removals of unknown plans', () => {
    const markdown = translateSessionUpdate(
      {
        sessionUpdate: 'plan_update',
        plan: { type: 'markdown', planId: 'p1', content: '1. ship it', path: null },
      },
      't',
      emptyTranslationState,
    );
    expect(markdown.events).toEqual([
      {
        type: 'tool.started',
        turnId: 't',
        toolCallId: 'plan:p1',
        name: 'plan',
        input: { planId: 'p1', path: null },
      },
      { type: 'tool.delta', turnId: 't', toolCallId: 'plan:p1', text: '1. ship it' },
    ]);

    const removed = translateSessionUpdate(
      { sessionUpdate: 'plan_removed', planId: 'unknown' },
      't',
      markdown.state,
    );
    expect(removed.events).toEqual([]);
  });

  it('ignores updates the contract cannot express', () => {
    const result = translateSessionUpdate(
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      't',
      emptyTranslationState,
    );
    expect(result.events).toEqual([]);
    expect(result.state).toBe(emptyTranslationState);
  });
});

describe('permission translation', () => {
  it('builds an approval.requested event from the recorded permission request', () => {
    const request = loadFixture<RequestPermissionRequest>('permission-request.json');
    expect(translatePermissionRequest(request, 'turn-1', 'appr_1')).toEqual({
      type: 'approval.requested',
      turnId: 'turn-1',
      approvalId: 'appr_1',
      toolCallId: 'call-3',
      name: 'write',
      input: { path: 'config.json' },
    });
  });

  it('honors the permission mode and tool kind', () => {
    expect(decidePermission('full-auto', 'execute')).toBe('allow');
    expect(decidePermission('ask', 'read')).toBe('ask');
    expect(decidePermission('read-only', 'read')).toBe('allow');
    expect(decidePermission('read-only', 'search')).toBe('allow');
    expect(decidePermission('read-only', 'edit')).toBe('deny');
    expect(decidePermission('read-only', 'execute')).toBe('deny');
    expect(decidePermission('accept-edits', 'edit')).toBe('allow');
    expect(decidePermission('accept-edits', 'execute')).toBe('ask');
    expect(decidePermission('accept-edits', null)).toBe('ask');
  });

  it('chooses the ACP option that matches the approval choice', () => {
    const request = loadFixture<RequestPermissionRequest>('permission-request.json');
    const options: PermissionOption[] = request.options;

    expect(choosePermissionOption(options, 'allow')?.optionId).toBe('allow-once');
    expect(choosePermissionOption(options, 'allow-thread')?.optionId).toBe('allow-always');
    expect(choosePermissionOption(options, 'deny')?.optionId).toBe('reject-once');
    expect(choosePermissionOption([], 'allow')).toBeNull();
  });
});

describe('stop reasons and prompts', () => {
  it('maps ACP stop reasons to contract outcomes', () => {
    expect(mapStopReason('end_turn', false)).toBe('complete');
    expect(mapStopReason('max_tokens', false)).toBe('complete');
    expect(mapStopReason('refusal', false)).toBe('complete');
    expect(mapStopReason('cancelled', false)).toBe('interrupted');
    expect(mapStopReason('end_turn', true)).toBe('interrupted');
  });

  it('builds text and resource link prompt blocks', () => {
    const blocks = buildPromptBlocks('hello', [
      { path: 'C:/work/a.txt', kind: 'file' },
      { path: 'C:/work/b.png', kind: 'image', mimeType: 'image/png' },
    ]);

    expect(blocks).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'resource_link', name: 'a.txt', uri: 'file:///C:/work/a.txt' },
      {
        type: 'resource_link',
        name: 'b.png',
        uri: 'file:///C:/work/b.png',
        mimeType: 'image/png',
      },
    ]);
  });

  it('sends an inline image as an image block when the agent accepts images', () => {
    const blocks = buildPromptBlocks(
      'what is this?',
      [{ kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'AAAA' }],
      { imageCapable: true },
    );

    expect(blocks).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  it('names an inline image the agent cannot take instead of dropping it', () => {
    const blocks = buildPromptBlocks(
      'look',
      [{ kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'AAAA' }],
      { imageCapable: false },
    );

    expect(blocks).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'text',
        text: '[Image attached: shot.png - this agent cannot receive images]',
      },
    ]);
  });
});
