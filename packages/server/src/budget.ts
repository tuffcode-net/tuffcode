/**
 * The one process-wide cap on agent children that may run at once.
 *
 * A subagent queue used to count its slots per parent, so two parents with
 * `subagentConcurrency: 2` ran four children, and a resumed child took no slot at
 * all. The budget lives once per server and every child start reserves from it, so
 * the setting means what it says.
 */
export interface RunningBudget {
  /** Reserves one slot; false when the cap is reached. */
  reserve(): boolean;
  /** Releases one slot; a no-op when none is held. */
  release(): void;
  /** Slots currently held. */
  active(): number;
}

export function createRunningBudget(limit: () => number): RunningBudget {
  let held = 0;
  return {
    reserve: () => {
      if (held >= Math.max(1, limit())) return false;
      held += 1;
      return true;
    },
    release: () => {
      held = Math.max(0, held - 1);
    },
    active: () => held,
  };
}
