# Multi-server / multi-repo testing worksheet

Goal: give Orca a test capability for multi-repo / multi-server interactions, prove
we exercise the "same project on two servers, then refresh" condition, and add
property tests showing cross-server operations preserve state.

## The reported condition

Add project A on the local machine. Add a remote host B. Add project A on B too,
while B already has its own unrelated work. Hard-refresh (Cmd/Ctrl+Shift+R).
"Weird things" happen — state looks lost or confused.

## Where this actually lives (architecture)

Hard refresh = `app.forceReload` → `webContents.reloadIgnoringCache()`
(`src/main/window/createMainWindow.ts`, binding in `src/shared/keybindings.ts`).
The renderer loses all in-memory state and rehydrates from the main process on boot.

Workspace session state is **partitioned per execution host** and stitched back
together by pure functions — this is the seam that governs cross-server state:

- `src/renderer/src/lib/workspace-session-host-split.ts`
  - `splitWorkspaceSessionByHost(state, hostIdByWorktreeId)` — route each
    worktree-scoped slice to its owner host; global fields stay on `local`.
  - `mergeWorkspaceSessionsFromHosts(slices)` — inverse; globals come from `local`,
    worktree maps are unioned.
- `src/renderer/src/lib/workspace-session-host-persistence.ts`
  - `buildHostIdByWorktreeId(state)` — owner map derived from the loaded repos.
  - `persistWorkspaceSessionByHostSync` / `patchWorkspaceSessionByHost` — the
    persist (quit / beforeunload / debounced) paths.
  - `fetchWorkspaceSessionFromHosts(api, repos)` — the boot path: read the `local`
    partition plus one partition per **known runtime host**, then merge.

Identity model (from `src/shared/types.ts`, `src/shared/execution-host.ts`):
`ExecutionHostId = 'local' | 'ssh:<id>' | 'runtime:<id>'`. A `Repo` carries its
host via `connectionId` / `executionHostId`. A `Worktree` id is `<repoId>::<path>`
— repo ids are unique per host, so the same path on two servers yields distinct
worktree ids (no id collision). Global active pointers (`activeRepoId`,
`activeWorktreeId`, `activeTabId`, `activeWorkspaceKey`) live **only** in the
`local` partition.

## Bug hypothesis (what "weird things" most likely is)

Both persist and fetch depend on the renderer's loaded repo set:
- persist uses `buildHostIdByWorktreeId(state)` (repo-derived ownership),
- fetch uses `listKnownRuntimeHostIds(repos)` to decide which partitions to read.

So the round trip is only faithful when the owning host's repos are **known and
consistent** at both persist and fetch time. The fragile cases:

1. **Owner unknown at fetch** — a runtime host whose repos haven't loaded yet is
   not in `listKnownRuntimeHostIds`, so its partition is never read. Its worktree
   state is dropped from the merged session; active pointers into it then fail
   validation and reset. → lost place / "weird things".
2. **Owner unknown at persist** — if the owner map is incomplete when splitting,
   a non-local worktree's state is mis-routed into the `local` blob; a later
   refresh with full knowledge reads it from the wrong partition.

Net invariant we want to lock: **when both servers' repos are known, a refresh
preserves every worktree-scoped slice and the active selection, and operations on
one server never clobber the other server's partition.**

## Test plan

No property-test library exists in the repo. To keep CI deterministic and avoid
lockfile churn, the harness ships a small **seeded** generator (reproducible via a
printed seed) instead of adding fast-check.

1. **Harness** — `src/renderer/src/lib/multi-host-session-test-harness.ts`
   - builders for repos (local / ssh / runtime), worktrees, tabs, sessions;
   - an in-memory per-host session store fake implementing the real `SessionApi`
     partition contract;
   - `simulateRefresh({ knownRepos })` = `persistWorkspaceSessionByHostSync` →
     `fetchWorkspaceSessionFromHosts`, so we drive the actual product code;
   - a seeded `WorkspaceSessionState` + topology generator.

2. **Condition test** — `multi-host-session-refresh.test.ts`
   - Prateek's scenario end to end; refresh preserves both hosts' state and the
     active selection. Includes the runtime-host partition case and an explicit
     demonstration of failure mode #1 (unknown owner at fetch) as a regression
     guard.

3. **Property tests** — `multi-host-session.property.test.ts`
   - P1 round-trip: `merge(split(s)) deepEquals s` for arbitrary multi-host states.
   - P2 isolation: each non-local slice contains only worktrees it owns.
   - P3 refresh fidelity: with all repos known, refresh preserves every
     worktree-scoped entry and active pointers.
   - P4 operation independence: mutating server B's session + refresh leaves
     server A's persisted partition byte-for-byte unchanged.

## Progress log

## Files

- `src/renderer/src/lib/multi-host-session-test-harness.ts` — topology builders,
  in-memory per-host partition store, `simulateRefresh`, `persistSnapshots`.
- `src/renderer/src/lib/multi-host-session-generators.ts` — seeded PRNG + case
  generator covering every FieldOwnership category.
- `src/renderer/src/lib/multi-host-session-refresh.test.ts` — the reported
  condition + failure mode.
- `src/renderer/src/lib/multi-host-session.property.test.ts` — P1–P4 invariants.

## Progress log

- [x] Architecture mapped (3 explore subagents): host model, refresh path, harness.
- [x] Worksheet written.
- [x] Harness built.
- [x] Condition test written.
- [x] Property tests written.
- [x] Checks green (27 tests, typecheck, lint, format); fault-injection confirms the suite bites.
- [x] PR opened: prateek/orca#3.

## Product follow-up (not changed here)

`fetchWorkspaceSessionFromHosts` reads only the partitions of runtime hosts known
at boot (`listKnownRuntimeHostIds`). A host whose repos load after session
hydration is never read, so its tabs/worktree state vanish from the merged
session and active pointers into it reset — the "weird things on refresh". The
`FAILURE MODE` test pins this. A fix would gate session hydration on the full
repo set, or re-merge when late repos arrive. Flagged, not changed, since this is
a test-only PR.
