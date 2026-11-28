import type { ReviewComment, ReviewCommentSide } from '@tuffcode/contracts';
import { newId } from '@tuffcode/shared';
import type { Repos } from '../db/repos/index.js';
import { badRequest, notFound } from '../errors.js';

export interface AddReviewCommentRequest {
  threadId: string;
  filePath: string;
  line: number;
  side: ReviewCommentSide;
  body: string;
}

/** Every comment operation is scoped to a thread that must still exist. */
function requireThread(repos: Repos, threadId: string): void {
  if (repos.threads.get(threadId) === undefined) throw notFound('thread not found');
}

export function listReviewComments(repos: Repos, threadId: string): ReviewComment[] {
  requireThread(repos, threadId);
  return repos.comments.list(threadId);
}

export function addReviewComment(repos: Repos, request: AddReviewCommentRequest): ReviewComment {
  requireThread(repos, request.threadId);
  const body = request.body.trim();
  if (body.length === 0) throw badRequest('comment body is required');
  const filePath = request.filePath.trim();
  if (filePath.length === 0) throw badRequest('comment file path is required');
  return repos.comments.create({
    id: newId('rc'),
    threadId: request.threadId,
    filePath,
    line: request.line,
    side: request.side,
    body,
    createdAt: new Date().toISOString(),
  });
}

export function resolveReviewComment(repos: Repos, id: string, resolved: boolean): ReviewComment {
  const comment = repos.comments.get(id);
  if (comment === undefined) throw notFound('comment not found');
  // Ownership: a comment belongs to its thread, so a dangling thread is a mismatch.
  requireThread(repos, comment.threadId);
  // Reopening puts the comment back in the unsent state, so the next turn carries it
  // again. Resolving keeps the delivery stamp, which is what separates sent from fixed.
  if (!resolved) repos.comments.clearDelivered(id);
  const updated = repos.comments.setResolved(id, resolved);
  if (updated === undefined) throw notFound('comment not found');
  return updated;
}
