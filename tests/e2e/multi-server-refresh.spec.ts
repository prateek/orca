/**
 * Real multi-server refresh test: the reported condition with live relays.
 *
 * Two Docker SSH hosts (B and C) each host the *same* project ("shared-app"),
 * and host B additionally has its own unrelated work ("b-only") — "B has its own
 * version of other work going on". Combined with the locally-seeded project, the
 * renderer holds the same project across three servers. We open a marker tab on
 * each worktree, hard-reload the renderer (the Cmd/Ctrl+Shift+R path, which runs
 * persistWorkspaceSessionByHostSync in beforeunload), reconnect, and assert:
 *   - the same project on B and C stays two distinct repos/worktrees (no
 *     collision),
 *   - every server's worktrees and their tabs come back (no state lost),
 *   - the durable session blob carried the remote tabs across the reload.
 *
 * A second test parks the active selection on a *remote* worktree and verifies it
 * is restored after the refresh (not reset to local) — guarding the
 * known-but-unloaded re-validation in hydrateWorkspaceSession.
 *
 * Gated behind ORCA_E2E_SSH_DOCKER=1 (POSIX-only) like the other Docker SSH spec.
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  getActiveWorktreeId,
  getWorktreeTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  cleanupDockerSshHosts,
  seedRepoOnHost,
  startDockerSshHosts,
  type DockerSshHost
} from './helpers/multi-docker-ssh-hosts'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

const SHARED_APP_PATH = '/tmp/orca-multi/shared-app'
const B_ONLY_PATH = '/tmp/orca-multi/b-only'

type RemoteWorkspace = {
  targetId: string
  repoId: string
  worktreeId: string
}

/** Connect a Docker SSH host as a single target (one connection per server, like
 *  the real flow) and return its target id. */
async function connectHost(page: Page, host: DockerSshHost, label: string): Promise<string> {
  return await page.evaluate(
    async ({ host, label }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const createdTarget = await window.api.ssh.addTarget({
          target: {
            label: `${label} ${Date.now()}`,
            host: '127.0.0.1',
            port: host.port,
            username: 'root',
            identityFile: host.identityFile,
            identitiesOnly: true,
            relayGracePeriodSeconds: 1
          }
        })
        const state = await window.api.ssh.connect({ targetId: createdTarget.id })
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(createdTarget.id, state)
        const labels = new Map(store.getState().sshTargetLabels)
        labels.set(createdTarget.id, createdTarget.label)
        store.getState().setSshTargetLabels(labels)
        return createdTarget.id
      } finally {
        credentialUnsub()
      }
    },
    { host, label }
  )
}

/** Add a repo on an already-connected host (so one server can own several repos)
 *  and return its repo + first worktree. */
async function addRepoOnHost(
  page: Page,
  targetId: string,
  remotePath: string,
  displayName: string
): Promise<RemoteWorkspace> {
  return await page.evaluate(
    async ({ targetId, remotePath, displayName }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const result = await window.api.repos.addRemote({
        connectionId: targetId,
        remotePath,
        displayName
      })
      if ('error' in result) {
        throw new Error(result.error)
      }
      await store.getState().fetchRepos()
      await store.getState().fetchWorktrees(result.repo.id)
      const worktree = (store.getState().worktreesByRepo[result.repo.id] ?? [])[0]
      if (!worktree) {
        throw new Error(`No remote worktree found for ${remotePath}`)
      }
      return { targetId, repoId: result.repo.id, worktreeId: worktree.id }
    },
    { targetId, remotePath, displayName }
  )
}

/** Open a terminal tab on a worktree and tag it with a marker title so it has a
 *  stable identity to assert across the reload. */
async function openMarkerTab(page: Page, worktreeId: string, marker: string): Promise<string> {
  return await page.evaluate(
    ({ worktreeId, marker }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const tab = store.getState().createTab(worktreeId)
      store.getState().setTabCustomTitle(tab.id, marker)
      store.getState().setActiveWorktree(worktreeId)
      return tab.id
    },
    { worktreeId, marker }
  )
}

/** Read the durable per-host session blob the main process persisted. */
async function readPersistedSession(page: Page): Promise<{
  tabsByWorktree: Record<string, { id: string }[]>
}> {
  return await page.evaluate(async () => {
    const session = await window.api.session.get()
    return { tabsByWorktree: session.tabsByWorktree ?? {} }
  })
}

