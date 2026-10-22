/**
 * Test harness for multi-repo / multi-server workspace-session interactions.
 *
 * Orca persists the workspace session as one slice per execution host
 * (`workspaceSession` for `local`, `workspaceSessionsByHostId` for the rest — see
 * src/main/persistence.ts). The renderer splits a unified session into those
 * partitions on persist and merges them back on boot. A hard refresh
 * (Cmd/Ctrl+Shift+R) is exactly persist → reload → merge.
 *
 * This harness drives the *real* product functions across that boundary so tests
 * can assert what survives a refresh when the same project lives on two servers:
 *   - builders for repos / worktrees / tabs / sessions spanning local + ssh +
 *     runtime hosts,
 *   - {@link InMemoryHostSessionStore}, a faithful in-memory stand-in for the
 *     main-process per-host partition store (clones across the boundary so a
 *     write to one server can never alias another server's partition),
 *   - {@link simulateRefresh}, which runs persistWorkspaceSessionByHostSync then
 *     fetchWorkspaceSessionFromHosts through the store, with the repo set known
 *     at persist and at boot independently controllable to model load races.
 *
 * The seeded generators live in ./multi-host-session-generators so this file
 * stays focused on topology + the refresh round trip.
 */
import type {
  Repo,
  TerminalTab,
  Tab,
  WorkspaceSessionState,
  WorkspaceSessionPatch
} from '../../../shared/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/worktree-id'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  buildHostIdByWorktreeId,
  fetchWorkspaceSessionFromHosts,
  persistWorkspaceSessionByHostSync,
  type HostPersistenceState
} from './workspace-session-host-persistence'

/** A clone that survives the renderer↔main IPC boundary. structuredClone is
 *  available in the Node test environment; falling back keeps the harness usable
 *  if a future runtime lacks it. */
function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T)
}

// --- Topology builders ------------------------------------------------------

/** Minimal worktree shape the persistence seam consumes (it only reads id +
 *  repoId; path is kept so builders can derive the canonical worktree id). */
export type WorktreeRef = { id: string; repoId: string; path: string }

/** A single execution host plus the repos/worktrees it owns, enough to derive
 *  both the ownership map (for split) and the known-repo list (for fetch). */
export type HostNode = {
  hostId: ExecutionHostId
  repos: Repo[]
  worktrees: WorktreeRef[]
}

export type Topology = {
  hosts: HostNode[]
}

let counter = 0
/** Deterministic-per-process unique suffix; tests that need reproducibility pass
 *  explicit ids instead of relying on this. */
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

export function worktreeId(repoId: string, path: string): string {
  return `${repoId}${WORKTREE_ID_SEPARATOR}${path}`
}

/** Build a Repo stamped for a given host. `local` repos carry no connection;
 *  ssh/runtime repos carry the matching executionHostId so getRepoExecutionHostId
 *  resolves them the way the real store does. */
export function makeRepo(hostId: ExecutionHostId, overrides: Partial<Repo> = {}): Repo {
  const id = overrides.id ?? nextId('repo')
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#888888',
    addedAt: 1,
    connectionId: null,
    ...overrides,
    // Host stamp wins over overrides so a repo always resolves to its node's host.
    executionHostId: hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
  }
}

export function makeWorktree(
  repo: Repo,
  path: string,
  overrides: Partial<WorktreeRef> = {}
): WorktreeRef {
  return {
    id: overrides.id ?? worktreeId(repo.id, path),
    repoId: repo.id,
    path
  }
}

