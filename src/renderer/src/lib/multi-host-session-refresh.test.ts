/**
 * The reported condition, as an executable test.
 *
 * Scenario: project "A" is added on the local machine and *also* on a remote
 * host B, where B already has its own unrelated work. A hard refresh
 * (Cmd/Ctrl+Shift+R) reloads the renderer, which persists the session into
 * per-host partitions and merges them back on boot. These tests drive that real
 * persist → reload → merge path through {@link simulateRefresh} and assert that
 * no server's state is lost and the active selection survives — and pin the
 * failure mode (a remote whose repos aren't known at boot) so a regression is
 * obvious.
 */
import { describe, it, expect } from 'vitest'
import {
  allRepos,
  canonicalizeSession as canonicalize,
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree,
  runtimeHostId,
  simulateRefresh,
  sshHostId,
  type HostNode,
  type Topology
} from './multi-host-session-test-harness'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/types'

describe('refresh with the same project on two servers', () => {
  // Local machine: project A + a second unrelated local project.
  const localRepoA = makeRepo(LOCAL_EXECUTION_HOST_ID, {
    id: 'local-A',
    displayName: 'project-A',
    path: '/home/me/project-A'
  })
  const localWtA = makeWorktree(localRepoA, '/home/me/project-A')

  // Remote host B: the *same* project A (distinct repo id, same path) plus B's
  // own separate work. This is "B has its own version of other work going on".
  const HOST_B = runtimeHostId('host-B')
  const remoteRepoA = makeRepo(HOST_B, {
    id: 'remote-A',
    displayName: 'project-A',
    path: '/home/me/project-A'
  })
  const remoteWtA = makeWorktree(remoteRepoA, '/home/me/project-A')
  const remoteRepoOther = makeRepo(HOST_B, {
    id: 'remote-other',
    displayName: 'project-B-only',
    path: '/srv/other'
  })
  const remoteWtOther = makeWorktree(remoteRepoOther, '/srv/other')

  const topology: Topology = {
    hosts: [
      { hostId: LOCAL_EXECUTION_HOST_ID, repos: [localRepoA], worktrees: [localWtA] },
      {
        hostId: HOST_B,
        repos: [remoteRepoA, remoteRepoOther],
        worktrees: [remoteWtA, remoteWtOther]
      } satisfies HostNode
    ]
  }

  /** A session where the user has tabs open on local A, remote A, and remote's
   *  own project, and is currently focused on the remote copy of project A. */
  function sessionFocusedOnRemoteA(): WorkspaceSessionState {
    return {
      ...getDefaultWorkspaceSession(),
      activeRepoId: remoteRepoA.id,
      activeWorktreeId: remoteWtA.id,
      activeTabId: 'tab-remote-A',
      tabsByWorktree: {
        [localWtA.id]: [makeTerminalTab('tab-local-A', localWtA.id)],
        [remoteWtA.id]: [makeTerminalTab('tab-remote-A', remoteWtA.id)],
        [remoteWtOther.id]: [makeTerminalTab('tab-remote-other', remoteWtOther.id)]
      },
      unifiedTabs: {
        [remoteWtOther.id]: [makeUnifiedTab('tab-remote-other', remoteWtOther.id)]
      },
      terminalLayoutsByTabId: {
        'tab-local-A': {
          root: { type: 'leaf', leafId: 'l' },
          activeLeafId: 'l',
          expandedLeafId: null
        },
        'tab-remote-A': {
          root: { type: 'leaf', leafId: 'l' },
          activeLeafId: 'l',
          expandedLeafId: null
        }
      },
      remoteSessionIdsByTabId: {
        'tab-remote-A': 'relay-sess-1',
        'tab-remote-other': 'relay-sess-2'
      },
      lastVisitedAtByWorktreeId: { [localWtA.id]: 10, [remoteWtA.id]: 20, [remoteWtOther.id]: 30 },
      activeWorktreeIdsOnShutdown: [localWtA.id, remoteWtA.id, remoteWtOther.id]
    }
  }

  it('preserves every server’s state and the active selection across a refresh', async () => {
    const session = sessionFocusedOnRemoteA()

    const { merged } = await simulateRefresh(session, { persistTopology: topology })

    // Nothing lost: the post-refresh unified session equals what we had.
    expect(canonicalize(merged)).toEqual(canonicalize(session))
    // The user stays on the remote copy of project A, not bounced to local.
    expect(merged.activeWorktreeId).toBe(remoteWtA.id)
    expect(merged.activeRepoId).toBe(remoteRepoA.id)
    expect(merged.activeTabId).toBe('tab-remote-A')
  })

  it('keeps each server’s state in its own partition (no cross-server bleed)', async () => {
    const session = sessionFocusedOnRemoteA()

    const { store } = await simulateRefresh(session, { persistTopology: topology })

    const localBlob = store.snapshot(LOCAL_EXECUTION_HOST_ID)
    const remoteBlob = store.snapshot(HOST_B)

    // Local partition owns only the local worktree's tabs.
    expect(Object.keys(localBlob?.tabsByWorktree ?? {})).toEqual([localWtA.id])
    // Remote partition owns only host B's worktrees — never the local one.
    expect(new Set(Object.keys(remoteBlob?.tabsByWorktree ?? {}))).toEqual(
      new Set([remoteWtA.id, remoteWtOther.id])
    )
    expect(remoteBlob?.tabsByWorktree).not.toHaveProperty(localWtA.id)
    // The remote relay session ids live with the remote partition, not local.
    expect(remoteBlob?.remoteSessionIdsByTabId).toEqual({
      'tab-remote-A': 'relay-sess-1',
      'tab-remote-other': 'relay-sess-2'
    })
    expect(localBlob?.remoteSessionIdsByTabId ?? {}).toEqual({})
  })

  it('resolves the active selection from local even when a server’s partition is stale', async () => {
    const session = sessionFocusedOnRemoteA()

    // Each partition replicates the global pointers so it can be loaded
    // standalone; on a multi-server boot, the local partition must win. Tamper
    // host B's partition to claim a *different* active worktree, then boot.
    const { merged, store } = await simulateRefresh(session, {
      persistTopology: topology,
      beforeBoot: (s) => {
        const remote = s.snapshot(HOST_B)
        if (remote) {
          s.api.setSync({ ...remote, activeWorktreeId: remoteWtOther.id }, HOST_B)
        }
      }
    })

    // Local's active selection wins; the stale remote pointer is ignored.
    expect(merged.activeWorktreeId).toBe(remoteWtA.id)
    // The local partition did carry the authoritative pointer.
    expect(store.snapshot(LOCAL_EXECUTION_HOST_ID)?.activeWorktreeId).toBe(remoteWtA.id)
  })

  it('FAILURE MODE: a remote whose repos are unknown at boot loses its state', async () => {
    const session = sessionFocusedOnRemoteA()

    // Model the load race: host B's repos haven't loaded when the renderer reads
    // the session back, so fetch never asks for B's partition.
    const localOnlyRepos = allRepos(topology).filter((r) => r.executionHostId == null)
    const { merged } = await simulateRefresh(session, {
      persistTopology: topology,
      bootRepos: localOnlyRepos
    })

    // The local copy of project A survives...
    expect(merged.tabsByWorktree).toHaveProperty(localWtA.id)
    // ...but host B's tabs are gone from the hydrated session.
    expect(merged.tabsByWorktree).not.toHaveProperty(remoteWtA.id)
    expect(merged.tabsByWorktree).not.toHaveProperty(remoteWtOther.id)
    // The active pointer now dangles — it names a worktree with no restored tabs,
    // which is exactly the "weird things on refresh" the user observed (real
    // hydration then resets it). Persisted data is intact; only this boot lost it.
    expect(merged.activeWorktreeId).toBe(remoteWtA.id)
    expect(merged.tabsByWorktree[merged.activeWorktreeId ?? '']).toBeUndefined()
  })
})

