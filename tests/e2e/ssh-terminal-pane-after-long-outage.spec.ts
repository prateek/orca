/**
 * A terminal on an SSH host whose link drops every packet for 30 s, as in a subway tunnel. Once
 * the link is back, the pane must echo typed input again and the app must show the host connected.
 *
 * On `main` it does not (#25783): the remote shell stays alive and the pane never echoes again. In
 * the latency matrix (`impaired-network-ssh-terminal-latency.spec.ts`, subway profile, 10 of 10
 * runs) the host showed connected again 35-60 s after the link returned while the pane stayed
 * dead; this spec reports the same timeline so the two can be compared. Same topology; see that
 * spec's header. If the reconnect fails with ssh2's "Connection lost before handshake" and the
 * host stays in `error`, that is #25786, not this bug.
 *
 * As in the matrix, the link carries the subway profile's shape before and after each cut, and a
 * character is typed every second through the cut so the shell has output to deliver while the
 * link is down. The cut repeats on one session (ORCA_E2E_OUTAGE_RUNS, default 3): in the matrix
 * the session had been cut and reconnected before the outage that killed the pane, and a single
 * cut on a fresh session killed it in only one run of four. ORCA_E2E_OUTAGE_PROFILE (a travel
 * profile key or `unshaped`) and ORCA_E2E_OUTAGE_MS change the conditions. The relay process
 * count on the host is printed after every cut, for the growth seen in the matrix.
 *
 * Run:
 *   ORCA_E2E_IMPAIRED_LATENCY=1 ORCA_E2E_SSH_DOCKER=1 ORCA_BACKGROUND_LAUNCH=1 \
 *     pnpm exec playwright test tests/e2e/ssh-terminal-pane-after-long-outage.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { listDockerSshRelayProcesses } from './helpers/docker-ssh-relay-processes'
import { execDockerSshRelayTargetCommand } from './helpers/docker-ssh-relay-target'
import { createRemoteTerminalTab } from './helpers/docker-ssh-relay-terminal-tabs'
import {
  openImpairedDockerSshShell,
  startImpairedDockerSshTarget,
  stopImpairedDockerSshTarget,
  type ImpairedDockerSshTarget
} from './helpers/impaired-docker-ssh-target'
import { cutImpairedNetwork, shapeImpairedNetwork } from './helpers/impaired-network-link'
import { readOutageSettings } from './helpers/impaired-terminal-latency-matrix'
import {
  typeAtCadence,
  type ImpairedTerminalSession
} from './helpers/impaired-terminal-latency-scenarios'
import {
  clearMeasuredShell,
  prepareMeasuredShell,
  randomShellToken,
  sleep
} from './helpers/measured-remote-shell'
import type { NetworkLinkShape } from './helpers/netem-arguments'
import { expect, test } from './helpers/orca-app'
import {
  readSshConnectionStatus,
  remoteConnectionChanges,
  sampleRemoteConnection,
  type RemoteConnectionChange,
  type RemoteConnectionSample
} from './helpers/remote-connection-observation'
import { focusActiveTerminalInput } from './helpers/terminal'
import { rendererNowMs } from './helpers/terminal-echo-probe'

const RUN = process.env.ORCA_E2E_IMPAIRED_LATENCY === '1' && process.env.ORCA_E2E_SSH_DOCKER === '1'
const RECOVERY_MS = 90_000

type OutageCycle = {
  /** Milliseconds from the restore until the original pane echoed a fresh line; null if never. */
  echoedAfterMs: number | null
  /** Milliseconds from the restore until the store showed the host connected; null if never. */
  connectedAfterMs: number | null
  timeline: RemoteConnectionChange[]
}

function describeTimeline(changes: RemoteConnectionChange[]): string {
  return changes
    .map((change) => {
      const notices = change.notices.length > 0 ? ` [${change.notices.join('; ')}]` : ''
      return `+${(change.atMs / 1000).toFixed(1)}s ${change.state}${notices}`
    })
    .join(' > ')
}

