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
 * The target's sshd runs with ClientAliveInterval=15 and ClientAliveCountMax=3 (see
 * `helpers/impaired-docker-ssh-target.ts`), so during a 30 s cut sshd may drop the session from
 * its side; what the app does with that is part of what is observed here.
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
  readShellPid,
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
  /** Which shell answered in the pane after the restore: the one from before, another, or none. */
  pane: 'same-shell' | 'shell-replaced' | 'dead'
  /** Milliseconds from the restore until a shell answered in the pane; null if none did. */
  echoedAfterMs: number | null
  /** Milliseconds from the restore until the store showed the host connected; null if never. */
  connectedAfterMs: number | null
  /** Timed from the cut taking effect. */
  timeline: RemoteConnectionChange[]
}

function describeTimeline(changes: RemoteConnectionChange[]): string {
  return changes
    .map((change) => {
      const notices = change.notices.length > 0 ? ` [${change.notices.join('; ')}]` : ''
      // Why clamp: the first sample lands just before the cut takes effect.
      return `+${(Math.max(0, change.atMs) / 1000).toFixed(1)}s ${change.state}${notices}`
    })
    .join(' > ')
}

/** Cuts the link for `cutMs` while typing, restores it, and waits for a shell to answer. */
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
  try {
    // Renderer clock minus this process's clock, so cut and restore times sit among the samples.
    const clockOffsetMs = (await rendererNowMs(page)) - Date.now()
    cutImpairedNetwork(network)
    const cutAt = Date.now()
    await focusActiveTerminalInput(page)
    await typeAtCadence(page, randomShellToken(Math.floor(cutMs / 1_000)), 1_000)
    shapeImpairedNetwork(network, shape)
    const restoredAt = Date.now()
    // Why ask for the pid: it tells a dead pane from one answered by a replacement shell. Why
    // retype: a pane that revives late may or may not replay earlier input.
    let answeredBy: string | null = null
    let echoedAfterMs: number | null = null
    while (answeredBy === null && Date.now() - restoredAt < RECOVERY_MS) {
      answeredBy = await readShellPid(page, 10_000)
      if (answeredBy !== null) {
        echoedAfterMs = Date.now() - restoredAt
      }
    }
    sampling = false
    await sampler
    const timeline = remoteConnectionChanges(samples, cutAt + clockOffsetMs)
    const restoredAtMs = restoredAt - cutAt
    const connected = timeline.find(
      (change) => change.atMs >= restoredAtMs && change.state.startsWith('connected')
    )
    return {
      pane:
        answeredBy === null ? 'dead' : answeredBy === shell.pid ? 'same-shell' : 'shell-replaced',
      echoedAfterMs,
      connectedAfterMs: connected ? connected.atMs - restoredAtMs : null,
      timeline
    }
  } finally {
    sampling = false
    await sampler.catch(() => undefined)
  }
}

/** Opens a new tab on the same host and says whether a shell answers there. */
async function describeFreshTab(
  page: ImpairedTerminalSession['page'],
  worktreeId: string,
  targetId: string,
  originalPid: string
): Promise<string> {
  try {
    await createRemoteTerminalTab(page, worktreeId)
    const fresh = await prepareMeasuredShell(page, 30_000)
    if (fresh === null) {
      return `a new terminal tab on the same host does not answer either (host status ${await readSshConnectionStatus(page, targetId)})`
    }
    return fresh.pid === originalPid
      ? `after a new terminal tab was opened, the original shell ${originalPid} answered`
      : `a new terminal tab on the same host works at once (shell ${fresh.pid})`
  } catch (error) {
    return `a new terminal tab on the same host could not be opened: ${String(error).split('\n')[0]}`
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
      const session: ImpairedTerminalSession = {
        page: orcaPage,
        network,
        connection: { kind: 'ssh', targetId: remote.targetId },
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
            `${result.connectedAfterMs ?? 'never'} ms after restore; pane ${result.pane}` +
            `${result.echoedAfterMs === null ? '' : `, answered ${result.echoedAfterMs} ms after restore`}; ` +
            `relay processes ${relays} > ${relaysNow}; app showed: ${describeTimeline(result.timeline)}`
        )
        if (result.pane === 'dead') {
          const status = await readSshConnectionStatus(orcaPage, remote.targetId)
          const remoteShell = execDockerSshRelayTargetCommand(
            target,
            `ps -o pid=,etime= -p ${session.shell.pid} || echo gone`
          ).trim()
          const freshTab = await describeFreshTab(
            orcaPage,
            remote.worktreeId,
            remote.targetId,
            session.shell.pid
          )
          throw new Error(
            `#25783: no shell answered in the terminal pane in the ${RECOVERY_MS / 1000} s after ` +
              `cut ${cycle} of ${runs} (${cutMs / 1000} s on the ${profile.name} link). The host showed ` +
              `connected again ${result.connectedAfterMs === null ? 'at no point in that time' : `${(result.connectedAfterMs / 1000).toFixed(0)} s after the link was restored`}` +
              ` (status now: ${status}). The remote shell ${session.shell.pid} ` +
              `${remoteShell === 'gone' ? 'has exited' : `is alive (pid, elapsed: ${remoteShell})`}; ${freshTab}. ` +
              `Relay processes on the host: ${relays} before this cut, ${relaysNow} after. ` +
              `App timeline from the cut: ${describeTimeline(result.timeline)}`
          )
        }
        if (result.pane === 'shell-replaced') {
          // Why not a failure: the pane works, but the session behind it was replaced. Not
          // #25783; it is reported so a run that saw it is not read as a clean pass.
          const replacement = await prepareMeasuredShell(orcaPage, 30_000)
          if (!replacement) {
            throw new Error(`The replacement shell stopped answering after cut ${cycle}`)
          }
          console.log(`[ssh-outage] shell ${session.shell.pid} replaced by ${replacement.pid}`)
          session.shell = replacement
        } else if (!(await clearMeasuredShell(orcaPage, session.shell, 30_000))) {
          throw new Error(`Shell ${session.shell.pid} answered after cut ${cycle} but then stopped`)
        }
        relays = relaysNow
      }
      expect(await readSshConnectionStatus(orcaPage, remote.targetId)).toBe('connected')
    } finally {
      stopImpairedDockerSshTarget(started)
    }
  })
})