describe('refresh with an SSH remote (rides in the local partition)', () => {
  // "make this a host or whatever" — Orca's other remote kind is SSH, whose
  // worktrees are intentionally persisted in the local blob. The same-project
  // round trip must still be lossless.
  const HOST_SSH = sshHostId('ssh-box')
  const localRepo = makeRepo(LOCAL_EXECUTION_HOST_ID, { id: 'l', path: '/p/A' })
  const localWt = makeWorktree(localRepo, '/p/A')
  const sshRepo = makeRepo(HOST_SSH, { id: 's', path: '/p/A' })
  const sshWt = makeWorktree(sshRepo, '/p/A')

  const topology: Topology = {
    hosts: [
      { hostId: LOCAL_EXECUTION_HOST_ID, repos: [localRepo], worktrees: [localWt] },
      { hostId: HOST_SSH, repos: [sshRepo], worktrees: [sshWt] }
    ]
  }

  it('preserves both the local and ssh copies of the same project', async () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: sshRepo.id,
      activeWorktreeId: sshWt.id,
      activeTabId: 'tab-ssh',
      tabsByWorktree: {
        [localWt.id]: [makeTerminalTab('tab-local', localWt.id)],
        [sshWt.id]: [makeTerminalTab('tab-ssh', sshWt.id)]
      }
    }

    const { merged, store } = await simulateRefresh(session, { persistTopology: topology })

    expect(canonicalize(merged)).toEqual(canonicalize(session))
    expect(merged.activeWorktreeId).toBe(sshWt.id)
    // SSH worktrees ride in local: no separate ssh partition is written.
    expect(store.snapshot(HOST_SSH)).toBeUndefined()
    expect(Object.keys(store.snapshot(LOCAL_EXECUTION_HOST_ID)?.tabsByWorktree ?? {})).toEqual([
      localWt.id,
      sshWt.id
    ])
  })
})
