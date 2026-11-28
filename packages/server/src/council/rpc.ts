import type { RpcParams } from '@tuffcode/contracts';
import type { RpcHandler, RpcHandlers } from '../rpc.js';
import type { Council } from './types.js';

export interface CouncilHandlerDeps {
  council: Council;
}

/**
 * RPC handlers for council goals. `council.start` creates the goal row and returns
 * before planning starts; progress arrives as `council.updated` events and the goal
 * report is written to the goal thread as an assistant message.
 */
export function createCouncilHandlers(deps: CouncilHandlerDeps): RpcHandlers {
  const handlers = new Map<string, RpcHandler>();
  handlers.set('council.start', (params) =>
    deps.council.start(params as RpcParams<'council.start'>),
  );
  handlers.set('council.cancel', async (params) => {
    const { goalId } = params as RpcParams<'council.cancel'>;
    await deps.council.cancel(goalId);
    return {};
  });
  handlers.set('council.status', (params) =>
    deps.council.status((params as RpcParams<'council.status'>).goalId),
  );
  handlers.set('council.latest', (params) =>
    deps.council.latest((params as RpcParams<'council.latest'>).threadId),
  );
  handlers.set('council.approvePlan', async (params) => {
    const { goalId } = params as RpcParams<'council.approvePlan'>;
    await deps.council.approvePlan(goalId);
    return {};
  });
  handlers.set('council.revisePlan', async (params) => {
    const { goalId, feedback } = params as RpcParams<'council.revisePlan'>;
    await deps.council.revisePlan(goalId, feedback);
    return {};
  });
  handlers.set('council.answerEscalation', async (params) => {
    await deps.council.answerEscalation(params as RpcParams<'council.answerEscalation'>);
    return {};
  });
  return handlers;
}
