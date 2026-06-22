import type { Page } from '@stablyai/playwright-test'

import { test, expect } from './helpers/orca-app'
import {
  activateRuntimeEnvironment,
  addRemoteRepoFromDesktop,
  pairRemoteOrcaServer
} from './helpers/remote-orca-server-desktop'
import { readRemoteOrcaDesktopState } from './helpers/remote-orca-server-state-assertions'
import {
  startRemoteOrcaServerScenario,
  stopRemoteOrcaServerScenario,
  type RemoteOrcaServerScenario
} from './helpers/remote-orca-server-runtime'
import { waitForSessionReady } from './helpers/store'

const RUN_REMOTE_ORCA_SERVERS = process.env.ORCA_E2E_REMOTE_ORCA_SERVERS === '1'

test.use({ seedTestRepo: false })

test.describe('Remote Orca Server repo update repro', () => {
  test.skip(
    !RUN_REMOTE_ORCA_SERVERS,
    'Set ORCA_E2E_REMOTE_ORCA_SERVERS=1 to run Remote Orca Servers repo update repro.'
  )

  test('persists a desktop-routed remote repo display name update across refresh', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let server: RemoteOrcaServerScenario | null = null
    try {
      await waitForSessionReady(orcaPage)
      server = await startRemoteOrcaServerScenario(testInfo, {
        key: 'server-a',
        name: 'Remote Orca Server Repo Update Repro'
      })
      await pairRemoteOrcaServer(orcaPage, server)
      const repo = await addRemoteRepoFromDesktop(orcaPage, server, {
        slug: 'repo-update-repro',
        sharedProject: false
      })

      const requestedName = 'Repo update repro renamed'
      const immediateName = await renameRepoThroughDesktopStore(orcaPage, repo.id, requestedName)
      expect(immediateName).toBe(requestedName)

      const serverListName = await readRemoteRepoListDisplayName(
        orcaPage,
        requireRemoteEnvironmentId(server),
        repo.id
      )
      expect(serverListName).toBe(requestedName)

      await reloadDesktop(orcaPage)
      await activateRuntimeEnvironment(orcaPage, null)
      await activateRuntimeEnvironment(orcaPage, requireRemoteEnvironmentId(server))
      const state = await readRemoteOrcaDesktopState(orcaPage)
      expect(state.repos.find((candidate) => candidate.id === repo.id)?.displayName).toBe(
        requestedName
      )
    } finally {
      await stopRemoteOrcaServerScenario(server)
    }
  })
})

async function renameRepoThroughDesktopStore(
  page: Page,
  repoId: string,
  displayName: string
): Promise<string | undefined> {
  return await page.evaluate(
    async ({ id, name }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const updated = await store.getState().updateRepo(id, { displayName: name })
      if (!updated) {
        throw new Error(`Expected remote repo update to succeed: ${id}`)
      }
      return store.getState().repos.find((repo) => repo.id === id)?.displayName
    },
    { id: repoId, name: displayName }
  )
}

async function readRemoteRepoListDisplayName(
  page: Page,
  environmentId: string,
  repoId: string
): Promise<string | undefined> {
  return await page.evaluate(
    async ({ selector, id }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector,
        method: 'repo.list',
        timeoutMs: 15_000
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return (response.result as { repos: { id: string; displayName: string }[] }).repos.find(
        (repo) => repo.id === id
      )?.displayName
    },
    { selector: environmentId, id: repoId }
  )
}

async function reloadDesktop(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await waitForSessionReady(page)
}

function requireRemoteEnvironmentId(server: RemoteOrcaServerScenario): string {
  if (!server.environmentId) {
    throw new Error(`Remote server ${server.name} is not paired`)
  }
  return server.environmentId
}
