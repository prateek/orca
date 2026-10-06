/**
 * Typing, output and outage behaviour of a terminal on an SSH host reached over an impaired
 * network, across every travel profile. A measurement, not a gate: it asserts only that the
 * impairment is real and that every run produced a result.
 *
 * The app connects to the container's own address, never a published port, so the whole TCP
 * connection crosses the shaped path. On macOS it does so through a loopback forwarder, because
 * Local Network privacy refuses the test Electron binary a route to container addresses; see
 * `helpers/container-address-forwarder.ts`.
 *
 * Run (needs Docker that routes container IPs from this machine, e.g. OrbStack):
 *   ORCA_E2E_IMPAIRED_LATENCY=1 ORCA_E2E_SSH_DOCKER=1 ORCA_BACKGROUND_LAUNCH=1 \
 *     pnpm exec playwright test tests/e2e/impaired-network-ssh-terminal-latency.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 *
 * ORCA_E2E_IMPAIRED_RUNS (default 10), ORCA_E2E_IMPAIRED_PROFILES (comma-separated profile keys)
 * and ORCA_E2E_IMPAIRED_OUTPUT_DIR narrow or redirect a run.
 */
import {
  reconnectDisconnectedDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { listDockerSshRelayProcesses } from './helpers/docker-ssh-relay-processes'
import { execDockerSshRelayTargetCommand } from './helpers/docker-ssh-relay-target'
import { createRemoteTerminalTab } from './helpers/docker-ssh-relay-terminal-tabs'
import {
  openImpairedDockerSshShell,
  startImpairedDockerSshTarget,
  stopImpairedDockerSshTarget,
  type ImpairedDockerSshTarget
} from './helpers/impaired-docker-ssh-target'
import {
  measureAddedEchoDelay,
  readImpairedLatencyMatrixSettings,
  runImpairedLatencyMatrix
} from './helpers/impaired-terminal-latency-matrix'
import { prepareMeasuredShell, sleep } from './helpers/measured-remote-shell'
import { expect, test } from './helpers/orca-app'
import { readSshConnectionStatus } from './helpers/remote-connection-observation'

const RUN = process.env.ORCA_E2E_IMPAIRED_LATENCY === '1' && process.env.ORCA_E2E_SSH_DOCKER === '1'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test.describe('SSH terminal latency on impaired networks', () => {
  test.skip(!RUN, 'Set ORCA_E2E_IMPAIRED_LATENCY=1 and ORCA_E2E_SSH_DOCKER=1 to run.')
  test.skip(process.platform === 'win32', 'The Docker SSH target uses POSIX ssh tooling.')

  test('measures a remote shell across the travel profiles', async ({ orcaPage }, testInfo) => {
    const settings = readImpairedLatencyMatrixSettings(process.env, testInfo.outputDir)
    test.setTimeout((10 + settings.runs * settings.profiles.length * 3) * 60_000)
    let started: ImpairedDockerSshTarget | null = null
    try {
      started = await startImpairedDockerSshTarget(process.cwd())
      const { target } = started
      console.log(`[desktop-ssh] target ${target.containerName} at ${target.host}`)
      const { remote, shell } = await openImpairedDockerSshShell(orcaPage, started)
      const session = {
        page: orcaPage,
        network: started.network,
        connection: { kind: 'ssh' as const, targetId: remote.targetId },
        shell
      }

      const added = await measureAddedEchoDelay(session)
      console.log(
        `[desktop-ssh] echo p50 unshaped=${added.baselineMs.toFixed(0)}ms, with 300ms each way=${added.delayedMs.toFixed(0)}ms`
      )
      expect(added.delayedMs - added.baselineMs).toBeGreaterThanOrEqual(600)

      const results = await runImpairedLatencyMatrix(session, {
        ...settings,
        spec: 'desktop-ssh',
        context: {
          relayGracePeriodSeconds: 'default',
          unshapedEchoP50Ms: Math.round(added.baselineMs),
          echoP50With300MsEachWayMs: Math.round(added.delayedMs)
        },
        reopenTerminal: async (deadShellPid) => {
          // Why: tells a dead relay or shell apart from a pane the app no longer feeds.
          const deadShell = execDockerSshRelayTargetCommand(
            target,
            `ps -o pid=,etime=,comm= -p ${deadShellPid} || echo "shell ${deadShellPid} gone"`
          )
          const relays = listDockerSshRelayProcesses(target)
          console.log(
            `[desktop-ssh] reopening; remote: ${deadShell.trim()}; ${relays.length} relay processes`
          )
          // Why retry: on a lossy path the reconnect itself can fail, as it would for a person.
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
              break
            } catch (error) {
              console.log(`[desktop-ssh] reconnect attempt ${attempt} failed: ${String(error)}`)
              await sleep(5_000)
            }
          }
          if (await prepareMeasuredShell(orcaPage, 30_000)) {
            console.log('[desktop-ssh] an explicit disconnect and reconnect revived the pane')
            return
          }
          console.log('[desktop-ssh] the pane stayed dead after an explicit reconnect; new tab')
          if ((await readSshConnectionStatus(orcaPage, remote.targetId)) !== 'connected') {
            await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)
          }
          await createRemoteTerminalTab(orcaPage, remote.worktreeId)
        }
      })
      expect(results).toHaveLength(settings.runs * settings.profiles.length)
    } finally {
      stopImpairedDockerSshTarget(started)
    }
  })
})
