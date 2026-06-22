/**
 * Remote Orca Servers: multiple clients of a server share a consistent view of
 * repos / projects / worktrees after operations.
 *
 * Driven through the REAL OrcaRuntimeService wrapped by the real
 * OrcaRuntimeRpcServer over an ephemeral E2EE WebSocket, with real git worktrees
 * on disk. Only the persistence store is substituted (in-memory) and electron is
 * mocked — so the runtime's own mutation + event-emission logic is what's under
 * test. The consistency contract: after a client mutates the server, the server
 * pushes a `reposChanged` / `worktreesChanged` event to every subscribed client,
 * which re-queries and converges to the server's source of truth; and operations
 * on one Orca server never leak into another.
 *
 * This deliberately does NOT mock the runtime: a missing emit in the real runtime
 * fails these tests (verified by fault injection on the product code).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {}, emit: () => {} },
  app: { getPath: () => require('os').tmpdir() }
}))

import { OrcaRuntimeService } from './orca-runtime'
import { createInMemoryRuntimeStore } from './in-memory-runtime-store'
import {
  makeServerTempRoot,
  readClientView,
  seedGitRepo,
  serverTruthView,
  startOrcaServer,
  waitFor,
  waitForView,
  type RunningOrcaServer
} from './orca-runtime-server-harness'

const TEST_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000

type Server = {
  runtime: OrcaRuntimeService
  server: RunningOrcaServer
  root: string
}

async function buildServer(label: string): Promise<Server> {
  const { root, workspaceDir } = makeServerTempRoot(label)
  const store = createInMemoryRuntimeStore(workspaceDir)
  const runtime = new OrcaRuntimeService(store.store as never)
  const server = await startOrcaServer(runtime, label)
  return { runtime, server, root }
}

function countDataEvents(events: { type: string }[]): number {
  return events.filter((e) => e.type === 'reposChanged' || e.type === 'worktreesChanged').length
}

/** mulberry32 — deterministic PRNG; the property test prints its seed on failure. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('Remote Orca Server consistency (real runtime)', () => {
  it('propagates a newly added repo to a second client', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { runtime, server, root } = await buildServer('repoadd')
    try {
      const observer = await server.subscribeEvents()
      await observer.waitReady()
      const actor = server.newConnection()
      const watcher = server.newConnection()

      const repoPath = seedGitRepo(root, 'alpha')
      const added = await actor.request<{ repo: { id: string } }>(
        'repo.add',
        { path: repoPath },
        REQUEST_TIMEOUT_MS
      )
      expect(added.ok).toBe(true)

      await waitFor(() => observer.events.some((e) => e.type === 'reposChanged'))
      const truth = await serverTruthView(runtime)
      const converged = await waitForView(watcher, truth)
      expect(converged.repos.map((r) => r.displayName)).toEqual(['alpha'])
    } finally {
      await server.stop()
    }
  })

  it(
    'propagates a newly created worktree to a second client',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { runtime, server, root } = await buildServer('wtcreate')
      try {
        const observer = await server.subscribeEvents()
        await observer.waitReady()
        const actor = server.newConnection()
        const watcher = server.newConnection()

        const repoPath = seedGitRepo(root, 'alpha')
        const added = await actor.request<{ repo: { id: string } }>(
          'repo.add',
          { path: repoPath },
          REQUEST_TIMEOUT_MS
        )
        const repoId = added.ok ? added.result.repo.id : ''

        const created = await actor.request<{ worktree: { id: string } }>(
          'worktree.create',
          { repo: repoId, name: 'feature' },
          REQUEST_TIMEOUT_MS
        )
        expect(created.ok).toBe(true)

        await waitFor(() =>
          observer.events.some((e) => e.type === 'worktreesChanged' && e.repoId === repoId)
        )
        const truth = await serverTruthView(runtime)
        const converged = await waitForView(watcher, truth)
        // The repo now has two worktrees (main + feature) and the watcher sees both.
        expect(converged.worktreesByRepo[repoId].length).toBe(2)
      } finally {
        await server.stop()
      }
    }
  )

  it(
    'propagates project-group create + move to a second client',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { runtime, server, root } = await buildServer('group')
      try {
        const observer = await server.subscribeEvents()
        await observer.waitReady()
        const actor = server.newConnection()
        const watcher = server.newConnection()

        const repoPath = seedGitRepo(root, 'alpha')
        const added = await actor.request<{ repo: { id: string } }>(
          'repo.add',
          { path: repoPath },
          REQUEST_TIMEOUT_MS
        )
        const repoId = added.ok ? added.result.repo.id : ''

        const group = await actor.request<{ group: { id: string } }>(
          'projectGroup.create',
          { name: 'Backend' },
          REQUEST_TIMEOUT_MS
        )
        const groupId = group.ok ? group.result.group.id : ''
        await actor.request(
          'projectGroup.moveProject',
          { repo: repoId, groupId },
          REQUEST_TIMEOUT_MS
        )

        await waitFor(() => countDataEvents(observer.events) >= 2)
        const truth = await serverTruthView(runtime)
        const converged = await waitForView(watcher, truth)
        expect(converged.projectGroups).toEqual([{ id: groupId, name: 'Backend' }])
        expect(converged.repos.find((r) => r.id === repoId)?.projectGroupId).toBe(groupId)
      } finally {
        await server.stop()
      }
    }
  )

  it(
    'converges a second client after a random operation sequence',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      for (let seed = 1; seed <= 4; seed += 1) {
        const { runtime, server, root } = await buildServer(`seq${seed}`)
        try {
          const observer = await server.subscribeEvents()
          await observer.waitReady()
          const actor = server.newConnection()
          const watcher = server.newConnection()
          const rng = makeRng(seed)
          const repoIds: string[] = []
          const groupIds: string[] = []
          let opCount = 0

          // Pre-seed git repos to draw from for add operations.
          const repoPaths = [0, 1, 2, 3].map((i) => seedGitRepo(root, `r${seed}-${i}`))
          let nextRepo = 0

          for (let i = 0; i < 8; i += 1) {
            const roll = rng()
            if ((roll < 0.4 || repoIds.length === 0) && nextRepo < repoPaths.length) {
              const added = await actor.request<{ repo: { id: string } }>(
                'repo.add',
                { path: repoPaths[nextRepo++] },
                REQUEST_TIMEOUT_MS
              )
              if (added.ok) {
                repoIds.push(added.result.repo.id)
              }
            } else if (roll < 0.7 && repoIds.length > 0) {
              const repoId = repoIds[Math.floor(rng() * repoIds.length)]
              await actor.request(
                'worktree.create',
                { repo: repoId, name: `w${seed}-${i}` },
                REQUEST_TIMEOUT_MS
              )
            } else if (roll < 0.85) {
              const created = await actor.request<{ group: { id: string } }>(
                'projectGroup.create',
                { name: `g${seed}-${i}` },
                REQUEST_TIMEOUT_MS
              )
              if (created.ok) {
                groupIds.push(created.result.group.id)
              }
            } else if (repoIds.length > 0 && groupIds.length > 0) {
              const repoId = repoIds[Math.floor(rng() * repoIds.length)]
              const groupId = groupIds[Math.floor(rng() * groupIds.length)]
              await actor.request(
                'projectGroup.moveProject',
                { repo: repoId, groupId },
                REQUEST_TIMEOUT_MS
              )
            } else {
              continue
            }
            opCount += 1
          }

          await waitFor(() => countDataEvents(observer.events) >= opCount, 10_000)
          const truth = await serverTruthView(runtime)
          const converged = await waitForView(watcher, truth, 10_000)
          expect(converged, `seed=${seed}`).toEqual(truth)
          expect(await readClientView(actor)).toEqual(converged)
        } finally {
          await server.stop()
        }
      }
    }
  )

  it(
    'keeps two Orca servers isolated — operations on one never appear on the other',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const a = await buildServer('isoA')
      const b = await buildServer('isoB')
      try {
        const observerA = await a.server.subscribeEvents()
        const observerB = await b.server.subscribeEvents()
        await observerA.waitReady()
        await observerB.waitReady()
        const connA = a.server.newConnection()
        const connB = b.server.newConnection()

        // Seed and add a repo only on server A, then create a worktree on it.
        const repoPath = seedGitRepo(a.root, 'alpha')
        const added = await connA.request<{ repo: { id: string } }>(
          'repo.add',
          { path: repoPath },
          REQUEST_TIMEOUT_MS
        )
        const repoA = added.ok ? added.result.repo.id : ''
        await connA.request('worktree.create', { repo: repoA, name: 'only-a' }, REQUEST_TIMEOUT_MS)

        await waitFor(() => countDataEvents(observerA.events) >= 2)
        await new Promise((resolve) => setTimeout(resolve, 200))
        // Server B's subscribed client received nothing.
        expect(countDataEvents(observerB.events)).toBe(0)

        const viewA = await waitForView(connA, await serverTruthView(a.runtime))
        const viewB = await waitForView(connB, await serverTruthView(b.runtime))
        expect(viewA.repos.map((r) => r.displayName)).toEqual(['alpha'])
        expect(viewB.repos).toEqual([])
        // No shared repo ids between the two servers.
        const idsA = new Set(viewA.repos.map((r) => r.id))
        expect(viewB.repos.some((r) => idsA.has(r.id))).toBe(false)
      } finally {
        await a.server.stop()
        await b.server.stop()
      }
    }
  )
})
