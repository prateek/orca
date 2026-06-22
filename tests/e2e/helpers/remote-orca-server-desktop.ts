import type { Page } from '@stablyai/playwright-test'

import type { Repo } from '../../../src/shared/types'
import {
  createRemoteServerGitRepo,
  rememberRemoteScenarioRepo,
  removeRemoteScenarioRepo,
  type RemoteOrcaRepoSeed,
  type RemoteOrcaServerScenario
} from './remote-orca-server-runtime'

export type LocalScenarioRepo = Pick<Repo, 'id' | 'path' | 'displayName' | 'upstream'>

export async function pairRemoteOrcaServer(
  page: Page,
  scenario: RemoteOrcaServerScenario
): Promise<string> {
  const environmentId = await page.evaluate(
    async ({ name, pairingCode }) => {
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name,
        pairingCode
      })
      const status = await window.api.runtimeEnvironments.getStatus({
        selector: result.environment.id,
        timeoutMs: 15_000
      })
      if (!status.ok) {
        throw new Error(status.error.message)
      }
      return result.environment.id
    },
    { name: scenario.name, pairingCode: scenario.pairingCode }
  )
  scenario.environmentId = environmentId
  return environmentId
}

export async function addLocalRepoForRemoteOrcaScenario(
  page: Page,
  repoPath: string
): Promise<LocalScenarioRepo> {
  return await page.evaluate(async (pathToAdd) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const result = await window.api.repos.add({ path: pathToAdd })
    if ('error' in result) {
      throw new Error(result.error)
    }
    await store.getState().fetchRepos()
    const repo =
      store.getState().repos.find((candidate) => candidate.id === result.repo.id) ??
      store.getState().repos.find((candidate) => candidate.path === pathToAdd)
    if (!repo) {
      throw new Error(`Expected local repo to be loaded: ${pathToAdd}`)
    }
    return {
      id: repo.id,
      path: repo.path,
      displayName: repo.displayName,
      upstream: repo.upstream
    }
  }, repoPath)
}

export async function activateRuntimeEnvironment(
  page: Page,
  environmentId: string | null
): Promise<void> {
  await page.evaluate(async (nextEnvironmentId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    if (typeof state.switchRuntimeEnvironment === 'function') {
      const switched = await state.switchRuntimeEnvironment(nextEnvironmentId)
      if (!switched) {
        throw new Error(`Failed to switch runtime environment: ${nextEnvironmentId ?? 'local'}`)
      }
    } else {
      await state.updateSettings({ activeRuntimeEnvironmentId: nextEnvironmentId })
    }
    await store.getState().fetchRepos()
  }, environmentId)
}

export async function addRemoteRepoFromDesktop(
  page: Page,
  scenario: RemoteOrcaServerScenario,
  seed: RemoteOrcaRepoSeed
): Promise<Repo> {
  if (!scenario.environmentId) {
    throw new Error(`Remote server ${scenario.name} is not paired`)
  }
  const repoPath = createRemoteServerGitRepo(scenario, seed)
  await activateRuntimeEnvironment(page, scenario.environmentId)
  const repo = await page.evaluate(async (pathToAdd) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const added = await store.getState().addRepoPath(pathToAdd)
    if (!added) {
      throw new Error(`Expected remote repo to be added: ${pathToAdd}`)
    }
    return added
  }, repoPath)
  rememberRemoteScenarioRepo(scenario, repo)
  return repo
}

export async function renameRemoteRepoFromDesktop(
  page: Page,
  scenario: RemoteOrcaServerScenario,
  repoId: string,
  displayName: string
): Promise<void> {
  const repo = await page.evaluate(
    async ({ id, name }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const updated = await store.getState().updateRepo(id, { displayName: name })
      if (!updated) {
        throw new Error(`Expected remote repo to be renamed: ${id}`)
      }
      const repo = store.getState().repos.find((candidate) => candidate.id === id)
      if (!repo) {
        throw new Error(`Expected renamed remote repo to stay loaded: ${id}`)
      }
      return repo
    },
    { id: repoId, name: displayName }
  )
  rememberRemoteScenarioRepo(scenario, repo)
}

export async function renameRemoteRepoThroughEnvironment(
  page: Page,
  scenario: RemoteOrcaServerScenario,
  repoId: string,
  displayName: string
): Promise<void> {
  if (!scenario.environmentId) {
    throw new Error(`Remote server ${scenario.name} is not paired`)
  }
  const repo = await page.evaluate(
    async ({ selector, id, name }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector,
        method: 'repo.update',
        params: { repo: id, updates: { displayName: name } },
        timeoutMs: 15_000
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return (response.result as { repo: Repo }).repo
    },
    { selector: scenario.environmentId, id: repoId, name: displayName }
  )
  rememberRemoteScenarioRepo(scenario, repo)
  await activateRuntimeEnvironment(page, scenario.environmentId)
}

export async function removeRemoteRepoFromDesktop(
  page: Page,
  scenario: RemoteOrcaServerScenario,
  repoId: string
): Promise<void> {
  await page.evaluate(async (id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await store.getState().removeProject(id)
  }, repoId)
  removeRemoteScenarioRepo(scenario, repoId)
}

export async function reorderReposFromDesktop(page: Page, orderedIds: string[]): Promise<void> {
  await page.evaluate(async (ids) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await store.getState().reorderRepos(ids)
  }, orderedIds)
}
