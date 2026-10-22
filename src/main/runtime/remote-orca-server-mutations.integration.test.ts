/**
 * Remote Orca Servers: removals and updates (not just creates) propagate to other
 * clients. Emission on delete/update paths is the common place to forget an
 * event, so these exercise the real runtime's `repo.update` / `repo.rm` /
 * `worktree.rm` / `projectGroup.update` / `projectGroup.delete` and assert a
 * second client converges to the server's source of truth.
 *
 * Real runtime + real git worktrees; only the store and electron are substituted.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {}, emit: () => {} },
  app: { getPath: () => require('os').tmpdir() }
}))

import {
  buildOrcaServer,
  connectTrio,
  seedGitRepo,
  serverTruthView,
  waitForView
} from './orca-runtime-server-harness'

const TEST_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000

async function addRepo(
  actor: { request: (m: string, p: unknown, t: number) => Promise<unknown> },
  path: string
): Promise<string> {
  const added = (await actor.request('repo.add', { path }, REQUEST_TIMEOUT_MS)) as {
    ok: boolean
    result: { repo: { id: string } }
  }
  if (!added.ok) {
    throw new Error('repo.add failed')
  }
  return added.result.repo.id
}

describe('Remote Orca Server consistency — removals & updates (real runtime)', () => {
  it('propagates a repo rename and then a repo removal', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { runtime, server, root } = await buildOrcaServer('repoupd')
    try {
      const { actor, watcher } = await connectTrio(server)
      const repoId = await addRepo(actor, seedGitRepo(root, 'alpha'))
      await waitForView(watcher, await serverTruthView(runtime))

      await actor.request(
        'repo.update',
        { repo: repoId, updates: { displayName: 'renamed' } },
        REQUEST_TIMEOUT_MS
      )
      let converged = await waitForView(watcher, await serverTruthView(runtime))
      expect(converged.repos.map((r) => r.displayName)).toEqual(['renamed'])

      await actor.request('repo.rm', { repo: repoId }, REQUEST_TIMEOUT_MS)
      converged = await waitForView(watcher, await serverTruthView(runtime))
      expect(converged.repos).toEqual([])
    } finally {
      await server.stop()
    }
  })

  it('propagates a worktree removal', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { runtime, server, root } = await buildOrcaServer('wtrm')
    try {
      const { actor, watcher } = await connectTrio(server)
      const repoId = await addRepo(actor, seedGitRepo(root, 'alpha'))
      const created = (await actor.request(
        'worktree.create',
        { repo: repoId, name: 'feature' },
        REQUEST_TIMEOUT_MS
      )) as { ok: boolean; result: { worktree: { id: string } } }
      const worktreeId = created.result.worktree.id
      const afterCreate = await waitForView(watcher, await serverTruthView(runtime))
      expect(afterCreate.worktreesByRepo[repoId]).toContain(worktreeId)

      await actor.request('worktree.rm', { worktree: worktreeId, force: true }, REQUEST_TIMEOUT_MS)
      const afterRemove = await waitForView(watcher, await serverTruthView(runtime))
      // The removed worktree is gone for the watcher; the main worktree remains.
      expect(afterRemove.worktreesByRepo[repoId]).not.toContain(worktreeId)
      expect(afterRemove.worktreesByRepo[repoId].length).toBe(1)
    } finally {
      await server.stop()
    }
  })

  it('propagates a project-group rename and deletion', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { runtime, server, root } = await buildOrcaServer('grpupd')
    try {
      const { actor, watcher } = await connectTrio(server)
      const repoId = await addRepo(actor, seedGitRepo(root, 'alpha'))
      const group = (await actor.request(
        'projectGroup.create',
        { name: 'Backend' },
        REQUEST_TIMEOUT_MS
      )) as { ok: boolean; result: { group: { id: string } } }
      const groupId = group.result.group.id
      await actor.request('projectGroup.moveProject', { repo: repoId, groupId }, REQUEST_TIMEOUT_MS)
      await waitForView(watcher, await serverTruthView(runtime))

      await actor.request(
        'projectGroup.update',
        { groupId, updates: { name: 'Services' } },
        REQUEST_TIMEOUT_MS
      )
      let converged = await waitForView(watcher, await serverTruthView(runtime))
      expect(converged.projectGroups).toEqual([{ id: groupId, name: 'Services' }])

      await actor.request('projectGroup.delete', { groupId }, REQUEST_TIMEOUT_MS)
      converged = await waitForView(watcher, await serverTruthView(runtime))
      expect(converged.projectGroups).toEqual([])
      // The repo is un-grouped once its group is deleted.
      expect(converged.repos.find((r) => r.id === repoId)?.projectGroupId ?? null).toBeNull()
    } finally {
      await server.stop()
    }
  })
})
