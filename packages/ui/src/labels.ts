import type { PermissionMode } from '@tuffcode/contracts';

/**
 * One spelling per permission mode. The composer, the Activity panel and Settings all
 * read this map, so a user never sees the same policy under two names.
 */
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  'read-only': 'Read only',
  ask: 'Ask',
  'accept-edits': 'Accept edits',
  'full-auto': 'Full auto',
};