export function makeTerminalTab(id: string, ownerWorktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: ownerWorktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

export function makeUnifiedTab(id: string, ownerWorktreeId: string): Tab {
  return {
    id,
    entityId: id,
    groupId: `group-${ownerWorktreeId}`,
    worktreeId: ownerWorktreeId,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

export const runtimeHostId = (name: string): ExecutionHostId => toRuntimeExecutionHostId(name)
export const sshHostId = (name: string): ExecutionHostId => toSshExecutionHostId(name)

/** Aggregate a topology into the HostPersistenceState the persistence layer wants
 *  (repos + worktreesByRepo) plus the flat repo list used by fetch. */
export function toPersistenceState(topology: Topology): HostPersistenceState {
  const repos = topology.hosts.flatMap((h) => h.repos)
  const worktreesByRepo: Record<string, WorktreeRef[]> = {}
  for (const host of topology.hosts) {
    for (const wt of host.worktrees) {
      ;(worktreesByRepo[wt.repoId] ??= []).push(wt)
    }
  }
  return { repos, worktreesByRepo }
}

export function allRepos(topology: Topology): Repo[] {
  return topology.hosts.flatMap((h) => h.repos)
}

// --- In-memory per-host partition store -------------------------------------

export type SessionApiLike = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
  setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
}

/**
 * Stand-in for the main-process session store. Mirrors its contract:
 *   - one partition per ExecutionHostId, default `local`;
 *   - `get` of an unwritten partition yields a fresh default session (the real
 *     side zod-validates and falls back to defaults);
 *   - `patch` replaces the provided top-level fields (WorkspaceSessionPatch is a
 *     top-level Partial), leaving untouched fields intact;
 *   - every value is cloned in and out so the renderer can never hold a reference
 *     into stored state — this is what makes cross-server isolation testable.
 */
export class InMemoryHostSessionStore {
  private readonly partitions = new Map<ExecutionHostId, WorkspaceSessionState>()

  readonly api: SessionApiLike = {
    get: async (hostId = LOCAL_EXECUTION_HOST_ID) => this.read(hostId),
    patch: async (patch, hostId = LOCAL_EXECUTION_HOST_ID) => {
      const current = this.partitions.get(hostId) ?? getDefaultWorkspaceSession()
      this.partitions.set(hostId, clone({ ...current, ...patch }))
    },
    setSync: (state, hostId = LOCAL_EXECUTION_HOST_ID) => {
      this.partitions.set(hostId, clone(state))
    }
  }

  private read(hostId: ExecutionHostId): WorkspaceSessionState {
    const stored = this.partitions.get(hostId)
    return stored ? clone(stored) : getDefaultWorkspaceSession()
  }

  /** Read a partition exactly as persisted (no defaulting) — for assertions about
   *  what a single server's blob contains. Returns undefined if never written. */
  snapshot(hostId: ExecutionHostId): WorkspaceSessionState | undefined {
    const stored = this.partitions.get(hostId)
    return stored ? clone(stored) : undefined
  }

  hostIds(): ExecutionHostId[] {
    return [...this.partitions.keys()]
  }
}

// --- The refresh round trip -------------------------------------------------

export type RefreshOptions = {
  /** Repo set the renderer knows when it *writes* the session (beforeunload).
   *  Defaults to the persistState topology's repos. */
  persistTopology: Topology
  /** Repo set the renderer knows when it *reads back* on boot. Defaults to the
   *  same repos as persist; pass a reduced set to model a host whose repos have
   *  not finished loading at hydration time. */
  bootRepos?: Repo[]
  /** Reuse a store across multiple refreshes (e.g. to chain operations). */
  store?: InMemoryHostSessionStore
  /** Runs after persist, before boot reads the partitions back. Lets a test model
   *  a partition that is stale or corrupt at boot (e.g. a server that wrote a
   *  different active pointer) and assert merge precedence holds. */
  beforeBoot?: (store: InMemoryHostSessionStore) => void
}

export type RefreshResult = {
  /** The unified session the renderer would hydrate after reload. */
  merged: WorkspaceSessionState
  store: InMemoryHostSessionStore
}

/**
 * Run a full hard-refresh cycle through the real product code:
 *   1. persistWorkspaceSessionByHostSync — split `session` by owner host and write
 *      each partition (the beforeunload / quit path),
 *   2. fetchWorkspaceSessionFromHosts — read `local` + each known runtime host and
 *      merge back into one session (the boot path).
 *
 * The persist-time and boot-time repo sets are independent so a test can model a
 * host whose repos are known at persist but not yet at boot (a load race).
 */
export async function simulateRefresh(
  session: WorkspaceSessionState,
  options: RefreshOptions
): Promise<RefreshResult> {
  const store = options.store ?? new InMemoryHostSessionStore()
  const persistState = toPersistenceState(options.persistTopology)
  const bootRepos = options.bootRepos ?? persistState.repos

  persistWorkspaceSessionByHostSync(store.api, session, persistState)
  options.beforeBoot?.(store)
  const merged = await fetchWorkspaceSessionFromHosts(store.api, bootRepos)
  return { merged, store }
}

/** Persist a session into a fresh store and return each host partition exactly as
 *  written (no defaulting). Lets a test compare what each server's blob holds
 *  before and after an operation. */
export function persistSnapshots(
  session: WorkspaceSessionState,
  topology: Topology
): Map<ExecutionHostId, WorkspaceSessionState> {
  const store = new InMemoryHostSessionStore()
  persistWorkspaceSessionByHostSync(store.api, session, toPersistenceState(topology))
  const snapshots = new Map<ExecutionHostId, WorkspaceSessionState>()
  for (const hostId of store.hostIds()) {
    const snap = store.snapshot(hostId)
    if (snap) {
      snapshots.set(hostId, snap)
    }
  }
  return snapshots
}

/** Convenience: the owner map a split would use for a topology. Exposed so split
 *  can be exercised directly without the store round trip. */
export function ownerMapFor(topology: Topology): ReturnType<typeof buildHostIdByWorktreeId> {
  return buildHostIdByWorktreeId(toPersistenceState(topology))
}

/** `activeWorktreeIdsOnShutdown` is a set-by-meaning (worktrees that had a live
 *  PTY); the split regroups it by owner host, so its order is not preserved.
 *  Sort it before equality checks; every other field must round-trip exactly. */
export function canonicalizeSession(session: WorkspaceSessionState): WorkspaceSessionState {
  return {
    ...session,
    activeWorktreeIdsOnShutdown: [...(session.activeWorktreeIdsOnShutdown ?? [])].sort()
  }
}
