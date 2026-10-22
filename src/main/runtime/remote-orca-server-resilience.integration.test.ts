/**
 * Remote Orca Servers: consistency under imperfect connectivity — the
 * interactions where a stale-view bug is most likely to hide.
 *
 *  - Late joiner: a client that connects AFTER operations must see the current
 *    state (it re-queries on connect; it never saw the events).
 *  - Reconnection gap: a client whose event subscription drops while the server
 *    mutates must converge once it re-subscribes and re-queries — the missed
 *    event must not leave it permanently stale.
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
  readClientView,
  seedGitRepo,
  serverTruthView,
  waitFor,
  waitForView
} from './orca-runtime-server-harness'

const TEST_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000

describe('Remote Orca Server consistency — resilience (real runtime)', () => {
  it('a late-joining client sees the current state', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { runtime, server, root } = await buildOrcaServer('latejoin')
    try {
      // Operate before the late client exists.
      const actor = server.newConnection()
      const repoId = (
        (await actor.request(
          'repo.add',
          { path: seedGitRepo(root, 'alpha') },
          REQUEST_TIMEOUT_MS
        )) as {
          result: { repo: { id: string } }
        }
      ).result.repo.id
      await actor.request('worktree.create', { repo: repoId, name: 'feature' }, REQUEST_TIMEOUT_MS)
      await actor.request('projectGroup.create', { name: 'Backend' }, REQUEST_TIMEOUT_MS)

      // A client that connects now — having seen none of the events — still sees
      // the full current state on its first query.
      const latecomer = server.newConnection()
      const view = await readClientView(latecomer)
      expect(view).toEqual(await serverTruthView(runtime))
      expect(view.repos.map((r) => r.displayName)).toEqual(['alpha'])
      expect(view.worktreesByRepo[repoId].length).toBe(2)
      expect(view.projectGroups.map((g) => g.name)).toEqual(['Backend'])
    } finally {
      await server.stop()
    }
  })

  it(
    'a client converges after its event subscription drops during a mutation',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { runtime, server, root } = await buildOrcaServer('reconnect')
      try {
        const { observer, actor, watcher } = await connectTrio(server)
        const repoId = (
          (await actor.request(
            'repo.add',
            { path: seedGitRepo(root, 'alpha') },
            REQUEST_TIMEOUT_MS
          )) as { result: { repo: { id: string } } }
        ).result.repo.id
        await waitForView(watcher, await serverTruthView(runtime))

        // The watcher's event subscription drops.
        observer.close()

        // A mutation happens while it is not subscribed — the event is missed.
        await actor.request('repo.add', { path: seedGitRepo(root, 'beta') }, REQUEST_TIMEOUT_MS)
        await actor.request(
          'worktree.create',
          { repo: repoId, name: 'feature' },
          REQUEST_TIMEOUT_MS
        )

        // It re-subscribes and re-queries (the real client's reconnect behavior);
        // the missed event must not leave it permanently stale.
        const resubscribed = await server.subscribeEvents()
        await resubscribed.waitReady()
        const converged = await waitForView(watcher, await serverTruthView(runtime))
        expect(converged.repos.map((r) => r.displayName).sort()).toEqual(['alpha', 'beta'])
        expect(converged.worktreesByRepo[repoId].length).toBe(2)

        // And once re-subscribed, a fresh mutation is delivered again.
        await actor.request('repo.add', { path: seedGitRepo(root, 'gamma') }, REQUEST_TIMEOUT_MS)
        await waitFor(() => resubscribed.events.some((e) => e.type === 'reposChanged'))
        await waitForView(watcher, await serverTruthView(runtime))
      } finally {
        await server.stop()
      }
    }
  )
})
