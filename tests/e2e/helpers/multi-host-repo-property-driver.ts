import { expect, type Page } from '@stablyai/playwright-test'
import type { Project, ProjectHostSetup, Repo } from '../../../src/shared/types'
import {
  addDockerSshRepo,
  reconnectDockerSshTarget,
  type ConnectedDockerSshTarget
} from './docker-ssh-repo-scenario'
import { pick, shuffle } from './seeded-property-random'
import { waitForSessionReady } from './store'

export type ScenarioRepoKind = 'local' | 'ssh'

export type ScenarioRepo = {
  key: string
  kind: ScenarioRepoKind
  hostId: string
  path: string
  displayName: string
  sharedProject: boolean
  targetId?: string
  repoId?: string
  expectedDisplayName?: string
}

export type OperationLog = string[]

type StoreRepoSummary = Pick<
  Repo,
  'id' | 'path' | 'displayName' | 'connectionId' | 'executionHostId' | 'upstream'
> & {
  hostId: string
}

type StoreStateSummary = {
  repos: StoreRepoSummary[]
  projects: Pick<Project, 'id' | 'sourceRepoIds'>[]
  projectHostSetups: Pick<ProjectHostSetup, 'projectId' | 'hostId' | 'repoId' | 'path'>[]
}

async function addLocalRepo(page: Page, repoPath: string): Promise<Repo> {
  return await page.evaluate(async (repoPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    await store.getState().fetchRepos()
    const repo =
      store.getState().repos.find((candidate) => candidate.id === result.repo.id) ??
      store.getState().repos.find((candidate) => candidate.path === repoPath)
    if (!repo) {
      throw new Error(`Expected local repo to be loaded: ${repoPath}`)
    }
    return repo
  }, repoPath)
}

export async function addScenarioRepo(page: Page, repo: ScenarioRepo): Promise<void> {
  const added =
    repo.kind === 'local'
      ? await addLocalRepo(page, repo.path)
      : (
          await addDockerSshRepo(page, {
            targetId: repo.targetId ?? '',
            remotePath: repo.path,
            displayName: repo.displayName
          })
        ).repo
  repo.repoId = added.id
  repo.expectedDisplayName = added.displayName
}

async function removeScenarioRepo(page: Page, repo: ScenarioRepo): Promise<void> {
  if (!repo.repoId) {
    return
  }
  await page.evaluate(async (repoId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await window.api.repos.remove({ repoId })
    await store.getState().fetchRepos()
  }, repo.repoId)
  repo.repoId = undefined
  repo.expectedDisplayName = undefined
}

async function renameScenarioRepo(
  page: Page,
  repo: ScenarioRepo,
  displayName: string
): Promise<void> {
  if (!repo.repoId) {
    return
  }
  await page.evaluate(
    async ({ displayName, repoId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      await store.getState().updateRepo(repoId, { displayName })
      await store.getState().fetchRepos()
    },
    { displayName, repoId: repo.repoId }
  )
  repo.expectedDisplayName = displayName
}

async function refreshRepos(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await store.getState().fetchRepos()
  })
}

async function reorderRepos(page: Page, orderedRepoIds: string[]): Promise<void> {
  await page.evaluate(async (orderedRepoIds) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await store.getState().reorderRepos(orderedRepoIds)
  }, orderedRepoIds)
}

async function reloadAndReconnect(
  page: Page,
  targets: readonly ConnectedDockerSshTarget[]
): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await waitForSessionReady(page)
  for (const target of targets) {
    await reconnectDockerSshTarget(page, target)
  }
  await refreshRepos(page)
}

export async function readStoreState(page: Page): Promise<StoreStateSummary> {
  return await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const hostIdForRepo = (repo: Pick<Repo, 'connectionId' | 'executionHostId'>): string => {
      if (repo.executionHostId?.trim()) {
        return repo.executionHostId
      }
      return repo.connectionId ? `ssh:${encodeURIComponent(repo.connectionId)}` : 'local'
    }
    return {
      repos: state.repos.map((repo) => ({
        id: repo.id,
        path: repo.path,
        displayName: repo.displayName,
        connectionId: repo.connectionId,
        executionHostId: repo.executionHostId,
        upstream: repo.upstream,
        hostId: hostIdForRepo(repo)
      })),
      projects: state.projects.map((project) => ({
        id: project.id,
        sourceRepoIds: project.sourceRepoIds
      })),
      projectHostSetups: state.projectHostSetups.map((setup) => ({
        projectId: setup.projectId,
        hostId: setup.hostId,
        repoId: setup.repoId,
        path: setup.path
      }))
    }
  })
}

