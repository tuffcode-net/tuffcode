import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CAPABILITIES } from '@tuffcode/contracts';
import { isInside } from '@tuffcode/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStoredAttachment, storeAttachmentBytes } from './attachments/store.js';
import { addProject } from './projects.js';
import {
  addTestProvider,
  createTestContext,
  git,
  initRepo,
  type TestContext,
} from './test-support.js';
import {
  COMPACT_KEEP_MESSAGES,
  clearThread,
  compactThread,
  createThread,
  deleteThread,
  updateThread,
} from './threads.js';

describe('threads service', () => {
  let ctx: TestContext;
  let repo: string;

  beforeEach(async () => {
    ctx = createTestContext();
    repo = initRepo(join(ctx.env.root, 'thread-repo'));
    addTestProvider(ctx.repos);
  });

  afterEach(() => {
    ctx.dispose();
  });

  async function createTestThread(
    baseBranch?: string,
    workspace: 'folder' | 'worktree' = 'worktree',
  ) {
    const project = await addProject(ctx.repos, repo);
    return createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace,
      ...(baseBranch === undefined ? {} : { baseBranch }),
    });
  }

  it('provisions a worktree on a new tuffcode branch', async () => {
    const thread = await createTestThread();
    expect(thread.branch).toBe(`tuffcode/${thread.id}`);
    expect(thread.baseBranch).toBe('main');
    expect(thread.status).toBe('idle');
    expect(thread.worktreePath).not.toBeNull();
    const worktreePath = thread.worktreePath ?? '';
    expect(existsSync(worktreePath)).toBe(true);
    expect(isInside(realpathSync.native(repo), worktreePath)).toBe(false);
    expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(thread.branch);

    const listed = git(repo, ['worktree', 'list', '--porcelain']).replace(/\\/g, '/').toLowerCase();
    expect(listed).toContain(worktreePath.replace(/\\/g, '/').toLowerCase());
  });

  it('rejects a missing base branch', async () => {
    await expect(createTestThread('does-not-exist')).rejects.toThrow('base branch not found');
  });

  it('rejects a worktree root inside the project', async () => {
    ctx.repos.settings.patch({ worktreeRoot: join(repo, 'worktrees') });
    await expect(createTestThread()).rejects.toThrow('worktree root must be outside the project');
  });

  it('updates thread metadata', async () => {
    const thread = await createTestThread();
    const updated = updateThread(ctx.repos, {
      id: thread.id,
      title: 'Renamed',
      modelId: 'model-y',
      permissionMode: 'full-auto',
    });
    expect(updated.title).toBe('Renamed');
    expect(updated.modelId).toBe('model-y');
    expect(updated.permissionMode).toBe('full-auto');
    expect(updated.branch).toBe(thread.branch);
  });

  it('removes the worktree when deleting a thread', async () => {
    const thread = await createTestThread();
    const worktreePath = thread.worktreePath ?? '';
    await deleteThread(ctx.repos, thread.id, true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(ctx.repos.threads.get(thread.id)).toBeUndefined();
    const listed = git(repo, ['worktree', 'list', '--porcelain']).replace(/\\/g, '/').toLowerCase();
    expect(listed).not.toContain(worktreePath.replace(/\\/g, '/').toLowerCase());
  });

  it('keeps the worktree when deletion does not ask for removal', async () => {
    const thread = await createTestThread();
    const worktreePath = thread.worktreePath ?? '';
    await deleteThread(ctx.repos, thread.id, false);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('creates a folder thread in the project checkout without a branch', async () => {
    const project = await addProject(ctx.repos, repo);
    const thread = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace: 'folder',
    });
    expect(thread.worktreePath).toBe(project.path);
    expect(thread.branch).toBeNull();
    expect(thread.baseBranch).toBe('main');
    const listed = git(repo, ['worktree', 'list', '--porcelain']).toLowerCase();
    expect(listed).not.toContain('tuffcode/');
  });

  it('defaults to the project folder when the request omits the workspace', async () => {
    const project = await addProject(ctx.repos, repo);
    const thread = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
    });
    expect(thread.worktreePath).toBe(project.path);
    expect(thread.branch).toBeNull();
  });

  it('forces folder mode when the capability is off even if a worktree is requested', async () => {
    ctx.repos.settings.patch({ capabilities: { ...DEFAULT_CAPABILITIES, worktrees: false } });
    const project = await addProject(ctx.repos, repo);
    const thread = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace: 'worktree',
    });
    expect(thread.worktreePath).toBe(project.path);
    expect(thread.branch).toBeNull();
  });

  it('deleting a folder thread never removes the project checkout', async () => {
    const project = await addProject(ctx.repos, repo);
    const thread = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace: 'folder',
    });
    await deleteThread(ctx.repos, thread.id, true);
    expect(ctx.repos.threads.get(thread.id)).toBeUndefined();
    expect(existsSync(join(repo, 'README.md'))).toBe(true);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('deleting a worktree thread removes only its worktree', async () => {
    const project = await addProject(ctx.repos, repo);
    const folderThread = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace: 'folder',
    });
    const worktreeThread = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace: 'worktree',
    });
    const worktreePath = worktreeThread.worktreePath ?? '';
    expect(existsSync(worktreePath)).toBe(true);

    await deleteThread(ctx.repos, worktreeThread.id, true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(repo, 'README.md'))).toBe(true);
    expect(ctx.repos.threads.get(folderThread.id)).toBeDefined();
  });

  it('clears a thread and deletes attachment bytes no other message uses', async () => {
    const project = await addProject(ctx.repos, repo);
    const thread = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace: 'folder',
    });
    const other = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace: 'folder',
    });
    const shared = await storeAttachmentBytes('AAAA', 'image/png');
    const only = await storeAttachmentBytes('BBBB', 'image/png');
    const createdAt = new Date().toISOString();
    ctx.repos.messages.add({
      id: 'msg_clear',
      threadId: thread.id,
      role: 'user',
      content: 'two images',
      attachments: [
        { name: 'shared.png', id: shared, mimeType: 'image/png' },
        { name: 'only.png', id: only, mimeType: 'image/png' },
      ],
      createdAt,
    });
    ctx.repos.messages.add({
      id: 'msg_other',
      threadId: other.id,
      role: 'user',
      content: 'same image',
      attachments: [{ name: 'shared.png', id: shared, mimeType: 'image/png' }],
      createdAt,
    });

    const result = await clearThread(ctx.repos, thread.id);

    expect(result.messages).toBe(1);
    expect(await readStoredAttachment(only)).toBeNull();
    expect(await readStoredAttachment(shared)).not.toBeNull();
  });

  it('compacts a thread and deletes attachment bytes from folded messages', async () => {
    const thread = await createTestThread(undefined, 'folder');
    const id = await storeAttachmentBytes('CCCC', 'image/png');
    const createdAt = new Date().toISOString();
    ctx.repos.messages.add({
      id: 'msg_folded',
      threadId: thread.id,
      role: 'user',
      content: 'old image',
      attachments: [{ name: 'old.png', id, mimeType: 'image/png' }],
      createdAt,
    });
    for (let index = 0; index < COMPACT_KEEP_MESSAGES; index += 1) {
      ctx.repos.messages.add({
        id: `msg_recent_${index}`,
        threadId: thread.id,
        role: 'user',
        content: `recent ${index}`,
        createdAt: new Date(Date.parse(createdAt) + index + 1).toISOString(),
      });
    }

    const result = await compactThread(ctx.repos, thread.id);

    expect(result.removed).toBe(1);
    expect(await readStoredAttachment(id)).toBeNull();
  });
});
