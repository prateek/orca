import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * A network link a test can make slow, lossy or dead.
 *
 * Two small containers forward one TCP port and shape only the hop between them with tc/netem.
 * Whatever connects through the link (the phone app, an SSH client, a paired Orca server) then has
 * its bytes carried by a real kernel TCP connection over that hop, so loss turns into
 * retransmission, backoff and head-of-line blocking the way it does on a real network. A proxy that
 * delays a byte stream cannot show any of that.
 *
 * Uplink is the direction from the local port to the target; downlink is the reverse.
 */
export type ImpairedNetworkLink = {
  /** Connect to 127.0.0.1 on this port to reach the target through the link. */
  localPort: number
  nearContainer: string
  farContainer: string
  network: string
}

export type NetworkLoss =
  | { kind: 'none' }
  /** Each packet dropped independently. Real links rarely lose packets this way. */
  | { kind: 'random'; percent: number }
  /**
   * Gilbert-Elliott: the link flips between a good and a bad state. `enterBadPercent` and
   * `leaveBadPercent` are the per-packet chances of switching; `lossInBadPercent` is the drop
   * rate while bad.
   */
  | { kind: 'bursty'; enterBadPercent: number; leaveBadPercent: number; lossInBadPercent: number }

/** One direction of the link. */
export type NetworkDirectionShape = {
  delayMs: number
  /** Standard deviation of the delay, normally distributed. */
  jitterMs?: number
  loss?: NetworkLoss
  /** Bandwidth cap in kbit/s. Omit for no cap. */
  rateKbit?: number
  /** Packets the link will hold before dropping more. netem's default is 1000. */
  queuePackets?: number
}

export type NetworkLinkShape = {
  uplink: NetworkDirectionShape
  downlink: NetworkDirectionShape
}

const FIXTURE_PARTS = ['tests', 'e2e', 'fixtures', 'impaired-network-link']
const LINK_PORT = 7000

function fixtureImage(root: string): string {
  const fixtureDir = path.join(root, ...FIXTURE_PARTS)
  const hash = createHash('sha256')
  for (const entry of readdirSync(fixtureDir).sort()) {
    hash.update(entry)
    hash.update('\0')
    hash.update(readFileSync(path.join(fixtureDir, entry)))
    hash.update('\0')
  }
  return `orca-e2e-impaired-network-link:${hash.digest('hex').slice(0, 16)}`
}

export function ensureImpairedNetworkLinkImage(root: string): string {
  const image = fixtureImage(root)
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
    const fixtureDir = path.join(root, ...FIXTURE_PARTS)
    execFileSync('docker', ['build', '--tag', image, fixtureDir], {
      stdio: 'inherit',
      timeout: 300_000
    })
  }
  return image
}

function docker(args: string[], timeoutMs = 30_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs
  }).trim()
}

function linkEndArgs(
  name: string,
  image: string,
  subnet: string,
  forwardTo: string,
  extra: string[]
): string[] {
  return [
    'create',
    '--name',
    name,
    '--cap-add',
    'NET_ADMIN',
    // Why: lets the far end reach a server running on the machine that runs Docker.
    '--add-host',
    'host.docker.internal:host-gateway',
    '-e',
    `LISTEN_PORT=${LINK_PORT}`,
    '-e',
    `FORWARD_TO=${forwardTo}`,
    '-e',
    `LINK_SUBNET=${subnet}`,
    ...extra,
    image
  ]
}

/**
 * Starts a link to `target` ("host:port", as seen from a container on Docker's default bridge;
 * use `host.docker.internal:<port>` for a server on this machine). The link starts unimpaired.
 */
