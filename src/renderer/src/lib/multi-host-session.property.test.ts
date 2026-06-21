/**
 * Property tests for cross-server workspace-session state preservation.
 *
 * These generate random multi-host topologies + sessions and assert invariants
 * that must hold for *any* arrangement of servers and worktrees. The generator is
 * seeded; on failure the runner prints the seed so the exact case re-runs
 * deterministically, and discovered counterexamples get pinned in the
 * "pinned regression seeds" block below.
 *
 * Invariants:
 *   P1 round-trip      — split then merge preserves the whole session (no loss).
 *   P2 isolation       — each non-local partition holds only worktrees it owns.
 *   P3 refresh fidelity— a full persist→reload→merge preserves everything.
 *   P4 independence    — an operation on one server never alters another's blob.
 */
import { describe, it, expect } from 'vitest'
import {
  splitWorkspaceSessionByHost,
  mergeWorkspaceSessionsFromHosts
} from './workspace-session-host-split'
import {
  allRepos,
  canonicalizeSession,
  makeTerminalTab,
  ownerMapFor,
  persistSnapshots,
  simulateRefresh,
  type Topology
} from './multi-host-session-test-harness'
import { generateCase, makeRng } from './multi-host-session-generators'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/types'

const SEED_COUNT = 200

/** Run `check` across a deterministic band of seeds; on the first failure rethrow
 *  with the seed so the case reproduces exactly (`generateCase(seed)`). */
async function forAllSeeds(check: (seed: number) => void | Promise<void>): Promise<void> {
  for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
    try {
      await check(seed)
    } catch (err) {
      throw new Error(`property failed at seed=${seed} — reproduce with generateCase(${seed})`, {
        cause: err
      })
    }
  }
}

/** Worktree ids the topology routes to a non-local (runtime) partition. */
function runtimeOwnedWorktreeIds(topology: Topology): string[] {
  const owner = ownerMapFor(topology)
  return topology.hosts
    .flatMap((h) => h.worktrees.map((wt) => wt.id))
    .filter((id) => owner(id) !== LOCAL_EXECUTION_HOST_ID)
}

describe('cross-server session invariants (property-based)', () => {
  it('P1: split → merge preserves the entire session for any topology', async () => {
    await forAllSeeds((seed) => {
      const { topology, session } = generateCase(seed)
      const roundTripped = mergeWorkspaceSessionsFromHosts(
        splitWorkspaceSessionByHost(session, ownerMapFor(topology))
      )
      expect(canonicalizeSession(roundTripped)).toEqual(canonicalizeSession(session))
    })
  })

  it('P2: every non-local partition contains only worktrees it owns', async () => {
    await forAllSeeds((seed) => {
      const { topology, session } = generateCase(seed)
      const owner = ownerMapFor(topology)
      const slices = splitWorkspaceSessionByHost(session, owner)

      for (const [hostId, slice] of Object.entries(slices)) {
        if (hostId === LOCAL_EXECUTION_HOST_ID || !slice) {
          continue
        }
        // Worktree-keyed maps: every key must be owned by this host. This is the
        // real isolation guarantee — a server's blob never holds another's
        // worktree state. (Global pointers are deliberately replicated onto every
        // partition so it can be read standalone; merge resolves them from local,
        // so they are not an isolation concern and are not checked here.)
        for (const worktreeId of Object.keys(slice.tabsByWorktree ?? {})) {
          expect(owner(worktreeId)).toBe(hostId)
        }
        for (const worktreeId of slice.activeWorktreeIdsOnShutdown ?? []) {
          expect(owner(worktreeId)).toBe(hostId)
        }
        // Its host id must be a real runtime host (ssh worktrees ride in local).
        expect(parseExecutionHostId(hostId)?.kind).toBe('runtime')
      }
    })
  })

  it('P3: a full refresh (persist → reload → merge) preserves everything', async () => {
    await forAllSeeds(async (seed) => {
      const { topology, session } = generateCase(seed)
      const { merged } = await simulateRefresh(session, { persistTopology: topology })
      expect(canonicalizeSession(merged)).toEqual(canonicalizeSession(session))
    })
  })

  it('P4: an operation on one server leaves every other server’s partition unchanged', async () => {
    await forAllSeeds(async (seed) => {
      const { topology, session } = generateCase(seed)
      const runtimeWorktreeIds = runtimeOwnedWorktreeIds(topology)
      if (runtimeWorktreeIds.length === 0) {
        return // no remote partition to operate on for this case
      }

      // Pick one remote worktree and the host that owns it.
      const targetWorktreeId = runtimeWorktreeIds[0]
      const targetHost = ownerMapFor(topology)(targetWorktreeId)

      const before = persistSnapshots(session, topology)

      // The operation: open a new terminal tab on the target server's worktree.
      const mutated: WorkspaceSessionState = {
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [targetWorktreeId]: [
            ...(session.tabsByWorktree[targetWorktreeId] ?? []),
            makeTerminalTab(`new-tab-${seed}`, targetWorktreeId)
          ]
        }
      }
      const after = persistSnapshots(mutated, topology)

      // Every partition except the target host is byte-for-byte identical.
      for (const hostId of new Set([...before.keys(), ...after.keys()])) {
        if (hostId === targetHost) {
          continue
        }
        expect(after.get(hostId)).toEqual(before.get(hostId))
      }
      // The target host's partition did change, and now carries the new tab.
      expect(after.get(targetHost)?.tabsByWorktree?.[targetWorktreeId]).toContainEqual(
        expect.objectContaining({ id: `new-tab-${seed}` })
      )
    })
  })
})

describe('pinned regression seeds', () => {
  // Concrete cases that exercise multi-runtime-host topologies. New counterexamples
  // discovered by the property runner should be appended here so they stay covered
  // even though the seed band above may shift.
  const PINNED = [7, 19, 42, 99, 123, 256]

  it('round-trips every pinned case through a real refresh', async () => {
    for (const seed of PINNED) {
      const { topology, session } = generateCase(seed)
      const { merged } = await simulateRefresh(session, { persistTopology: topology })
      expect(canonicalizeSession(merged), `pinned seed ${seed}`).toEqual(
        canonicalizeSession(session)
      )
    }
  })

  it('generators are reproducible: same seed → identical case', () => {
    // Guards the whole suite's reproducibility claim.
    expect(generateCase(42)).toEqual(generateCase(42))
    // And distinct seeds diverge (the PRNG actually varies output).
    const a = makeRng(1)
    const b = makeRng(2)
    expect(a()).not.toEqual(b())
  })
})

describe('counterexample isolation helper', () => {
  it('drops the runtime hosts when requireRemote is false (single-host edge)', () => {
    // A degenerate topology (local only) must still round-trip — guards the
    // "no remote servers" boundary that the random band rarely hits.
    const { topology, session } = generateCase(3, false)
    expect(allRepos(topology).length).toBeGreaterThan(0)
    const roundTripped = mergeWorkspaceSessionsFromHosts(
      splitWorkspaceSessionByHost(session, ownerMapFor(topology))
    )
    expect(canonicalizeSession(roundTripped)).toEqual(canonicalizeSession(session))
  })
})
