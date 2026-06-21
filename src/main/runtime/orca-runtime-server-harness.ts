/**
 * Start a real OrcaRuntimeRpcServer (Remote Orca Server) over an ephemeral E2EE
 * WebSocket for an in-memory runtime, and drive paired clients against it.
 *
 * Keeps the real server, transport, E2EE handshake, client request connections,
 * and event-subscription stream — only the data store behind the runtime is a
 * fake (see in-memory-orca-runtime.ts). `readClientView` re-queries a client's
 * full repos/worktrees/projects through the real RPC so a test can assert a
 * client's view converges to the server's source of truth.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import type { RuntimeClientEventStreamMessage } from '../../shared/runtime-client-events'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { InMemoryOrcaRuntime, NormalizedView } from './in-memory-orca-runtime'

type Pairing = NonNullable<ReturnType<typeof parsePairingCode>>

const REQUEST_TIMEOUT_MS = 5_000

export type EventSubscription = {
  events: RuntimeClientEventStreamMessage[]
  /** Resolves once the subscription handshake (`ready`) has arrived. */
  waitReady: (timeoutMs?: number) => Promise<void>
  close: () => void
}

export type RunningOrcaServer = {
  runtime: InMemoryOrcaRuntime
  newConnection: () => RemoteRuntimeRequestConnection
  subscribeEvents: () => Promise<EventSubscription>
  stop: () => Promise<void>
}

/** Start a real OrcaRuntimeRpcServer over an ephemeral E2EE WebSocket for the
 *  given in-memory runtime, returning client factories. */
export async function startOrcaServer(runtime: InMemoryOrcaRuntime): Promise<RunningOrcaServer> {
  const userDataPath = mkdtempSync(join(tmpdir(), `orca-server-${runtime.runtimeId}-`))
  const server = new OrcaRuntimeRpcServer({
    runtime: runtime.service,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()

  const offer = server.createPairingOffer({ name: runtime.runtimeId, scope: 'runtime' })
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
    runtime,
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
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }
}

type RepoListResult = {
  repos: { id: string; path: string; displayName: string; projectGroupId?: string | null }[]
}
type GroupListResult = { groups: { id: string; name: string }[] }
type DetectedListResult = { worktrees: { id: string }[] }

/** Re-query a client's full view (repos + per-repo worktrees + project groups)
 *  through the real RPC and reduce it to the comparable normalized shape. */
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
    repos: repoList.result.repos
      .map((r) => ({
        id: r.id,
        path: r.path,
        displayName: r.displayName,
        projectGroupId: r.projectGroupId ?? null
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
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