export function startImpairedNetworkLink(root: string, target: string): ImpairedNetworkLink {
  const image = ensureImpairedNetworkLinkImage(root)
  const id = randomUUID().slice(0, 8)
  const network = `orca-e2e-link-${id}`
  const nearContainer = `${network}-near`
  const farContainer = `${network}-far`
  docker(['network', 'create', network])
  const subnet = docker(['network', 'inspect', '-f', '{{(index .IPAM.Config 0).Subnet}}', network])
  // Why: each end also sits on the default bridge, so reaching the caller or the target never
  // crosses the shaped interface and only the hop between the two ends is impaired.
  docker(linkEndArgs(farContainer, image, subnet, target, []))
  docker(['network', 'connect', network, farContainer])
  docker(['start', farContainer])
  docker(
    linkEndArgs(nearContainer, image, subnet, `${farContainer}:${LINK_PORT}`, [
      '-p',
      `127.0.0.1::${LINK_PORT}`
    ])
  )
  docker(['network', 'connect', network, nearContainer])
  docker(['start', nearContainer])
  const published = docker(['port', nearContainer, `${LINK_PORT}/tcp`])
  const localPort = Number(published.split(':').at(-1))
  if (!Number.isInteger(localPort) || localPort <= 0) {
    throw new Error(`Could not read the link's local port from: ${published}`)
  }
  const link = { localPort, nearContainer, farContainer, network }
  waitForLinkDevice(link)
  return link
}

function waitForLinkDevice(link: ImpairedNetworkLink): void {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const ready = [link.nearContainer, link.farContainer].every(
      (container) =>
        spawnSync('docker', ['exec', container, 'test', '-s', '/run/link-device'], {
          stdio: 'ignore',
          timeout: 5_000
        }).status === 0
    )
    if (ready) {
      return
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  throw new Error(`Impaired network link ${link.network} did not come up`)
}

/** The `tc ... netem` arguments for one direction. Exported so a test can assert on them. */
export function netemArguments(shape: NetworkDirectionShape): string[] {
  const args = ['delay', `${shape.delayMs}ms`]
  if (shape.jitterMs && shape.jitterMs > 0) {
    args.push(`${shape.jitterMs}ms`, 'distribution', 'normal')
  }
  const loss = shape.loss ?? { kind: 'none' }
  if (loss.kind === 'random') {
    args.push('loss', `${loss.percent}%`)
  } else if (loss.kind === 'bursty') {
    // gemodel p r 1-h 1-k: 1-h is the loss rate in the bad state, 1-k the loss rate in the good one.
    args.push(
      'loss',
      'gemodel',
      `${loss.enterBadPercent}%`,
      `${loss.leaveBadPercent}%`,
      `${loss.lossInBadPercent}%`,
      '0%'
    )
  }
  if (shape.rateKbit) {
    args.push('rate', `${shape.rateKbit}kbit`)
  }
  if (shape.queuePackets) {
    args.push('limit', String(shape.queuePackets))
  }
  return args
}

function setNetem(container: string, args: string[]): void {
  docker([
    'exec',
    container,
    'sh',
    '-c',
    `tc qdisc change dev "$(cat /run/link-device)" root netem ${args.join(' ')}`
  ])
}

export function shapeImpairedNetworkLink(link: ImpairedNetworkLink, shape: NetworkLinkShape): void {
  setNetem(link.nearContainer, netemArguments(shape.uplink))
  setNetem(link.farContainer, netemArguments(shape.downlink))
}

/**
 * Drops every packet in both directions until the link is shaped again. To TCP this is a tunnel
 * or a handover gap: nothing is refused, packets just stop arriving.
 */
export function cutImpairedNetworkLink(link: ImpairedNetworkLink): void {
  setNetem(link.nearContainer, ['loss', '100%'])
  setNetem(link.farContainer, ['loss', '100%'])
}

export function stopImpairedNetworkLink(link: ImpairedNetworkLink): void {
  spawnSync('docker', ['rm', '-f', link.nearContainer, link.farContainer], {
    stdio: 'ignore',
    timeout: 30_000
  })
  spawnSync('docker', ['network', 'rm', link.network], { stdio: 'ignore', timeout: 30_000 })
}