export function assertScenarioState(
  entries: readonly ScenarioRepo[],
  state: StoreStateSummary,
  sharedProjectId: string
): void {
  const repoMatches = (entry: ScenarioRepo): StoreRepoSummary[] =>
    state.repos.filter((repo) => repo.hostId === entry.hostId && repo.path === entry.path)

  for (const entry of entries) {
    const matches = repoMatches(entry)
    if (!entry.repoId) {
      expect(matches, `${entry.key} should not be present`).toHaveLength(0)
      continue
    }
    expect(matches, `${entry.key} should have exactly one host/path match`).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      id: entry.repoId,
      hostId: entry.hostId,
      displayName: entry.expectedDisplayName
    })
  }

  const activeEntries = entries.filter((entry) => entry.repoId)
  const activeRepoIds = activeEntries.map((entry) => entry.repoId as string).sort()
  const activeSetups = state.projectHostSetups
    .filter((setup) => activeRepoIds.includes(setup.repoId))
    .sort((a, b) => a.repoId.localeCompare(b.repoId))
  expect(activeSetups.map((setup) => setup.repoId)).toEqual(activeRepoIds)
  for (const entry of activeEntries) {
    const setup = activeSetups.find((candidate) => candidate.repoId === entry.repoId)
    expect(setup, `${entry.key} should have a project host setup`).toMatchObject({
      hostId: entry.hostId,
      path: entry.path
    })
  }

  const sharedRepoIds = activeEntries
    .filter((entry) => entry.sharedProject)
    .map((entry) => entry.repoId as string)
    .sort()
  const sharedProject = state.projects.find((project) => project.id === sharedProjectId)
  if (sharedRepoIds.length === 0) {
    expect(sharedProject).toBeUndefined()
  } else {
    expect(sharedProject?.sourceRepoIds.toSorted()).toEqual(sharedRepoIds)
  }
  expect(
    state.projectHostSetups
      .filter((setup) => setup.projectId === sharedProjectId)
      .map((setup) => setup.repoId)
      .sort()
  ).toEqual(sharedRepoIds)
}

export async function applyGeneratedOperation(
  page: Page,
  entries: ScenarioRepo[],
  targets: readonly ConnectedDockerSshTarget[],
  random: () => number,
  step: number,
  log: OperationLog
): Promise<void> {
  const active = entries.filter((entry) => entry.repoId)
  const inactive = entries.filter((entry) => !entry.repoId)
  const operations = [
    'refresh',
    'rename',
    'reorder',
    'reload',
    ...(inactive.length > 0 ? ['add', 'add'] : []),
    ...(active.length > 2 ? ['remove'] : [])
  ] as const
  const operation = pick(random, operations)
  switch (operation) {
    case 'add': {
      const entry = pick(random, inactive)
      await addScenarioRepo(page, entry)
      log.push(`${step}: add ${entry.key} as ${entry.repoId}`)
      break
    }
    case 'remove': {
      const entry = pick(random, active)
      const repoId = entry.repoId
      await removeScenarioRepo(page, entry)
      log.push(`${step}: remove ${entry.key} (${repoId})`)
      break
    }
    case 'rename': {
      const entry = pick(random, active)
      const displayName = `${entry.displayName} ${step}`
      await renameScenarioRepo(page, entry, displayName)
      log.push(`${step}: rename ${entry.key} to ${displayName}`)
      break
    }
    case 'reorder': {
      const orderedIds = shuffle(random, active).map((entry) => entry.repoId as string)
      await reorderRepos(page, orderedIds)
      log.push(`${step}: reorder ${orderedIds.join(',')}`)
      break
    }
    case 'reload':
      await reloadAndReconnect(page, targets)
      log.push(`${step}: reload`)
      break
    case 'refresh':
      await refreshRepos(page)
      log.push(`${step}: refresh`)
      break
  }
}
