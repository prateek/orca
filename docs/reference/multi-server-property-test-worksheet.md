# Multi-Server Repo Refresh Test Worksheet

## Scenario

Orca can show the same project from more than one execution host: local, SSH, and
runtime server. A user may add `orca` locally, connect to a server that has its
own `orca` checkout, switch focus between the hosts, then reload the app with
`Cmd+Shift+R`.

The test harness needs to catch state crossing those host boundaries. Refreshing
server B must not remove, overwrite, or re-own the local checkout for project A.

## Invariants

- Repo identity is scoped by execution host plus repo id.
- A shared provider project can merge multiple host checkouts into one
  `Project`, but each checkout keeps its own `ProjectHostSetup`.
- Runtime-fetched repos are stamped with `executionHostId: runtime:<env>`.
- Local repos are stamped with `executionHostId: local`.
- Refreshing one host replaces only that host's fetched repos.
- Generated add, remove, rename, reorder, and refresh sequences preserve every
  host partition.
- Project source repo ids remain the union of the surviving host checkouts.

## Current Coverage

- `src/renderer/src/store/slices/repo-host-refresh-merge.test.ts`
  checks host-scoped repo merge behavior directly.
- `src/renderer/src/store/slices/project-host-setup-compatibility-merge.test.ts`
  checks shared project compatibility after one host refreshes.
- `src/renderer/src/store/slices/multi-host-repo-refresh.property.test.ts`
  runs seeded operation sequences across local and two runtime hosts.
- `src/renderer/src/store/slices/repos-multi-host-refresh.test.ts`
  drives the renderer store through local IPC and runtime RPC refreshes.
- `tests/e2e/ssh-docker-multi-host-repos.property.spec.ts` is the opt-in real
  host smoke. It starts two Docker-backed SSH hosts, seeds multiple Git repos,
  adds a matching local checkout, runs a replayable generated sequence of add,
  remove, rename, reorder, refresh, and renderer reload operations, and asserts
  that repo partitions, shared project `sourceRepoIds`, and
  `ProjectHostSetup` ownership stay aligned.

Run the Docker layer with:

```bash
pnpm run test:e2e:ssh-docker-prop
```

Use `ORCA_E2E_MULTI_HOST_PROP_SEEDS` and `ORCA_E2E_MULTI_HOST_PROP_STEPS` to
expand the slow suite locally or in a scheduled job.

## Current Limits

- The Docker property spec covers real local and SSH hosts. Runtime-server
  refresh behavior is still covered by the fast renderer tests rather than a
  Docker runtime-server process.

## Next Seams

- Worktree refresh: `src/renderer/src/store/slices/worktrees.ts`.
- Reload event routing: `src/renderer/src/hooks/useIpcEvents.ts`.
- Session partitioning: `src/renderer/src/lib/workspace-session-host-split.ts`
  and `src/renderer/src/lib/workspace-session-host-persistence.ts`.
- Main persistence: `src/main/persistence.ts` host-keyed workspace sessions.
