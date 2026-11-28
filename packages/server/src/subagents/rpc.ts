import type { RpcParams } from '@tuffcode/contracts';
import type { RpcHandler, RpcHandlers } from '../rpc.js';
import type { Subagents } from './types.js';

export interface SubagentHandlerDeps {
  subagents: Subagents;
}

/**
 * RPC handlers for typed subagents. `subagents.spawn` persists the child as queued
 * and returns before it runs; progress arrives as `subagent.started`, `subagent.event`
 * and `subagent.finished` on the parent thread.
 */
export function createSubagentHandlers(deps: SubagentHandlerDeps): RpcHandlers {
  const handlers = new Map<string, RpcHandler>();
  handlers.set('subagents.spawn', (params) => {
    const { threadId, spec } = params as RpcParams<'subagents.spawn'>;
    return deps.subagents.spawn({ threadId, spec });
  });
  handlers.set('subagents.cancel', async (params) => {
    const { childId } = params as RpcParams<'subagents.cancel'>;
    await deps.subagents.cancel(childId);
    return {};
  });
  handlers.set('subagents.list', (params) =>
    deps.subagents.list((params as RpcParams<'subagents.list'>).threadId),
  );
  handlers.set('subagents.listAll', () => deps.subagents.listAll());
  handlers.set('subagents.get', (params) =>
    deps.subagents.get((params as RpcParams<'subagents.get'>).childId),
  );
  handlers.set('subagents.message', (params) => {
    const { childId, text, rework } = params as RpcParams<'subagents.message'>;
    return deps.subagents.message(childId, text, rework === undefined ? {} : { rework });
  });
  handlers.set('subagents.messages', (params) =>
    deps.subagents.messages((params as RpcParams<'subagents.messages'>).childId),
  );
  handlers.set('subagents.answer', async (params) => {
    const { threadId, questionId, text } = params as RpcParams<'subagents.answer'>;
    await deps.subagents.answer(questionId, text, 'user', threadId);
    return {};
  });
  handlers.set('subagents.close', (params) =>
    deps.subagents.close((params as RpcParams<'subagents.close'>).childId),
  );
  handlers.set('subagents.questions', (params) =>
    deps.subagents.openQuestions((params as RpcParams<'subagents.questions'>).threadId),
  );
  return handlers;
}
