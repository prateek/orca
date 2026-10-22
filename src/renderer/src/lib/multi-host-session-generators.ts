/**
 * Seeded, deterministic generators for multi-host workspace-session property
 * tests. No fast-check dependency: a counterexample is reproduced by re-running
 * the same numeric seed, which the property runner prints on failure and which
 * regression cases pin explicitly.
 *
 * A generated case is a {@link Topology} (hosts → repos → worktrees) plus a
 * {@link WorkspaceSessionState} whose every worktree/tab/file/page entry points
 * at a worktree that really exists in that topology — so ownership resolves to a
 * known host and the split/merge seam is exercised across all field categories.
 */
import type { WorkspaceSessionState } from '../../../shared/types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree,
  runtimeHostId,
  sshHostId,
  type HostNode,
  type Topology,
  type WorktreeRef
} from './multi-host-session-test-harness'

/** mulberry32 — small, fast, fully deterministic PRNG. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number

function intInRange(rng: Rng, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1))
}

function chance(rng: Rng, probability: number): boolean {
  return rng() < probability
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[intInRange(rng, 0, items.length - 1)]
}

/** Random subset (each item kept with the given probability), order preserved. */
function subset<T>(rng: Rng, items: readonly T[], keepProbability: number): T[] {
  return items.filter(() => chance(rng, keepProbability))
}

export type GeneratedCase = {
  seed: number
  topology: Topology
  session: WorkspaceSessionState
  /** Flat list of every worktree id present in the topology. */
  worktreeIds: string[]
}

/**
 * Build a random multi-host topology: always a `local` host, plus 0-2 runtime
 * hosts and an optional ssh host (ssh worktrees deliberately ride in the local
 * partition, mirroring production). Each host gets 1-2 repos, each repo 1-3
 * worktrees. Runtime hosts are what actually create separate partitions, so at
 * least one is forced when `requireRemote` is set.
 */
export function generateTopology(rng: Rng, requireRemote = true): Topology {
  // Per-case counters keep ids deterministic for a given seed (the harness's
  // global id counter would make the same seed produce different ids each call).
  let pathCounter = 0
  let repoCounter = 0
  const newPath = (): string => `/w/${(pathCounter += 1)}`

  function buildHost(hostId: ExecutionHostId, repoCount: number): HostNode {
    const repos = Array.from({ length: repoCount }, () =>
      makeRepo(hostId, { id: `r-${(repoCounter += 1)}` })
    )
    const worktrees: WorktreeRef[] = []
    for (const repo of repos) {
      const wtCount = intInRange(rng, 1, 3)
      for (let i = 0; i < wtCount; i += 1) {
        worktrees.push(makeWorktree(repo, newPath()))
      }
    }
    return { hostId, repos, worktrees }
  }

  const hosts: HostNode[] = [buildHost(LOCAL_EXECUTION_HOST_ID, intInRange(rng, 1, 2))]

  const runtimeCount = requireRemote ? intInRange(rng, 1, 2) : intInRange(rng, 0, 2)
  for (let i = 0; i < runtimeCount; i += 1) {
    hosts.push(
      buildHost(runtimeHostId(`env-${i}-${intInRange(rng, 0, 9999)}`), intInRange(rng, 1, 2))
    )
  }
  if (chance(rng, 0.5)) {
    hosts.push(buildHost(sshHostId(`box-${intInRange(rng, 0, 9999)}`), 1))
  }

  return { hosts }
}

/** Populate a session across the topology. Every keyed entry references a real
 *  worktree so ownership resolves to a known host. Covers every FieldOwnership
 *  category so the split/merge seam is fully exercised. */
