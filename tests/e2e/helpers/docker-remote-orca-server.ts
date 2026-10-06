import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { decodePairingOffer, encodePairingOffer } from '../../../src/shared/pairing'
import {
  assertContainerAddressForwarderLived,
  startContainerAddressForwarder,
  type ContainerAddressForwarder
} from './container-address-forwarder'
import { docker } from './docker-command'
import { hashDockerFixtureDirectory } from './docker-ssh-relay-image'
import { parseHeadlessPairedRuntimePairingOffer } from './headless-paired-runtime-serve-readiness'
import {
  impairContainerNetwork,
  stopImpairedNetwork,
  type ImpairedContainerNetwork
} from './impaired-network-link'
import { prepareMeasuredShell, type MeasuredShell } from './measured-remote-shell'
import { waitForPairedClientWorktree } from './paired-client-host-session'
import { selectPairedRuntimeEnvironment } from './paired-client-runtime-environment'
import type { RuntimeDesktopPairingOffer } from './paired-electron-client'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab
} from './paired-host-terminal'
import { waitForSessionReady } from './store'
import { waitForActivePanePtyId } from './terminal'
import { readTerminalScreen } from './terminal-echo-probe'

export const DOCKER_REMOTE_ORCA_SERVER_REPO_PATH = '/home/orca/repo'
const SERVE_PORT = 6800

export type DockerRemoteOrcaServer = {
  containerName: string
  /** Points at the forwarder, which reaches the container's own address across the shaped path. */
  offer: RuntimeDesktopPairingOffer
  network: ImpairedContainerNetwork
  forwarder: ContainerAddressForwarder
}

function ensureImage(root: string): string {
  const fixtureDir = path.join(root, 'tests', 'e2e', 'fixtures', 'docker-remote-orca-server')
  const image = `orca-desk-remote-server:${hashDockerFixtureDirectory(fixtureDir)}`
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
    execFileSync('docker', ['build', '--tag', image, fixtureDir], {
      stdio: 'inherit',
      timeout: 600_000
    })
  }
  return image
}

async function waitForPairingOffer(containerName: string): Promise<RuntimeDesktopPairingOffer> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const logs = spawnSync('docker', ['logs', containerName], { encoding: 'utf8', timeout: 10_000 })
    for (const line of logs.stdout.split(/\r?\n/)) {
      const offer = parseHeadlessPairedRuntimePairingOffer(line)
      if (offer) {
        return offer
      }
    }
    if (docker(['inspect', '--format', '{{.State.Running}}', containerName]) !== 'true') {
      // Why stderr only: stdout may carry the pairing secret.
      throw new Error(`Remote Orca server exited before it was ready:\n${logs.stderr.slice(-4000)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error('Remote Orca server did not publish a pairing offer within 3 minutes')
}

/**
 * Runs a released Linux `orca serve` in a container and shapes its network. A paired desktop
 * reaches the container's own address across the shaped path, through a loopback forwarder. Needs
 * a Docker that routes container addresses from this machine (OrbStack does).
 */
export async function startDockerRemoteOrcaServer(
  root: string,
  appImagePath: string
): Promise<DockerRemoteOrcaServer> {
  const image = ensureImage(root)
  const containerName = `orca-desk-server-${randomUUID().slice(0, 8)}`
  const appImage = `/artifacts/${path.basename(appImagePath)}`
  let network: ImpairedContainerNetwork | undefined
  try {
    docker(
      [
        'run',
        '-d',
        '--name',
        containerName,
        // Why: xvfb-run never sees Xvfb's ready signal when it is PID 1, and waits forever.
        '--init',
        '-v',
        `${path.dirname(path.resolve(appImagePath))}:/artifacts:ro`,
        image,
        'bash',
        '-lc',
        [
          `git init -q ${DOCKER_REMOTE_ORCA_SERVER_REPO_PATH}`,
          `cd ${DOCKER_REMOTE_ORCA_SERVER_REPO_PATH}`,
          'git -c user.email=e2e@test.local -c user.name=E2E commit -q --allow-empty -m initial',
          // Why extract-and-run: containers have no FUSE to mount an AppImage.
          `exec xvfb-run -a ${appImage} --appimage-extract-and-run --no-sandbox serve ` +
            `--port ${SERVE_PORT} --pairing-address "$(hostname -i)" --json`
        ].join(' && ')
      ],
      120_000
    )
    const pairing = decodePairingOffer((await waitForPairingOffer(containerName)).pairingUrl)
    const endpoint = new URL(pairing.endpoint)
    network = impairContainerNetwork(root, containerName)
    const forwarder = await startContainerAddressForwarder(network.address, Number(endpoint.port))
    endpoint.hostname = '127.0.0.1'
    endpoint.port = String(forwarder.port)
    return {
      containerName,
      offer: {
        pairingUrl: encodePairingOffer({ ...pairing, endpoint: endpoint.href.replace(/\/$/, '') })
      },
      network,
      forwarder
    }
  } catch (error) {
    stopImpairedNetwork(network)
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 30_000 })
    throw error
  }
}

/**
 * Pairs the app with the server, adds the server's repository and brings a host terminal to the
 * measurement prompt. The app must have started with no seeded repo of its own.
 */
export async function openDockerRemoteOrcaServerShell(
  page: Page,
  server: DockerRemoteOrcaServer
): Promise<{ environmentId: string; worktreeId: string; shell: MeasuredShell }> {
  await waitForSessionReady(page)
  const environmentId = await selectPairedRuntimeEnvironment(page, {
    name: 'Impaired remote server',
    pairingUrl: server.offer.pairingUrl,
    reusedProfile: false
  })
  await callEnvironment(page, environmentId, 'repo.add', {
    path: DOCKER_REMOTE_ORCA_SERVER_REPO_PATH,
    kind: 'git'
  })
  const worktreeId = await waitForPairedClientWorktree(page)
  const terminal = await createPairedHostTerminal(page, environmentId, worktreeId, 'bash')
  await openPairedClientTab(page, worktreeId, terminal.webTabId)
  await waitForActivePanePtyId(page, 60_000)
  const shell = await prepareMeasuredShell(page, 60_000)
  if (!shell) {
    throw new Error(
      `The remote server shell did not show the measurement prompt: ${JSON.stringify(await readTerminalScreen(page))}`
    )
  }
  return { environmentId, worktreeId, shell }
}

export function stopDockerRemoteOrcaServer(server: DockerRemoteOrcaServer | null): void {
  if (!server) {
    return
  }
  server.forwarder.stop()
  stopImpairedNetwork(server.network)
  spawnSync('docker', ['rm', '-f', server.containerName], { stdio: 'ignore', timeout: 30_000 })
  assertContainerAddressForwarderLived(server.forwarder)
}