/** Cuts the link for `cutMs` while typing, restores it, and waits for the pane to echo again. */
async function cutAndWaitForEcho(
  session: ImpairedTerminalSession,
  shape: NetworkLinkShape,
  cutMs: number
): Promise<OutageCycle> {
  const { page, network, connection, shell } = session
  // Why sample in the background: the pane check below types and waits, and what the app
  // showed meanwhile, timed from the cut, is the finding.
  const samples: RemoteConnectionSample[] = []
  let sampling = true
  const sampler = (async (): Promise<void> => {
    while (sampling) {
      samples.push(await sampleRemoteConnection(page, connection))
      await sleep(500)
    }
  })()
  const cutAtRendererMs = await rendererNowMs(page)
  cutImpairedNetwork(network)
  await focusActiveTerminalInput(page)
  await typeAtCadence(page, randomShellToken(Math.floor(cutMs / 1_000)), 1_000)
  shapeImpairedNetwork(network, shape)
  const restoredAt = Date.now()
  // Why retype: a pane that revives late may or may not replay earlier input.
  let echoedAfterMs: number | null = null
  while (echoedAfterMs === null && Date.now() - restoredAt < RECOVERY_MS) {
    if (await clearMeasuredShell(page, shell, 10_000)) {
      echoedAfterMs = Date.now() - restoredAt
    }
  }
  sampling = false
  await sampler
  const timeline = remoteConnectionChanges(samples, cutAtRendererMs)
  const connected = timeline.find(
    (change) => change.atMs > cutMs && change.state.startsWith('connected')
  )
  return {
    echoedAfterMs,
    connectedAfterMs: connected ? connected.atMs - cutMs : null,
    timeline
  }
}

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test.describe('SSH terminal pane after a long outage', () => {
  test.skip(!RUN, 'Set ORCA_E2E_IMPAIRED_LATENCY=1 and ORCA_E2E_SSH_DOCKER=1 to run.')
  test.skip(process.platform === 'win32', 'The Docker SSH target uses POSIX ssh tooling.')

  test('echoes typed input again once the link is back', async ({ orcaPage }) => {
    const { profile, cutMs, runs } = readOutageSettings(process.env, {
      profile: 'subway',
      cutMs: 30_000,
      runs: 3
    })
    test.setTimeout((6 + runs * 3) * 60_000)
    let started: ImpairedDockerSshTarget | null = null
    try {
      started = await startImpairedDockerSshTarget(process.cwd())
      const { target, network } = started
      const { remote, shell } = await openImpairedDockerSshShell(orcaPage, started)
      const session = {
        page: orcaPage,
        network,
        connection: { kind: 'ssh' as const, targetId: remote.targetId },
        shell
      }
      shapeImpairedNetwork(network, profile.shape)
      let relays = listDockerSshRelayProcesses(target).length
      console.log(`[ssh-outage] shell pid ${shell.pid}; ${relays} relay processes`)

      for (let cycle = 1; cycle <= runs; cycle += 1) {
        const result = await cutAndWaitForEcho(session, profile.shape, cutMs)
        const relaysNow = listDockerSshRelayProcesses(target).length
        console.log(
          `[ssh-outage] cut ${cycle} of ${runs} (${profile.name}, ${cutMs / 1000}s): host connected ` +
            `${result.connectedAfterMs ?? 'never'} ms after restore; pane echoed ` +
            `${result.echoedAfterMs ?? 'never'} ms after restore; relay processes ${relays} > ${relaysNow}; ` +
            `app showed: ${describeTimeline(result.timeline)}`
        )
        if (result.echoedAfterMs === null) {
          const status = await readSshConnectionStatus(orcaPage, remote.targetId)
          const remoteShell = execDockerSshRelayTargetCommand(
            target,
            `ps -o pid=,etime= -p ${shell.pid} || echo gone`
          ).trim()
          const freshShell = await createRemoteTerminalTab(orcaPage, remote.worktreeId).then(
            () => prepareMeasuredShell(orcaPage, 30_000),
            (error: unknown) => `could not be opened: ${String(error).split('\n')[0]}`
          )
          const freshTab =
            typeof freshShell === 'string'
              ? `a new terminal tab on the same host ${freshShell}`
              : freshShell === null
                ? `a new terminal tab on the same host does not answer either (host status ${await readSshConnectionStatus(orcaPage, remote.targetId)})`
                : freshShell.pid === shell.pid
                  ? `after a new terminal tab was opened, the original shell ${shell.pid} answered`
                  : `a new terminal tab on the same host works at once (shell ${freshShell.pid})`
          throw new Error(
            `#25783: the terminal pane never echoed typed input in the ${RECOVERY_MS / 1000} s after ` +
              `cut ${cycle} of ${runs} (${cutMs / 1000} s on the ${profile.name} link). The host showed ` +
              `connected again ${result.connectedAfterMs === null ? 'at no point in that time' : `${(result.connectedAfterMs / 1000).toFixed(0)} s after the link was restored`}` +
              ` (status now: ${status}). The remote shell ${shell.pid} ` +
              `${remoteShell === 'gone' ? 'has exited' : `is alive (pid, elapsed: ${remoteShell})`}; ${freshTab}. ` +
              `Relay processes on the host: ${relays} before this cut, ${relaysNow} after. ` +
              `App timeline from the cut: ${describeTimeline(result.timeline)}`
          )
        }
        relays = relaysNow
      }
      expect(await readSshConnectionStatus(orcaPage, remote.targetId)).toBe('connected')
    } finally {
      stopImpairedDockerSshTarget(started)
    }
  })
})
