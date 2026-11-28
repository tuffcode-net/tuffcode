import type { RpcResult } from '@tuffcode/contracts';
import { councilAutonomy } from '@tuffcode/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import {
  councilErrorMessage,
  isGoalTerminal,
  isPermanentCouncilFailure,
} from '../inspector/council-model';
import { isCancelPending, stillTracksGoal } from './council-goal';
import { goalIdFromLatest } from './council-goal-source';

export type CouncilStatus = RpcResult<'council.status'>;

/** The board and inspector read the same goal; the event stream carries the changes. */
const POLL_INTERVAL_MS = 15_000;

export interface UseCouncilGoalResult {
  goalId: string | null;
  status: CouncilStatus | null;
  starting: boolean;
  error: string | null;
  /** True while a goal is still moving, so the composer can offer Stop. */
  running: boolean;
  cancelling: boolean;
  /** Resolves true when the server accepted the goal. */
  start: (goal: string) => Promise<boolean>;
  cancel: () => Promise<void>;
}

/**
 * Owns the goal a thread started from the composer: starts it with the autonomy
 * implied by settings, follows `council.updated` events, and polls the goal status
 * while it is still moving so the composer strip stays current even if an event is
 * missed.
 */
export function useCouncilGoal(threadId: string | undefined): UseCouncilGoalResult {
  const rpc = useRpc();
  const autonomy = councilAutonomy(useAppStore((state) => state.settings));

  const [goalId, setGoalId] = useState<string | null>(null);
  const [status, setStatus] = useState<CouncilStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  /** The goal the composer currently follows; a late cancel load must not write another. */
  const trackedGoalId = useRef<string | null>(null);
  // Written in an effect so a render React discards cannot leave its goal behind.
  useEffect(() => {
    trackedGoalId.current = goalId;
  }, [goalId]);

  // Reattach to the thread's newest goal after a reload instead of trusting
  // module memory that dies with the window.
  useEffect(() => {
    setGoalId(null);
    setStatus(null);
    setError(null);
    setCancelRequested(false);
    setPollingStopped(false);
    if (threadId === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const latest = await rpc.request('council.latest', { threadId });
        if (!cancelled) setGoalId(goalIdFromLatest(latest, null));
      } catch {
        // No remembered goal is a normal state; the composer can start one.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  const load = useCallback(async (): Promise<void> => {
    if (goalId === null) return;
    try {
      setStatus(await rpc.request('council.status', { goalId }));
      setError(null);
    } catch (cause) {
      setError(councilErrorMessage(cause));
      if (isPermanentCouncilFailure(cause)) setPollingStopped(true);
    }
  }, [goalId, rpc]);

  // One subscription per goal: an event for another thread's goal is ignored.
  useEffect(() => {
    if (goalId === null) return;
    return rpc.onEvent((event) => {
      if (event.type !== 'council.updated' || event.payload.goalId !== goalId) return;
      void load();
    });
  }, [goalId, load, rpc]);

  useEffect(() => {
    if (goalId === null) return;
    void load();
  }, [goalId, load]);

  const goalState = status?.goal.state;
  useEffect(() => {
    if (goalId === null || pollingStopped) return;
    if (goalState !== undefined && isGoalTerminal(goalState)) return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [goalId, goalState, load, pollingStopped]);

  const start = useCallback(
    async (goal: string): Promise<boolean> => {
      const text = goal.trim();
      if (threadId === undefined || text.length === 0 || starting) return false;
      setStarting(true);
      setError(null);
      try {
        const started = await rpc.request('council.start', {
          threadId,
          goal: text,
          autonomy,
        });
        setStatus(null);
        setCancelRequested(false);
        setPollingStopped(false);
        setGoalId(started.goalId);
        return true;
      } catch (cause) {
        setError(councilErrorMessage(cause));
        return false;
      } finally {
        setStarting(false);
      }
    },
    [autonomy, rpc, starting, threadId],
  );

  const cancel = useCallback(async (): Promise<void> => {
    if (goalId === null || cancelRequested) return;
    const target = goalId;
    setCancelRequested(true);
    try {
      await rpc.request('council.cancel', { goalId: target });
      // The server can take seconds to tear a goal down; the user may have started
      // another goal meanwhile, and this load would overwrite its status.
      if (stillTracksGoal(trackedGoalId.current, target)) await load();
    } catch (cause) {
      setCancelRequested(false);
      setError(councilErrorMessage(cause));
    }
  }, [cancelRequested, goalId, load, rpc]);

  const running = goalState !== undefined && !isGoalTerminal(goalState);
  // One lock for the whole teardown: Stop stays disabled until the goal is terminal.
  const cancelling = isCancelPending(cancelRequested, goalState, pollingStopped);
  return { goalId, status, starting, error, running, cancelling, start, cancel };
}
