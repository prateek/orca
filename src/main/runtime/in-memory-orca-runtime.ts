/**
 * In-memory Orca runtime backing repos / worktrees / project groups for "Remote
 * Orca Servers" consistency tests.
 *
 * An Orca instance can run as an "Orca Server" (an Orca *runtime*) that paired
 * clients connect to over an E2EE WebSocket and operate on via RPC
 * (`repo.list`, `worktree.create`, `projectGroup.create`, …). Consistency is
 * event-push: after a mutation the server emits a `reposChanged` /
 * `worktreesChanged` event to subscribed clients, which then re-query.
 *
 * This is the data-store fake behind the runtime — the legitimate boundary. Its
 * mutations emit the same events the real `OrcaRuntime` emits
 * (`notifyReposChanged` on repo/project changes, `notifyWorktreesChanged` on
 * worktree create), so tests driving it through the real server exercise the
 * actual push-and-reconverge consistency path. The server transport lives in
 * orca-runtime-server-harness.ts.
 */
import { getDefaultRepoHookSettings } from '../../shared/constants'
import type { ProjectGroup, Repo } from '../../shared/types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { OrcaRuntimeService } from './orca-runtime'

type DetectedWorktree = {
  id: string
  repoId: string
  path: string
  branch: string
  displayName: string
  isMainWorktree: boolean
}

/** A normalized, comparable snapshot of a server's repos / worktrees / project
 *  groups — the shape both the server source of truth and a client's re-queried
 *  view reduce to, so "consistent view" is a deep-equality check. */
export type NormalizedView = {
  repos: { id: string; path: string; displayName: string; projectGroupId: string | null }[]
  worktreesByRepo: Record<string, string[]>
  projectGroups: { id: string; name: string }[]
}

export type InMemoryOrcaRuntime = {
  runtimeId: string
  service: OrcaRuntimeService
  /** The server-side source of truth, normalized for comparison. */
  truthView(): NormalizedView
}

/** Build an in-memory Orca runtime backing repos / worktrees / project groups,
 *  emitting the same client events the real runtime emits on each mutation. */
export function createInMemoryOrcaRuntime(
  runtimeId: string,
  seedRepoNames: string[] = []
): InMemoryOrcaRuntime {
  const repos: Repo[] = []
  const worktreesByRepo = new Map<string, DetectedWorktree[]>()
  const projectGroups: ProjectGroup[] = []
  const listeners = new Set<(event: RuntimeClientEvent) => void>()
  const subscriptionCleanups = new Map<string, () => void>()
  let counter = 0

  const emit = (event: RuntimeClientEvent): void => {
    for (const listener of listeners) {
      listener(event)
    }
  }

  const addRepoInternal = (name: string, kind: 'git' | 'folder' = 'git'): Repo => {
    counter += 1
    const id = `${runtimeId}-repo-${counter}`
    const repo: Repo = {
      id,
      path: `/srv/${runtimeId}/${name}`,
      displayName: name,
      badgeColor: 'blue',
      addedAt: counter,
      hookSettings: getDefaultRepoHookSettings(),
      worktreeBaseRef: 'main',
      kind,
      projectGroupId: null
    }
    repos.push(repo)
    worktreesByRepo.set(id, [
      {
        id: `${id}::main`,
        repoId: id,
        path: repo.path,
        branch: 'main',
        displayName: name,
        isMainWorktree: true
      }
    ])
    return repo
  }

  for (const name of seedRepoNames) {
    addRepoInternal(name)
  }

  const resolveRepo = (selector: string): Repo => {
    const id = selector.startsWith('id:') ? selector.slice('id:'.length) : selector
    const repo = repos.find((r) => r.id === id || r.path === id)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    return repo
  }

  const service = {
    getRuntimeId: () => runtimeId,
    getStartedAt: () => 1,
    cleanupSubscriptionsForConnection: (connectionId: string) => {
      for (const [id, cleanup] of Array.from(subscriptionCleanups)) {
        if (id.includes(connectionId)) {
          cleanup()
          subscriptionCleanups.delete(id)
        }
      }
    },
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => {
      subscriptionCleanups.set(id, cleanup)
    },
    cleanupSubscription: (id: string) => {
      subscriptionCleanups.get(id)?.()
      subscriptionCleanups.delete(id)
    },
    cancelMobileDictationForConnection: () => {},
    onClientDisconnected: () => {},
    onClientEvent: (listener: (event: RuntimeClientEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    listRepos: () => repos.map((repo) => ({ ...repo })),
    showRepo: (selector: string) => ({ ...resolveRepo(selector) }),
    addRepo: (path: string, kind: 'git' | 'folder' = 'git') => {
      const name = path.split('/').filter(Boolean).at(-1) ?? `repo-${counter + 1}`
      const repo = addRepoInternal(name, kind)
      emit({ type: 'reposChanged' })
      return { ...repo }
    },
    removeProject: (selector: string) => {
      const repo = resolveRepo(selector)
      const index = repos.indexOf(repo)
      repos.splice(index, 1)
      worktreesByRepo.delete(repo.id)
      emit({ type: 'reposChanged' })
      return { removed: true as const }
    },

    listManagedWorktrees: (selector: string) => worktreesByRepo.get(resolveRepo(selector).id) ?? [],
    listDetectedManagedWorktrees: (selector: string) => {
      const repo = resolveRepo(selector)
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git' as const,
        worktrees: (worktreesByRepo.get(repo.id) ?? []).map((wt) => ({ ...wt }))
      }
    },
    createManagedWorktree: ({ repoSelector, name }: { repoSelector: string; name?: string }) => {
      const repo = resolveRepo(repoSelector)
      const branch = name && name.length > 0 ? name : `wt-${counter + 1}`
      const worktree: DetectedWorktree = {
        id: `${repo.id}::${branch}`,
        repoId: repo.id,
        path: `${repo.path}/${branch}`,
        branch,
        displayName: branch,
        isMainWorktree: false
      }
      const list = worktreesByRepo.get(repo.id) ?? []
      list.push(worktree)
      worktreesByRepo.set(repo.id, list)
      emit({ type: 'worktreesChanged', repoId: repo.id })
      return { worktree: { ...worktree } }
    },

    listProjectGroups: () => projectGroups.map((group) => ({ ...group })),
    createProjectGroup: (input: { name: string }) => {
      counter += 1
      const group: ProjectGroup = {
        id: `${runtimeId}-group-${counter}`,
        name: input.name,
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: counter,
        updatedAt: counter
      }
      projectGroups.push(group)
      emit({ type: 'reposChanged' })
      return { ...group }
    },
    moveProjectToGroup: (selector: string, groupId: string | null) => {
      const repo = resolveRepo(selector)
      repo.projectGroupId = groupId
      emit({ type: 'reposChanged' })
      return { ...repo }
    }
  } as unknown as OrcaRuntimeService

  const truthView = (): NormalizedView => ({
    repos: repos
      .map((r) => ({
        id: r.id,
        path: r.path,
        displayName: r.displayName,
        projectGroupId: r.projectGroupId ?? null
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    worktreesByRepo: Object.fromEntries(
      [...worktreesByRepo.entries()].map(([repoId, wts]) => [repoId, wts.map((wt) => wt.id).sort()])
    ),
    projectGroups: projectGroups
      .map((g) => ({ id: g.id, name: g.name }))
      .sort((a, b) => a.id.localeCompare(b.id))
  })

  return { runtimeId, service, truthView }
}
