/**
 * Typing, output and outage behaviour of a terminal on a paired remote Orca server reached over an
 * impaired network, across every travel profile. A measurement, not a gate: it asserts only that
 * the impairment is real and that every run produced a result.
 *
 * The server is a released Linux AppImage, so it is not built from this checkout. Download one
 * for the Docker host's architecture and point ORCA_E2E_REMOTE_SERVER_APPIMAGE at it.
 *
 * The app connects to the container's own address, never a published port, so the whole TCP
 * connection crosses the shaped path. On macOS it does so through a loopback forwarder, because
 * Local Network privacy refuses the test Electron binary a route to container addresses; see
 * `helpers/container-address-forwarder.ts`.
 *
 * No run of the published matrix needed the terminal reopened, so this topology has no reopen
 * step: a shell that stops answering ends the run, and ORCA_E2E_IMPAIRED_RESUME=1 continues it.
 *
 * Run (needs Docker that routes container IPs from this machine, e.g. OrbStack):
 *   ORCA_E2E_IMPAIRED_LATENCY=1 ORCA_BACKGROUND_LAUNCH=1 \
 *     ORCA_E2E_REMOTE_SERVER_APPIMAGE=/path/to/orca-linux-arm64.AppImage \
 *     pnpm exec playwright test tests/e2e/impaired-network-paired-server-terminal-latency.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 *
 * ORCA_E2E_IMPAIRED_RUNS (default 10), ORCA_E2E_IMPAIRED_PROFILES (comma-separated profile keys)
 * and ORCA_E2E_IMPAIRED_OUTPUT_DIR narrow or redirect a run.
 */
import path from 'node:path'
import {
  openDockerRemoteOrcaServerShell,
  startDockerRemoteOrcaServer,
  stopDockerRemoteOrcaServer,
  type DockerRemoteOrcaServer
} from './helpers/docker-remote-orca-server'
import {
  measureAddedEchoDelay,
  readImpairedLatencyMatrixSettings,
  runImpairedLatencyMatrix
} from './helpers/impaired-terminal-latency-matrix'
import { expect, test } from './helpers/orca-app'
import { runWithTopologyTeardown } from './helpers/topology-teardown'

const APP_IMAGE = process.env.ORCA_E2E_REMOTE_SERVER_APPIMAGE
const RUN = process.env.ORCA_E2E_IMPAIRED_LATENCY === '1' && Boolean(APP_IMAGE)

// Why no seeded repo: the only workspace should be the one the remote server owns.
test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' }, seedTestRepo: false })

test.describe('Paired remote server terminal latency on impaired networks', () => {
  test.skip(!RUN, 'Set ORCA_E2E_IMPAIRED_LATENCY=1 and ORCA_E2E_REMOTE_SERVER_APPIMAGE to run.')
  test.skip(process.platform === 'win32', 'The remote server runs in a Linux container.')

  test('measures a remote shell across the travel profiles', async ({ orcaPage }, testInfo) => {
    const settings = readImpairedLatencyMatrixSettings(process.env, testInfo.outputDir)
    test.setTimeout((10 + settings.runs * settings.profiles.length * 3) * 60_000)
    let server: DockerRemoteOrcaServer | null = null
    await runWithTopologyTeardown(
      async () => {
        server = await startDockerRemoteOrcaServer(process.cwd(), APP_IMAGE ?? '')
        const { environmentId, shell } = await openDockerRemoteOrcaServerShell(orcaPage, server)
        const session = {
          page: orcaPage,
          network: server.network,
          connection: { kind: 'runtime' as const, environmentId },
          shell
        }

        const added = await measureAddedEchoDelay(session)
        console.log(
          `[desktop-server] echo p50 unshaped=${added.baselineMs.toFixed(0)}ms, with 300ms each way=${added.delayedMs.toFixed(0)}ms`
        )
        expect(added.delayedMs - added.baselineMs).toBeGreaterThanOrEqual(600)

        const results = await runImpairedLatencyMatrix(session, {
          ...settings,
          spec: 'desktop-server',
          context: {
            serverAppImage: path.basename(APP_IMAGE ?? ''),
            unshapedEchoP50Ms: Math.round(added.baselineMs),
            echoP50With300MsEachWayMs: Math.round(added.delayedMs)
          }
        })
        expect(results).toHaveLength(settings.runs * settings.profiles.length)
      },
      () => stopDockerRemoteOrcaServer(server)
    )
  })
})