export function generateSession(rng: Rng, topology: Topology): WorkspaceSessionState {
  const worktrees = topology.hosts.flatMap((h) => h.worktrees)
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()

  const tabIdByWorktree = new Map<string, string>()

  // worktreeKeyed: terminal tabs + unified tabs for a subset of worktrees.
  for (const wt of subset(rng, worktrees, 0.7)) {
    const tabId = `term-${wt.id}`
    tabIdByWorktree.set(wt.id, tabId)
    session.tabsByWorktree[wt.id] = [makeTerminalTab(tabId, wt.id)]
    if (chance(rng, 0.5)) {
      session.unifiedTabs ??= {}
      session.unifiedTabs[wt.id] = [makeUnifiedTab(`uni-${wt.id}`, wt.id)]
    }
    if (chance(rng, 0.6)) {
      session.lastVisitedAtByWorktreeId ??= {}
      session.lastVisitedAtByWorktreeId[wt.id] = intInRange(rng, 1, 1_000_000)
    }
    if (chance(rng, 0.5)) {
      session.defaultTerminalTabsAppliedByWorktreeId ??= {}
      session.defaultTerminalTabsAppliedByWorktreeId[wt.id] = true
    }
    if (chance(rng, 0.5)) {
      session.activeTabIdByWorktree ??= {}
      session.activeTabIdByWorktree[wt.id] = tabId
    }
  }

  // tabKeyed: layouts + remote session ids follow their tab's worktree.
  for (const [worktreeId, tabId] of tabIdByWorktree) {
    void worktreeId
    if (chance(rng, 0.6)) {
      session.terminalLayoutsByTabId[tabId] = {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    }
    if (chance(rng, 0.4)) {
      session.remoteSessionIdsByTabId ??= {}
      session.remoteSessionIdsByTabId[tabId] = `sess-${tabId}`
    }
  }

  // fileKeyed: open files + markdown frontmatter visibility keyed by file path.
  for (const wt of subset(rng, worktrees, 0.4)) {
    const filePath = `${wt.path}/notes.md`
    session.openFilesByWorktree ??= {}
    session.openFilesByWorktree[wt.id] = [
      { filePath, relativePath: 'notes.md', worktreeId: wt.id, language: 'markdown' }
    ]
    if (chance(rng, 0.7)) {
      session.markdownFrontmatterVisible ??= {}
      session.markdownFrontmatterVisible[filePath] = true
    }
  }

  // browserWorkspaceKeyed: pages grouped under a workspace, all sharing a worktree.
  for (const wt of subset(rng, worktrees, 0.3)) {
    const workspaceId = `ws-${wt.id}`
    session.browserPagesByWorkspace ??= {}
    session.browserPagesByWorkspace[workspaceId] = [
      {
        id: `page-${wt.id}`,
        workspaceId,
        worktreeId: wt.id,
        url: 'https://example.com',
        title: 'Example',
        loading: false,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: 1
      }
    ]
  }

  // sleepingAgentKeyed: resume records carrying their own worktreeId.
  for (const wt of subset(rng, worktrees, 0.25)) {
    session.sleepingAgentSessionsByPaneKey ??= {}
    session.sleepingAgentSessionsByPaneKey[`pane-${wt.id}`] = {
      paneKey: `pane-${wt.id}`,
      worktreeId: wt.id,
      agent: 'claude',
      providerSession: { key: 'session_id', id: `s-${wt.id}` },
      prompt: 'resume me',
      state: 'done',
      capturedAt: 1,
      updatedAt: 2
    }
  }

  // worktreeArray: which worktrees had a live PTY at shutdown.
  session.activeWorktreeIdsOnShutdown = subset(rng, worktrees, 0.5).map((wt) => wt.id)

  // global fields.
  session.browserUrlHistory = chance(rng, 0.5)
    ? [{ url: 'u', normalizedUrl: 'u', title: 't', lastVisitedAt: 1, visitCount: 1 }]
    : []
  if (chance(rng, 0.4)) {
    session.activeConnectionIdsAtShutdown = ['ssh-target-x']
  }

  // active pointers: pick a real worktree (or leave null).
  if (worktrees.length > 0 && chance(rng, 0.85)) {
    const active = pick(rng, worktrees)
    session.activeWorktreeId = active.id
    session.activeRepoId = active.repoId
    session.activeTabId = tabIdByWorktree.get(active.id) ?? null
  }

  return session
}

export function generateCase(seed: number, requireRemote = true): GeneratedCase {
  const rng = makeRng(seed)
  const topology = generateTopology(rng, requireRemote)
  const session = generateSession(rng, topology)
  return {
    seed,
    topology,
    session,
    worktreeIds: topology.hosts.flatMap((h) => h.worktrees.map((wt) => wt.id))
  }
}
