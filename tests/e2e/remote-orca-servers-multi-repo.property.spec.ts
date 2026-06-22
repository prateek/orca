import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

import type { Page, TestInfo } from '@stablyai/playwright-test'

import { test } from './helpers/orca-app'
import { createLocalGitRepo } from './helpers/local-git-repo-fixture'
import {
  activateRuntimeEnvironment,
  addLocalRepoForRemoteOrcaScenario,
  addRemoteRepoFromDesktop,
  pairRemoteOrcaServer,
  removeRemoteOrcaServerFromDesktop,
  removeRemoteRepoFromDesktop,
  renameRemoteRepoFromDesktop,
  renameRemoteRepoThroughEnvironment,
  reorderReposFromDesktop,
  type LocalScenarioRepo
} from './helpers/remote-orca-server-desktop'
import {
  assertDesktopMatchesRemoteOrcaServers,
  readRemoteOrcaDesktopState
} from './helpers/remote-orca-server-state-assertions'
import {
  startRemoteOrcaServerScenario,
  stopRemoteOrcaServerScenario,
  type RemoteOrcaServerScenario
} from './helpers/remote-orca-server-runtime'
import { createRandom, pick, shuffle } from './helpers/seeded-property-random'
import { waitForSessionReady } from './helpers/store'

const RUN_REMOTE_ORCA_SERVERS = process.env.ORCA_E2E_REMOTE_ORCA_SERVERS === '1'
const SEED_COUNT = readPositiveIntegerEnv('ORCA_E2E_REMOTE_ORCA_SERVER_PROP_SEEDS', 1)
const STEP_COUNT = readPositiveIntegerEnv('ORCA_E2E_REMOTE_ORCA_SERVER_PROP_STEPS', 10)
const SHARED_ORIGIN_URL = 'git@github.com:prateek/orca.git'
const SHARED_UPSTREAM_URL = 'git@github.com:stablyai/orca.git'

type OperationLog = string[]

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function annotateSequence(testInfo: TestInfo, seed: number, log: OperationLog): void {
  testInfo.annotations.push({
    type: 'remote-orca-server-multi-repo-property',
    description: `seed=${seed} steps=${log.join(' | ')}`
  })
}

async function pairServers(
  page: Page,
  servers: readonly RemoteOrcaServerScenario[],
  log: OperationLog
): Promise<void> {
  for (const server of servers) {
    const environmentId = await pairRemoteOrcaServer(page, server)
    log.push(`setup: pair ${server.key} as ${environmentId}`)
  }
}

async function refreshAllHosts(
  page: Page,
  servers: readonly RemoteOrcaServerScenario[]
): Promise<void> {
  await activateRuntimeEnvironment(page, null)
  for (const server of servers) {
    await activateRuntimeEnvironment(page, server.environmentId ?? null)
  }
}

async function reloadDesktop(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await waitForSessionReady(page)
}

async function refreshRandomHost(
  page: Page,
  servers: readonly RemoteOrcaServerScenario[],
  random: () => number,
  step: number,
  log: OperationLog
): Promise<void> {
  const target = pick(random, ['local', ...servers] as const)
  if (target === 'local') {
    await activateRuntimeEnvironment(page, null)
    log.push(`${step}: refresh local`)
    return
  }
  await activateRuntimeEnvironment(page, target.environmentId ?? null)
  log.push(`${step}: refresh ${target.key}`)
}

async function reorderFromDesktop(
  page: Page,
  random: () => number,
  step: number,
  log: OperationLog
): Promise<void> {
  const state = await readRemoteOrcaDesktopState(page)
  const orderedIds = shuffle(
    random,
    state.repos.map((repo) => repo.id)
  )
  await reorderReposFromDesktop(page, orderedIds)
  log.push(`${step}: reorder ${orderedIds.join(',')}`)
}

async function applyGeneratedOperation(
  page: Page,
  servers: readonly RemoteOrcaServerScenario[],
  random: () => number,
  step: number,
  log: OperationLog
): Promise<void> {
  const server = pick(random, servers)
  const operation = pick(random, [
    'refresh',
    'desktop-rename',
    'server-rename',
    'desktop-add',
    'desktop-remove',
    'reorder',
    'reload'
  ] as const)
  if (operation === 'refresh') {
    await refreshRandomHost(page, servers, random, step, log)
  } else if (operation === 'desktop-rename') {
    await renameServerRepoFromDesktop(page, server, random, step, log)
  } else if (operation === 'server-rename') {
    await renameServerRepoDirectly(page, server, random, step, log)
  } else if (operation === 'desktop-add') {
    await addServerRepoFromDesktop(page, server, random, step, log)
  } else if (operation === 'desktop-remove') {
    await removeServerRepoFromDesktop(page, server, random, step, log)
  } else if (operation === 'reorder') {
    await reorderFromDesktop(page, random, step, log)
  } else {
    await reloadDesktop(page)
    log.push(`${step}: reload desktop`)
  }
}

