/**
 * Remote Orca Servers: multiple clients of a server share a consistent view of
 * repos / projects / worktrees after operations.
 *
 * These drive the real OrcaRuntimeRpcServer over an ephemeral E2EE WebSocket (see
 * in-memory-orca-runtime-test-setup.ts). The consistency contract under test:
 * after a client mutates the server (add repo, create worktree, create/move a
 * project group), the server pushes a `reposChanged` / `worktreesChanged` event
 * to every subscribed client, which re-queries and converges to the server's
 * source of truth — and operations on one Orca server never leak into another.
 */
import { describe, expect, it } from 'vitest'
import { createInMemoryOrcaRuntime } from './in-memory-orca-runtime'
import {
  readClientView,
  startOrcaServer,
  waitFor,
  waitForView,
  type RunningOrcaServer
} from './orca-runtime-server-harness'

const TEST_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 5_000

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

function countDataEvents(events: { type: string }[]): number {
  return events.filter((e) => e.type === 'reposChanged' || e.type === 'worktreesChanged').length
}

describe('Remote Orca Server consistency', () => {
  it(
    'propagates a new repo to a second client (reposChanged → converge)',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const runtime = createInMemoryOrcaRuntime('srv', ['alpha'])
      const server = await startOrcaServer(runtime)
      try {
        const observer = await server.subscribeEvents()
        await observer.waitReady()
        const actor = server.newConnection()
        const watcher = server.newConnection()

        // Both clients start consistent with the server.
        expect(await readClientView(watcher)).toEqual(runtime.truthView())

        // Actor adds a repo on the server.
        const added = await actor.request<{ repo: { id: string } }>(
          'repo.add',
          { path: '/srv/srv/beta' },
          REQUEST_TIMEOUT_MS
        )
        expect(added.ok).toBe(true)

        // The server pushes reposChanged to the subscribed client...
        await waitFor(() => observer.events.some((e) => e.type === 'reposChanged'))
        // ...and the watcher re-queries to the server's source of truth.
        const converged = await waitForView(watcher, runtime.truthView())
        expect(converged.repos.map((r) => r.displayName)).toEqual(['alpha', 'beta'])
      } finally {
        await server.stop()
      }
    }
  )

  it(
    'propagates a new worktree to a second client (worktreesChanged → converge)',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const runtime = createInMemoryOrcaRuntime('srv', ['alpha'])
      const server = await startOrcaServer(runtime)
      try {
        const observer = await server.subscribeEvents()
        await observer.waitReady()
        const actor = server.newConnection()
        const watcher = server.newConnection()

        const repoId = runtime.truthView().repos[0].id
        const created = await actor.request<{ worktree: { id: string } }>(
          'worktree.create',
          { repo: repoId, name: 'feature' },
          REQUEST_TIMEOUT_MS
        )
        expect(created.ok && created.result.worktree.id).toBe(`${repoId}::feature`)

        await waitFor(() =>
          observer.events.some((e) => e.type === 'worktreesChanged' && e.repoId === repoId)
        )
        const converged = await waitForView(watcher, runtime.truthView())
        expect(converged.worktreesByRepo[repoId]).toEqual([`${repoId}::feature`, `${repoId}::main`])
      } finally {
        await server.stop()
      }
    }
  )

  it(
    'propagates project-group create + move to a second client',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const runtime = createInMemoryOrcaRuntime('srv', ['alpha', 'beta'])
      const server = await startOrcaServer(runtime)
      try {
        const observer = await server.subscribeEvents()
        await observer.waitReady()
        const actor = server.newConnection()
        const watcher = server.newConnection()

        const group = await actor.request<{ group: { id: string } }>(
          'projectGroup.create',
          { name: 'Backend' },
          REQUEST_TIMEOUT_MS
        )
        expect(group.ok).toBe(true)
        const groupId = group.ok ? group.result.group.id : ''
        const repoId = runtime.truthView().repos[0].id
        await actor.request(
          'projectGroup.moveProject',
          { repo: repoId, groupId },
          REQUEST_TIMEOUT_MS
        )

        await waitFor(() => countDataEvents(observer.events) >= 2)
        const converged = await waitForView(watcher, runtime.truthView())
        expect(converged.projectGroups).toEqual([{ id: groupId, name: 'Backend' }])
        expect(converged.repos.find((r) => r.id === repoId)?.projectGroupId).toBe(groupId)
      } finally {
        await server.stop()
      }
    }
  )

  it(
    'converges a second client to the server after a random operation sequence',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      for (let seed = 1; seed <= 12; seed += 1) {
        const runtime = createInMemoryOrcaRuntime(`srv${seed}`, ['root'])
        const server = await startOrcaServer(runtime)
        try {
          const observer = await server.subscribeEvents()
          await observer.waitReady()
          const actor = server.newConnection()
          const watcher = server.newConnection()
          const rng = makeRng(seed)
          const groupIds: string[] = []
          let opCount = 0

          for (let i = 0; i < 10; i += 1) {
            const repos = runtime.truthView().repos
            const roll = rng()
            if (roll < 0.35 || repos.length === 0) {
              await actor.request('repo.add', { path: `/srv/add/${seed}-${i}` }, REQUEST_TIMEOUT_MS)
            } else if (roll < 0.65) {
              const repoId = repos[Math.floor(rng() * repos.length)].id
              await actor.request(
                'worktree.create',
                { repo: repoId, name: `w${seed}-${i}` },
                REQUEST_TIMEOUT_MS
              )
            } else if (roll < 0.8) {
              const created = await actor.request<{ group: { id: string } }>(
                'projectGroup.create',
                { name: `g${seed}-${i}` },
                REQUEST_TIMEOUT_MS
              )
              if (created.ok) {
                groupIds.push(created.result.group.id)
              }
            } else if (roll < 0.92 && groupIds.length > 0) {
              const repoId = repos[Math.floor(rng() * repos.length)].id
              const groupId = groupIds[Math.floor(rng() * groupIds.length)]
              await actor.request(
                'projectGroup.moveProject',
                { repo: repoId, groupId },
                REQUEST_TIMEOUT_MS
              )
            } else if (repos.length > 1) {
              const repoId = repos[Math.floor(rng() * repos.length)].id
              await actor.request('repo.rm', { repo: repoId }, REQUEST_TIMEOUT_MS)
            } else {
              await actor.request(
                'repo.add',
                { path: `/srv/add/${seed}-${i}b` },
                REQUEST_TIMEOUT_MS
              )
            }
            opCount += 1
          }

          // Every operation pushed at least one event, and the watcher converges
          // to the server's source of truth.
          await waitFor(() => countDataEvents(observer.events) >= opCount, 8_000)
          const converged = await waitForView(watcher, runtime.truthView(), 8_000)
          expect(converged, `seed=${seed}`).toEqual(runtime.truthView())
          // The actor (issuer) and watcher agree too.
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
      const runtimeA = createInMemoryOrcaRuntime('A', ['alpha'])
      const runtimeB = createInMemoryOrcaRuntime('B', ['beta'])
      let serverA: RunningOrcaServer | null = null
      let serverB: RunningOrcaServer | null = null
      try {
        serverA = await startOrcaServer(runtimeA)
        serverB = await startOrcaServer(runtimeB)
        const observerA = await serverA.subscribeEvents()
        const observerB = await serverB.subscribeEvents()
        await observerA.waitReady()
        await observerB.waitReady()
        const connA = serverA.newConnection()
        const connB = serverB.newConnection()

        // Operate only on server A.
        const repoA = runtimeA.truthView().repos[0].id
        await connA.request(
          'worktree.create',
          { repo: repoA, name: 'only-on-a' },
          REQUEST_TIMEOUT_MS
        )
        await connA.request('repo.add', { path: '/srv/A/extra' }, REQUEST_TIMEOUT_MS)

        // Server A's observer sees the events; server B's observer sees none.
        await waitFor(() => countDataEvents(observerA.events) >= 2)
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(countDataEvents(observerB.events)).toBe(0)

        // Each client's view matches only its own server and they are disjoint.
        const viewA = await waitForView(connA, runtimeA.truthView())
        const viewB = await waitForView(connB, runtimeB.truthView())
        const idsA = new Set(viewA.repos.map((r) => r.id))
        const idsB = new Set(viewB.repos.map((r) => r.id))
        expect([...idsA].some((id) => idsB.has(id))).toBe(false)
        expect(viewB.repos.map((r) => r.displayName)).toEqual(['beta'])
        expect(viewA.repos.map((r) => r.displayName).sort()).toEqual(['alpha', 'extra'])
      } finally {
        await serverA?.stop()
        await serverB?.stop()
      }
    }
  )
})
