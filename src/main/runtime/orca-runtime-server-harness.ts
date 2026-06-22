/**
 * Start a real OrcaRuntimeRpcServer (Remote Orca Server) over an ephemeral E2EE
 * WebSocket for the *real* OrcaRuntimeService, and drive paired clients against it.
 *
 * Everything here is real: the runtime (its mutation + event-emission logic), the
 * RPC server, the E2EE transport, the client request connections, the event
 * subscription stream, and git worktree creation on disk. Only the persistence
 * store is substituted (in-memory-runtime-store.ts) and electron is mocked in the
 * test file. `readClientView` re-queries a client's full repos/worktrees/projects
 * through the real RPC; `serverTruthView` reads the same from the runtime directly
 * — so a test asserts each client converges to the server's source of truth.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import type { RuntimeClientEventStreamMessage } from '../../shared/runtime-client-events'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { OrcaRuntimeService } from './orca-runtime'

type Pairing = NonNullable<ReturnType<typeof parsePairingCode>>

const REQUEST_TIMEOUT_MS = 5_000

/** A normalized, comparable snapshot of a server's repos / worktrees / project
 *  groups — the shape both the server truth and a client's re-queried view reduce
 *  to, so "consistent view" is a deep-equality check. */
export type NormalizedView = {
  repos: { id: string; displayName: string; projectGroupId: string | null }[]
  worktreesByRepo: Record<string, string[]>
  projectGroups: { id: string; name: string }[]
}

/** git-init a real repo under `parentDir` and return its realpath (canonicalized
 *  so macOS /var vs /private/var path comparisons in git tooling line up). */
export function seedGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name)
  execFileSync('mkdir', ['-p', repoPath])
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' })
  }
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'e2e@test.local'])
  git(['config', 'user.name', 'Orca Runtime E2E'])
  writeFileSync(join(repoPath, 'README.md'), `${name}\n`)
  git(['add', 'README.md'])
  git(['commit', '-m', 'init'])
  return realpathSync(repoPath)
}

/** Make a realpath'd temp directory tree for a server (its workspaceDir for
 *  worktrees plus a place to seed repos). */
export function makeServerTempRoot(label: string): { root: string; workspaceDir: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `orca-${label}-`)))
  const workspaceDir = join(root, 'workspaces')
  execFileSync('mkdir', ['-p', workspaceDir])
  return { root, workspaceDir }
}

export type EventSubscription = {
  events: RuntimeClientEventStreamMessage[]
  waitReady: (timeoutMs?: number) => Promise<void>
  close: () => void
}

export type RunningOrcaServer = {
  runtimeId: string
  newConnection: () => RemoteRuntimeRequestConnection
  subscribeEvents: () => Promise<EventSubscription>
  stop: () => Promise<void>
}

/** Start a real OrcaRuntimeRpcServer over an ephemeral E2EE WebSocket wrapping the
 *  real runtime, returning client factories. */
export async function startOrcaServer(
  service: OrcaRuntimeService,
  runtimeId: string
): Promise<RunningOrcaServer> {
  const userDataPath = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `orca-srv-${runtimeId}-`))
  )
  const server = new OrcaRuntimeRpcServer({
    runtime: service,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()

  const offer = server.createPairingOffer({ name: runtimeId, scope: 'runtime' })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  const pairing = parsePairingCode(offer.pairingUrl)
  if (!pairing) {
    throw new Error('invalid pairing')
  }

  const openSubscriptions: { close: () => void }[] = []
  const openConnections: RemoteRuntimeRequestConnection[] = []

  return {
    runtimeId,
    newConnection: () => {
      const connection = new RemoteRuntimeRequestConnection(pairing as Pairing)
      openConnections.push(connection)
      return connection
    },
    subscribeEvents: async () => {
      const events: RuntimeClientEventStreamMessage[] = []
      const subscription = await subscribeRemoteRuntimeRequest<RuntimeClientEventStreamMessage>(
        pairing as Pairing,
        'runtime.clientEvents.subscribe',
        undefined,
        REQUEST_TIMEOUT_MS,
        {
          onResponse: (response) => {
            if (response.ok) {
              events.push(response.result)
            }
          },
          onError: (error) => {
            throw error
          }
        }
      )
      openSubscriptions.push(subscription)
      return {
        events,
        waitReady: (timeoutMs = 5_000) =>
          waitFor(() => events.some((event) => event.type === 'ready'), timeoutMs),
        close: () => subscription.close()
      }
    },
    stop: async () => {
      for (const subscription of openSubscriptions) {
        subscription.close()
      }
      for (const connection of openConnections) {
        connection.close()
      }
      await server.stop()
    }
  }
}

type Repoish = { id: string; displayName: string; projectGroupId?: string | null }

function normalizeRepos(repos: Repoish[]): NormalizedView['repos'] {
  return repos
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      projectGroupId: r.projectGroupId ?? null
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** The server's own source of truth, read directly from the real runtime. */
export async function serverTruthView(runtime: OrcaRuntimeService): Promise<NormalizedView> {
  const repos = runtime.listRepos()
  const worktreesByRepo: Record<string, string[]> = {}
  for (const repo of repos) {
    const detected = await runtime.listDetectedManagedWorktrees(`id:${repo.id}`)
    worktreesByRepo[repo.id] = detected.worktrees.map((wt) => wt.id).sort()
  }
  return {
    repos: normalizeRepos(repos),
    worktreesByRepo,
    projectGroups: runtime
      .listProjectGroups()
      .map((g) => ({ id: g.id, name: g.name }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
}

type RepoListResult = { repos: Repoish[] }
type GroupListResult = { groups: { id: string; name: string }[] }
type DetectedListResult = { worktrees: { id: string }[] }

/** Re-query a client's full view through the real RPC and normalize it. */
export async function readClientView(
  connection: RemoteRuntimeRequestConnection
): Promise<NormalizedView> {
  const repoList = await connection.request<RepoListResult>(
    'repo.list',
    undefined,
    REQUEST_TIMEOUT_MS
  )
  const groupList = await connection.request<GroupListResult>(
    'projectGroup.list',
    undefined,
    REQUEST_TIMEOUT_MS
  )
  if (!repoList.ok || !groupList.ok) {
    throw new Error('view query failed')
  }
  const worktreesByRepo: Record<string, string[]> = {}
  for (const repo of repoList.result.repos) {
    const detected = await connection.request<DetectedListResult>(
      'worktree.detectedList',
      { repo: repo.id },
      REQUEST_TIMEOUT_MS
    )
    if (!detected.ok) {
      throw new Error('worktree query failed')
    }
    worktreesByRepo[repo.id] = detected.result.worktrees.map((wt) => wt.id).sort()
  }
  return {
    repos: normalizeRepos(repoList.result.repos),
    worktreesByRepo,
    projectGroups: groupList.result.groups
      .map((g) => ({ id: g.id, name: g.name }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

/** Poll a client's view until it deep-equals the expected normalized view. */
export async function waitForView(
  connection: RemoteRuntimeRequestConnection,
  expected: NormalizedView,
  timeoutMs = 5_000
): Promise<NormalizedView> {
  const start = Date.now()
  let last: NormalizedView | null = null
  while (Date.now() - start < timeoutMs) {
    last = await readClientView(connection)
    if (JSON.stringify(last) === JSON.stringify(expected)) {
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(
    `Client view did not converge.\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(last)}`
  )
}