async function renameServerRepoFromDesktop(
  page: Page,
  server: RemoteOrcaServerScenario,
  random: () => number,
  step: number,
  log: OperationLog
): Promise<void> {
  const repo = pick(random, server.repos)
  const displayName = `${repo.displayName} desktop ${step}`
  await renameRemoteRepoFromDesktop(page, server, repo.id, displayName)
  log.push(`${step}: desktop rename ${server.key}/${repo.id}`)
}

async function renameServerRepoDirectly(
  page: Page,
  server: RemoteOrcaServerScenario,
  random: () => number,
  step: number,
  log: OperationLog
): Promise<void> {
  const repo = pick(random, server.repos)
  const displayName = `${repo.displayName} server ${step}`
  await renameRemoteRepoThroughEnvironment(page, server, repo.id, displayName)
  log.push(`${step}: server rename ${server.key}/${repo.id}`)
}

async function addServerRepoFromDesktop(
  page: Page,
  server: RemoteOrcaServerScenario,
  random: () => number,
  step: number,
  log: OperationLog
): Promise<void> {
  const sharedProject = random() < 0.5
  const slug = sharedProject ? `shared-orca-${step}` : `${server.key}-side-${step}`
  const repo = await addRemoteRepoFromDesktop(page, server, { slug, sharedProject })
  log.push(`${step}: desktop add ${server.key}/${repo.id}`)
}

async function removeServerRepoFromDesktop(
  page: Page,
  server: RemoteOrcaServerScenario,
  random: () => number,
  step: number,
  log: OperationLog
): Promise<void> {
  const repos = server.repos
  if (repos.length <= 1) {
    await refreshRandomHost(page, [server], random, step, log)
    return
  }
  const repo = pick(random, repos)
  await removeRemoteRepoFromDesktop(page, server, repo.id)
  log.push(`${step}: desktop remove ${server.key}/${repo.id}`)
}

test.use({ seedTestRepo: false })

test.describe('Remote Orca Servers multi-repo properties', () => {
  test.skip(
    !RUN_REMOTE_ORCA_SERVERS,
    'Set ORCA_E2E_REMOTE_ORCA_SERVERS=1 to run Remote Orca Servers repo properties.'
  )

  for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
    test(`preserves desktop state across paired Remote Orca Servers, seed ${seed}`, async ({
      orcaPage
    }, testInfo) => {
      test.slow()
      const log: OperationLog = []
      const servers: RemoteOrcaServerScenario[] = []
      const localRepos: LocalScenarioRepo[] = []
      let localRoot: string | null = null

      try {
        await waitForSessionReady(orcaPage)
        localRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-remote-server-local-'))
        const localPath = createLocalGitRepo(localRoot, 'shared-orca', {
          originUrl: SHARED_ORIGIN_URL,
          upstreamUrl: SHARED_UPSTREAM_URL
        })
        localRepos.push(await addLocalRepoForRemoteOrcaScenario(orcaPage, localPath))
        log.push(`setup: add local as ${localRepos[0].id}`)

        servers.push(
          await startRemoteOrcaServerScenario({
            key: 'server-a',
            name: `Remote Orca Server A ${seed}`
          })
        )
        servers.push(
          await startRemoteOrcaServerScenario({
            key: 'server-b',
            name: `Remote Orca Server B ${seed}`
          })
        )
        await pairServers(orcaPage, servers, log)
        await addRemoteRepoFromDesktop(orcaPage, servers[0], {
          slug: 'shared-orca',
          sharedProject: true
        })
        await addRemoteRepoFromDesktop(orcaPage, servers[1], {
          slug: 'shared-orca',
          sharedProject: true
        })
        await addRemoteRepoFromDesktop(orcaPage, servers[1], {
          slug: 'server-b-side-project',
          sharedProject: false
        })
        await refreshAllHosts(orcaPage, servers)
        await assertDesktopMatchesRemoteOrcaServers(orcaPage, { localRepos, servers })

        const random = createRandom(seed)
        for (let step = 1; step <= STEP_COUNT; step += 1) {
          await applyGeneratedOperation(orcaPage, servers, random, step, log)
          await assertDesktopMatchesRemoteOrcaServers(orcaPage, { localRepos, servers })
        }
      } catch (error) {
        annotateSequence(testInfo, seed, log)
        throw error
      } finally {
        annotateSequence(testInfo, seed, log)
        try {
          try {
            await Promise.all(
              servers.map((server) => removeRemoteOrcaServerFromDesktop(orcaPage, server))
            )
          } finally {
            await Promise.all(servers.map((server) => stopRemoteOrcaServerScenario(server)))
          }
        } finally {
          if (localRoot) {
            rmSync(localRoot, { recursive: true, force: true })
          }
        }
      }
    })
  }
})