/** After a reload, reconnect the known targets and refetch so the remote
 *  worktrees load back into the store (mirrors the app's auto-reconnect). */
async function reconnectAndRefetch(page: Page, targetIds: string[]): Promise<void> {
  await page.evaluate(async (targetIds) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    for (const targetId of targetIds) {
      const state = await window.api.ssh.connect({ targetId })
      if (state && state.status === 'connected') {
        store.getState().setSshConnectionState(targetId, state)
      }
    }
    await store.getState().fetchRepos()
    for (const repo of store.getState().repos) {
      await store.getState().fetchWorktrees(repo.id)
    }
  }, targetIds)
}

test.describe('multi-server refresh', () => {
  test.skip(
    !RUN_DOCKER_SSH,
    'Set ORCA_E2E_SSH_DOCKER=1 to run the Docker-backed multi-server test.'
  )
  test.skip(process.platform === 'win32', 'Docker SSH multi-server uses POSIX ssh tooling.')

  test('keeps the same project on two servers distinct and intact across a refresh', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let hosts: DockerSshHost[] | null = null
    try {
      hosts = startDockerSshHosts(testInfo, 2)
      const [hostB, hostC] = hosts
      seedRepoOnHost(hostB, SHARED_APP_PATH, 'shared app on B')
      seedRepoOnHost(hostB, B_ONLY_PATH, 'b only work')
      seedRepoOnHost(hostC, SHARED_APP_PATH, 'shared app on C')

      await waitForSessionReady(orcaPage)
      const localWorktreeId = await waitForActiveWorktree(orcaPage)

      // One connection per server (host B owns two repos: the shared project plus
      // its own separate work). This mirrors the reported setup.
      const targetB = await connectHost(orcaPage, hostB, 'host-B')
      const targetC = await connectHost(orcaPage, hostC, 'host-C')
      const sharedB = await addRepoOnHost(orcaPage, targetB, SHARED_APP_PATH, 'shared-app')
      const bOnly = await addRepoOnHost(orcaPage, targetB, B_ONLY_PATH, 'b-only')
      const sharedC = await addRepoOnHost(orcaPage, targetC, SHARED_APP_PATH, 'shared-app')

      // Same project, two servers → two distinct repos and worktrees.
      expect(sharedB.repoId).not.toBe(sharedC.repoId)
      expect(sharedB.worktreeId).not.toBe(sharedC.worktreeId)

      // A marker tab per worktree so we can prove each survives, attributed to the
      // right server.
      const tabLocal = await openMarkerTab(orcaPage, localWorktreeId, 'MARK_local')
      const tabSharedB = await openMarkerTab(orcaPage, sharedB.worktreeId, 'MARK_shared_B')
      const tabSharedC = await openMarkerTab(orcaPage, sharedC.worktreeId, 'MARK_shared_C')
      const tabBOnly = await openMarkerTab(orcaPage, bOnly.worktreeId, 'MARK_b_only')

      const allWorktreeIds = [
        localWorktreeId,
        sharedB.worktreeId,
        sharedC.worktreeId,
        bOnly.worktreeId
      ]

      // Park the active selection on the local worktree so the active assertion is
      // deterministic. (Restoring an active *remote* selection across reload is
      // subject to the relay-load race covered by the unit FAILURE MODE test.)
      await orcaPage.evaluate(
        (id) => window.__store?.getState().setActiveWorktree(id),
        localWorktreeId
      )

      // The durable session blob must carry every server's tabs before we reload.
      // Poll so the debounced session writer has flushed (this is a real assertion
      // about what persists, not just a wait).
      await expect
        .poll(
          async () => {
            const persisted = await readPersistedSession(orcaPage)
            const keys = Object.keys(persisted.tabsByWorktree)
            return allWorktreeIds.every((id) => keys.includes(id))
          },
          { timeout: 15_000, message: 'session did not persist every server’s tabs' }
        )
        .toBe(true)

      // Hard refresh: reload runs persistWorkspaceSessionByHostSync in beforeunload.
      await orcaPage.reload({ waitUntil: 'domcontentloaded' })
      await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      await waitForSessionReady(orcaPage)
      await reconnectAndRefetch(orcaPage, [targetB, targetC])

      // Every server's worktrees load back, with the same project kept distinct.
      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => {
              const state = window.__store?.getState()
              if (!state) {
                return []
              }
              return Object.values(state.worktreesByRepo)
                .flat()
                .map((worktree) => worktree.id)
            }),
          { timeout: 60_000, message: 'remote worktrees did not reload after refresh' }
        )
        .toEqual(expect.arrayContaining(allWorktreeIds))

      // Each worktree's marker tab survived (poll: remote tabs hydrate as the
      // relays reconnect). No state lost across the refresh.
      await expect
        .poll(
          async () =>
            orcaPage.evaluate(
              (ids) => {
                const state = window.__store?.getState()
                const tabsFor = (worktreeId: string): string[] =>
                  (state?.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
                return (
                  tabsFor(ids.local).includes(ids.tabLocal) &&
                  tabsFor(ids.sharedB).includes(ids.tabSharedB) &&
                  tabsFor(ids.sharedC).includes(ids.tabSharedC) &&
                  tabsFor(ids.bOnly).includes(ids.tabBOnly)
                )
              },
              {
                local: localWorktreeId,
                sharedB: sharedB.worktreeId,
                sharedC: sharedC.worktreeId,
                bOnly: bOnly.worktreeId,
                tabLocal,
                tabSharedB,
                tabSharedC,
                tabBOnly
              }
            ),
          { timeout: 30_000, message: 'not all marker tabs restored after refresh' }
        )
        .toBe(true)

      // No cross-server bleed: the same project's B and C tabs stay distinct, each
      // under its own worktree, with its own marker.
      const tabsSharedB = await getWorktreeTabs(orcaPage, sharedB.worktreeId)
      const tabsSharedC = await getWorktreeTabs(orcaPage, sharedC.worktreeId)
      expect(tabsSharedC.map((t) => t.id)).not.toContain(tabSharedB)
      expect(tabsSharedB.map((t) => t.id)).not.toContain(tabSharedC)
      expect(tabsSharedB.find((t) => t.id === tabSharedB)?.title).toBe('MARK_shared_B')
      expect(tabsSharedC.find((t) => t.id === tabSharedC)?.title).toBe('MARK_shared_C')

      testInfo.annotations.push({
        type: 'multi-server-refresh',
        description: `local + sharedB(${sharedB.repoId}) + sharedC(${sharedC.repoId}) + bOnly survived refresh`
      })
    } finally {
      cleanupDockerSshHosts(hosts)
    }
  })

  test('restores an active remote worktree after a refresh', async ({ orcaPage }, testInfo) => {
    test.slow()
    let hosts: DockerSshHost[] | null = null
    try {
      hosts = startDockerSshHosts(testInfo, 1)
      const [hostB] = hosts
      seedRepoOnHost(hostB, SHARED_APP_PATH, 'shared app on B')

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)

      const targetB = await connectHost(orcaPage, hostB, 'host-B')
      const remote = await addRepoOnHost(orcaPage, targetB, SHARED_APP_PATH, 'shared-app')
      const tabRemote = await openMarkerTab(orcaPage, remote.worktreeId, 'MARK_remote')

      // Park the active selection ON THE REMOTE worktree — the case the user hits.
      await orcaPage.evaluate(
        (id) => window.__store?.getState().setActiveWorktree(id),
        remote.worktreeId
      )
      await expect
        .poll(
          async () => {
            const persisted = await readPersistedSession(orcaPage)
            return Object.keys(persisted.tabsByWorktree).includes(remote.worktreeId)
          },
          { timeout: 15_000, message: 'remote tab did not persist' }
        )
        .toBe(true)

      // Hard refresh.
      await orcaPage.reload({ waitUntil: 'domcontentloaded' })
      await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      await waitForSessionReady(orcaPage)

      // The active selection must come back to the remote worktree, not get reset.
      await expect
        .poll(async () => getActiveWorktreeId(orcaPage), {
          timeout: 30_000,
          message: 'active remote worktree was not restored after refresh'
        })
        .toBe(remote.worktreeId)
      // And its tab is still there.
      const tabs = await getWorktreeTabs(orcaPage, remote.worktreeId)
      expect(tabs.map((t) => t.id)).toContain(tabRemote)
    } finally {
      cleanupDockerSshHosts(hosts)
    }
  })
})
