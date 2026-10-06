/**
 * Typing into a terminal on a paired remote Orca server while the link drops every packet for a
 * while. Every character typed before, during and after the outage must reach the shell, in
 * order, once the link is back: the forced-cut scenario of the latency matrix (32 characters,
 * 8 before the cut, 16 spread across it, 8 after), repeated several times on one session.
 *
 * On `main` some runs lose part of the typed text while the runtime status reports ready again
 * (#25784). The bug was found by `impaired-network-paired-server-terminal-latency.spec.ts`; same
 * topology, see that spec's header. The default conditions are the ones that reproduce it: the
 * subway profile's shape with a 30 s cut lost characters in 4 of 5 runs (16 of 32 in one, and a
 * stray ^C after the first character in three), while an 8 s cut on a clean link lost nothing in
 * 5 runs here and 10 in the matrix. ORCA_E2E_OUTAGE_PROFILE (a travel profile key or `unshaped`),
 * ORCA_E2E_OUTAGE_MS and ORCA_E2E_OUTAGE_RUNS change the conditions.
 *
 * Run:
 *   ORCA_E2E_IMPAIRED_LATENCY=1 ORCA_BACKGROUND_LAUNCH=1 \
 *     ORCA_E2E_REMOTE_SERVER_APPIMAGE=/path/to/orca-linux-arm64.AppImage \
 *     pnpm exec playwright test tests/e2e/paired-server-input-across-outage.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import {
  openDockerRemoteOrcaServerShell,
  startDockerRemoteOrcaServer,
  stopDockerRemoteOrcaServer,
  type DockerRemoteOrcaServer
} from './helpers/docker-remote-orca-server'
import { shapeImpairedNetwork } from './helpers/impaired-network-link'
import { readOutageSettings } from './helpers/impaired-terminal-latency-matrix'
import {
  measureCut,
  type CutMeasurement,
  type ImpairedTerminalSession
} from './helpers/impaired-terminal-latency-scenarios'
import { clearMeasuredShell, prepareMeasuredShell } from './helpers/measured-remote-shell'
import { test } from './helpers/orca-app'

const APP_IMAGE = process.env.ORCA_E2E_REMOTE_SERVER_APPIMAGE
const RUN = process.env.ORCA_E2E_IMPAIRED_LATENCY === '1' && Boolean(APP_IMAGE)

function describeRun(run: number, cut: CutMeasurement): string {
  const states = cut.connection.map((change) => `${change.atMs}ms:${change.state}`).join(' > ')
  const verdict =
    cut.lost === null
      ? 'shell did not answer, loss unknown'
      : `lost ${cut.lost}, duplicated ${cut.duplicated}`
  return `run ${run}: ${verdict}; echoed ${cut.echoed}/${cut.typed}; shell showed "${cut.displayed}"; runtime status: ${states}`
}

// Why no seeded repo: the only workspace should be the one the remote server owns.
test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' }, seedTestRepo: false })

test.describe('Paired remote server input across an outage', () => {
  test.skip(!RUN, 'Set ORCA_E2E_IMPAIRED_LATENCY=1 and ORCA_E2E_REMOTE_SERVER_APPIMAGE to run.')
  test.skip(process.platform === 'win32', 'The remote server runs in a Linux container.')

  test('delivers every character typed around an outage', async ({ orcaPage }) => {
    const { profile, cutMs, runs } = readOutageSettings(process.env, {
      profile: 'subway',
      cutMs: 30_000,
      runs: 5
    })
    test.setTimeout((8 + runs * 3) * 60_000)
    let server: DockerRemoteOrcaServer | null = null
    try {
      server = await startDockerRemoteOrcaServer(process.cwd(), APP_IMAGE ?? '')
      const { environmentId, shell } = await openDockerRemoteOrcaServerShell(orcaPage, server)
      const session: ImpairedTerminalSession = {
        page: orcaPage,
        network: server.network,
        connection: { kind: 'runtime', environmentId },
        shell
      }
      shapeImpairedNetwork(server.network, profile.shape)
      const reports: string[] = []
      const failed: string[] = []
      for (let run = 1; run <= runs; run += 1) {
        if (!(await clearMeasuredShell(orcaPage, session.shell, 30_000))) {
          const recovered = await prepareMeasuredShell(orcaPage, 60_000)
          if (!recovered) {
            throw new Error(`The shell stopped answering before run ${run}:\n${reports.join('\n')}`)
          }
          session.shell = recovered
        }
        const cut = await measureCut(session, profile, { kind: 'forced', cutMs })
        const report = describeRun(run, cut)
        console.log(`[server-outage] ${report}`)
        reports.push(report)
        if (cut.lost !== 0 || cut.duplicated !== 0) {
          failed.push(report)
        }
      }
      if (failed.length > 0) {
        throw new Error(
          `#25784: ${failed.length} of ${runs} runs did not deliver every character typed around a ` +
            `${cutMs / 1000} s outage on the ${profile.name} link. Each line ends with what ` +
            `the runtime status showed, timed from the cut:\n${failed.join('\n')}`
        )
      }
    } finally {
      stopDockerRemoteOrcaServer(server)
    }
  })
})
