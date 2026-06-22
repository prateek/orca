import { expect, type Page } from '@stablyai/playwright-test'

import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import type { Project, ProjectHostSetup, Repo } from '../../../src/shared/types'
import type { LocalScenarioRepo } from './remote-orca-server-desktop'
import {
  REMOTE_ORCA_SHARED_PROJECT_ID,
  type RemoteOrcaServerScenario
} from './remote-orca-server-runtime'

type StoreRepoSummary = Pick<
  Repo,
  'id' | 'path' | 'displayName' | 'executionHostId' | 'upstream'
> & {
  hostId: string
}

type StoreStateSummary = {
  repos: StoreRepoSummary[]
  projects: Pick<Project, 'id' | 'sourceRepoIds'>[]
  projectHostSetups: Pick<ProjectHostSetup, 'projectId' | 'hostId' | 'repoId' | 'path'>[]
}

function repoIsSharedProject(repo: Pick<Repo, 'upstream'>): boolean {
  return repo.upstream?.owner === 'stablyai' && repo.upstream.repo === 'orca'
}

export async function readRemoteOrcaDesktopState(page: Page): Promise<StoreStateSummary> {
  return await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const hostIdForRepo = (repo: Pick<Repo, 'executionHostId' | 'connectionId'>): string => {
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

export async function assertDesktopMatchesRemoteOrcaServers(
  page: Page,
  args: {
    localRepos: readonly LocalScenarioRepo[]
    servers: readonly RemoteOrcaServerScenario[]
  }
): Promise<void> {
  const state = await readRemoteOrcaDesktopState(page)
  const expectedRepos = expectedScenarioRepos(args.localRepos, args.servers)
  const expectedKeys = expectedRepos.map((repo) => `${repo.hostId}:${repo.id}`).sort()
  expect(state.repos.map((repo) => `${repo.hostId}:${repo.id}`).sort()).toEqual(expectedKeys)

  for (const expectedRepo of expectedRepos) {
    const match = state.repos.find(
      (repo) => repo.id === expectedRepo.id && repo.hostId === expectedRepo.hostId
    )
    expect(match, `${expectedRepo.hostId}:${expectedRepo.path}`).toMatchObject({
      path: expectedRepo.path,
      displayName: expectedRepo.displayName
    })
  }

  assertProjectHostSetupsMatch(state, expectedRepos)
  assertSharedProjectMatches(state, expectedRepos)
}

function assertProjectHostSetupsMatch(
  state: StoreStateSummary,
  expectedRepos: ReturnType<typeof expectedScenarioRepos>
): void {
  const expectedSetupKeys = expectedRepos.map((repo) => `${repo.hostId}:${repo.id}`).sort()
  expect(state.projectHostSetups.map((setup) => `${setup.hostId}:${setup.repoId}`).sort()).toEqual(
    expectedSetupKeys
  )
  for (const expectedRepo of expectedRepos) {
    const setup = state.projectHostSetups.find(
      (candidate) =>
        candidate.repoId === expectedRepo.id && candidate.hostId === expectedRepo.hostId
    )
    expect(setup, `${expectedRepo.hostId}:${expectedRepo.id} setup`).toMatchObject({
      path: expectedRepo.path
    })
  }
}

function assertSharedProjectMatches(
  state: StoreStateSummary,
  expectedRepos: ReturnType<typeof expectedScenarioRepos>
): void {
  const expectedSharedRepoIds = expectedRepos
    .filter((repo) => repo.sharedProject)
    .map((repo) => repo.id)
    .sort()
  const sharedProject = state.projects.find(
    (project) => project.id === REMOTE_ORCA_SHARED_PROJECT_ID
  )
  expect(sharedProject?.sourceRepoIds.toSorted()).toEqual(expectedSharedRepoIds)
}

function expectedScenarioRepos(
  localRepos: readonly LocalScenarioRepo[],
  servers: readonly RemoteOrcaServerScenario[]
): {
  id: string
  hostId: string
  path: string
  displayName: string
  sharedProject: boolean
}[] {
  return [
    ...localRepos.map((repo) => ({
      id: repo.id,
      hostId: getRepoExecutionHostId(repo),
      path: repo.path,
      displayName: repo.displayName,
      sharedProject: repoIsSharedProject(repo)
    })),
    ...servers.flatMap((server) => {
      if (!server.environmentId) {
        throw new Error(`Remote server ${server.name} is not paired`)
      }
      return server.repos.map((repo) => ({
        id: repo.id,
        hostId: `runtime:${server.environmentId}`,
        path: repo.path,
        displayName: repo.displayName,
        sharedProject: repoIsSharedProject(repo)
      }))
    })
  ]
}
