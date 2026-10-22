/**
 * Writable in-memory store for the real OrcaRuntimeService.
 *
 * Per testing-philosophy: the persistence store is a legitimate seam to
 * substitute (an in-memory store is the canonical "good fake"). The runtime
 * itself stays real — its mutation + event-emission logic is what the Remote
 * Orca Server consistency tests exercise, with real git worktrees on disk.
 */
import type { GlobalSettings, ProjectGroup, Repo, WorktreeMeta } from '../../shared/types'

export type InMemoryRuntimeStore = {
  /** Repos currently registered on the server. */
  repos: Repo[]
  /** Project groups currently registered on the server. */
  projectGroups: ProjectGroup[]
  /** The store object passed to `new OrcaRuntimeService(store)`. */
  store: unknown
}

/** Build an in-memory store backing the real runtime. `workspaceDir` is where the
 *  runtime will create real git worktrees, so it must be a realpath'd temp dir. */
export function createInMemoryRuntimeStore(workspaceDir: string): InMemoryRuntimeStore {
  const repos: Repo[] = []
  const projectGroups: ProjectGroup[] = []
  const worktreeMeta: Record<string, WorktreeMeta> = {}
  let groupCounter = 0

  const settings: Partial<GlobalSettings> = {
    workspaceDir,
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  }

  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => {
      repos.push(repo)
    },
    updateRepo: (id: string, updates: Partial<Repo>): Repo | null => {
      const repo = repos.find((entry) => entry.id === id)
      if (!repo) {
        return null
      }
      Object.assign(repo, updates)
      return repo
    },
    removeProject: (id: string) => {
      const index = repos.findIndex((repo) => repo.id === id)
      if (index >= 0) {
        repos.splice(index, 1)
      }
    },
    reorderRepos: (orderedIds: string[]): boolean => {
      const byId = new Map(repos.map((repo) => [repo.id, repo]))
      const reordered = orderedIds.map((id) => byId.get(id)).filter((repo): repo is Repo => !!repo)
      if (reordered.length !== repos.length) {
        return false
      }
      repos.splice(0, repos.length, ...reordered)
      return true
    },

    getProjects: () => [],
    getFolderWorkspaces: () => [],

    getProjectGroups: () => projectGroups,
    createProjectGroup: (input: {
      name: string
      parentPath?: string | null
      connectionId?: string | null
      parentGroupId?: string | null
      createdFrom: ProjectGroup['createdFrom']
    }): ProjectGroup => {
      groupCounter += 1
      const group: ProjectGroup = {
        id: `group-${groupCounter}`,
        name: input.name,
        parentPath: input.parentPath ?? null,
        connectionId: input.connectionId ?? null,
        parentGroupId: input.parentGroupId ?? null,
        createdFrom: input.createdFrom,
        tabOrder: projectGroups.length,
        isCollapsed: false,
        color: null,
        createdAt: groupCounter,
        updatedAt: groupCounter
      }
      projectGroups.push(group)
      return group
    },
    updateProjectGroup: (
      groupId: string,
      updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
    ): ProjectGroup | null => {
      const group = projectGroups.find((entry) => entry.id === groupId)
      if (!group) {
        return null
      }
      Object.assign(group, updates)
      return group
    },
    deleteProjectGroup: (groupId: string): boolean => {
      const index = projectGroups.findIndex((entry) => entry.id === groupId)
      if (index < 0) {
        return false
      }
      projectGroups.splice(index, 1)
      for (const repo of repos) {
        if (repo.projectGroupId === groupId) {
          repo.projectGroupId = null
        }
      }
      return true
    },
    moveProjectToGroup: (repoId: string, groupId: string | null): Repo | null => {
      const repo = repos.find((entry) => entry.id === repoId)
      if (!repo) {
        return null
      }
      repo.projectGroupId = groupId
      return repo
    },

    getAllWorktreeMeta: () => worktreeMeta,
    getWorktreeMeta: (id: string) => worktreeMeta[id],
    setWorktreeMeta: (id: string, meta: Partial<WorktreeMeta>): WorktreeMeta => {
      worktreeMeta[id] = { ...(worktreeMeta[id] as WorktreeMeta), ...meta } as WorktreeMeta
      return worktreeMeta[id]
    },
    removeWorktreeMeta: (id: string) => {
      delete worktreeMeta[id]
    },

    getSettings: () => settings as GlobalSettings
  }

  return { repos, projectGroups, store }
}
