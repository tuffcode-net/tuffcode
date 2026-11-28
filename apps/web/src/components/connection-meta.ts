import type { ConnectionStatus } from '../types';

/**
 * One spelling per connection state. The topbar dot and the composer hint both read
 * this map, so a dropped socket is not "Disconnected" in one place and "Connection
 * error" in another.
 */
export const CONNECTION_META: Record<ConnectionStatus, { dot: string; label: string }> = {
  connecting: { dot: 'bg-warning', label: 'Connecting' },
  open: { dot: 'bg-success', label: 'Connected' },
  closed: { dot: 'bg-error', label: 'Disconnected' },
  'protocol-error': { dot: 'bg-error', label: 'Protocol error' },
};
