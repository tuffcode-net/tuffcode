import type { RpcResult } from '@tuffcode/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useRpc } from '../../rpc/rpc-context';
import {
  councilErrorMessage,
  isGoalTerminal,
  isPermanentCouncilFailure,
} from '../inspector/council-model';
import { goalIdFromLatest } from './council-goal-source';

export type CouncilStatusResult = RpcResult<'council.status'>;

/** Events carry every task change, so the poll is only a safety net for a missed frame. */
const POLL_INTERVAL_MS = 15_000;

export interface CouncilStatusHandle {
  status: CouncilStatusResult | null;
  /** The newest goal of the thread, or null before the first one. */
  goalId: string | null;
  error: string | null;
  loading: boolean;
  /** Re-resolves the goal and reads it again, for a Retry or after a cancel. */
  reload: () => void;
}

/**
 * Follows the newest goal of one thread: `council.latest` finds it, `council.status`
 * reads it, and `council.updated` keeps it current. Every task change arrives as an
 * event carrying `taskId` and `taskState`, so the hook reloads on it instead of
 * polling; the fifteen second poll only covers a missed frame until the goal is
 * terminal. Starting a goal stays with the composer; this hook only reads.
 */
export function useCouncilStatus(threadId: string): CouncilStatusHandle {
  const rpc = useRpc();
  const [goalId, setGoalId] = useState<string | null>(null);
  const [status, setStatus] = useState<CouncilStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [reading, setReading] = useState(false);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(
    async (id: string): Promise<void> => {
      setReading(true);
      try {
        setStatus(await rpc.request('council.status', { goalId: id }));
        setError(null);
        setPollingStopped(false);
      } catch (cause) {
        setError(councilErrorMessage(cause));
        // A stale or forbidden goal id never recovers by polling.
        if (isPermanentCouncilFailure(cause)) setPollingStopped(true);
      } finally {
        setReading(false);
      }
    },
    [rpc],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setResolving(true);
    try {
      const latest = await rpc.request('council.latest', { threadId });
      setGoalId(goalIdFromLatest(latest, null));
      setError(null);
      setPollingStopped(false);
    } catch (cause) {
      setError(councilErrorMessage(cause));
      setGoalId(null);
    } finally {
      setResolving(false);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadToken]);

  useEffect(() => {
    if (goalId === null) {
      setStatus(null);
      return;
    }
    void load(goalId);
  }, [goalId, load, reloadToken]);

  // One subscription per goal: an event for another thread's goal is ignored, and a
  // thread with no goal yet adopts the one the composer starts.
  useEffect(() => {
    return rpc.onEvent((event) => {
      if (event.type !== 'council.updated') return;
      if (goalId !== null) {
        if (event.payload.goalId === goalId) void load(goalId);
        return;
      }
      if (event.threadId === threadId) void refresh();
    });
  }, [goalId, load, refresh, rpc, threadId]);

  const goalState = status?.goal.state;
  useEffect(() => {
    if (goalId === null || pollingStopped) return;
    if (goalState !== undefined && isGoalTerminal(goalState)) return;
    const timer = setInterval(() => void load(goalId), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [goalId, goalState, load, pollingStopped]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return { status, goalId, error, loading: resolving || reading, reload };
}
