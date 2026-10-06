import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { docker } from './docker-command'
import { ensureDockerSshRelayImage } from './docker-ssh-relay-image'
import {
  assertContainerAddressForwarderLived,
  startContainerAddressForwarder,
  type ContainerAddressForwarder
} from './container-address-forwarder'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  dockerSshRelayRunArgs,
  seedDockerSshRelayRepo,
  waitForDockerSshRelayTargetSsh,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'
import {
  impairContainerNetwork,
  stopImpairedNetwork,
  type ImpairedContainerNetwork
} from './impaired-network-link'
import { prepareMeasuredShell, type MeasuredShell } from './measured-remote-shell'
import { connectSshTestTarget, type ConnectedSshTestTarget } from './ssh-test-target-connection'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './terminal'
import { readTerminalScreen } from './terminal-echo-probe'

/**
 * Why client-alive: a connection that dies silently in a network cut would otherwise leave an
 * idle `sshd: root@notty` on the target until the ~2 h TCP keepalive clears it. Only this target
 * sets it, so the other Docker SSH specs keep the fixture's default sshd. A 30 s cut sits inside
 * the 45 s window, so what the app sees after a long cut includes sshd dropping the session.
 */
const SSHD_CLIENT_ALIVE_ARGS = ['-o', 'ClientAliveInterval=15', '-o', 'ClientAliveCountMax=3']

export type ImpairedDockerSshTarget = {
  /** `host` and `port` are the container's own address, never a published port. */
  target: DockerSshRelayTarget
  network: ImpairedContainerNetwork
  /** Loopback route to the container's address for the Electron app; see the forwarder. */
  forwarder: ContainerAddressForwarder
}

/**
 * Starts the Docker SSH fixture with no published port and shapes its network. The only way in is
 * the container's IP, which needs a Docker that routes container addresses from this machine
 * (OrbStack does; Docker Desktop for Mac does not).
 */
export async function startImpairedDockerSshTarget(root: string): Promise<ImpairedDockerSshTarget> {
  ensureDockerSshRelayImage(root)
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'orca-desk-ssh-'))
  const identityFile = path.join(tempDir, 'id_ed25519')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-desk-ssh-${randomUUID().slice(0, 8)}`
  const target: DockerSshRelayTarget = {
    containerName,
    containerIp: '',
    host: '',
    identityFile,
    port: 22,
    tempDir
  }
  let network: ImpairedContainerNetwork | undefined
  try {
    docker(dockerSshRelayRunArgs(containerName, publicKey, [], SSHD_CLIENT_ALIVE_ARGS), 120_000)
    target.containerIp = docker([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      containerName
    ])
    target.host = target.containerIp
    waitForDockerSshRelayTargetSsh(target)
    seedDockerSshRelayRepo(target, DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    network = impairContainerNetwork(root, containerName)
    const forwarder = await startContainerAddressForwarder(target.containerIp, target.port)
    return { target, network, forwarder }
  } catch (error) {
    stopImpairedNetwork(network)
    cleanupDockerSshRelayTarget(target)
    throw error
  }
}

/**
 * Connects the app to the target through the forwarder and brings the first terminal to the
 * measurement prompt. Uses the default relay grace period, the one a person gets.
 */
export async function openImpairedDockerSshShell(
  page: Page,
  started: ImpairedDockerSshTarget
): Promise<{ remote: ConnectedSshTestTarget; shell: MeasuredShell }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  const remote = await connectSshTestTarget(
    page,
    {
      label: `Impaired SSH ${Date.now()}`,
      host: '127.0.0.1',
      port: started.forwarder.port,
      username: 'root',
      identityFile: started.target.identityFile,
      identitiesOnly: true
    },
    { remotePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH, displayName: 'Impaired SSH E2E' }
  )
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
  const shell = await prepareMeasuredShell(page, 60_000)
  if (!shell) {
    throw new Error(
      `The SSH shell did not show the measurement prompt: ${JSON.stringify(await readTerminalScreen(page))}`
    )
  }
  return { remote, shell }
}

export function stopImpairedDockerSshTarget(started: ImpairedDockerSshTarget | null): void {
  if (!started) {
    return
  }
  started.forwarder.stop()
  stopImpairedNetwork(started.network)
  cleanupDockerSshRelayTarget(started.target)
  assertContainerAddressForwarderLived(started.forwarder)
}
