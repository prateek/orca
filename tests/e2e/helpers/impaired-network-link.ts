import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Network paths a test can make slow, lossy or dead, with tc/netem acting on packets.
 *
 * Two ways to put a path under test, both shaped and cut with the same calls:
 *
 * - `impairContainerNetwork` shapes everything an existing container sends and receives, on the
 *   host side of its veth. The client connects to the container's own IP, so one TCP connection
 *   runs end to end and both real TCP stacks see the loss: retransmission, backoff, head-of-line
 *   blocking and slow connects all appear. Use this whenever the far side is a container (an SSH
 *   target, an Orca server).
 * - `startImpairedNetworkLink` forwards a local port through two containers and shapes the hop
 *   between them. The caller's own connection ends at the first container, so only the middle hop
 *   has TCP under loss. That is the shape of a relayed path, and it is the only option when the
 *   far side is a process on this machine. It does not show connect-time or client-side TCP
 *   effects.
 *
 * Never reach an impaired container through a published `localhost` port: Docker terminates that
 * connection and the client sees a perfect link.
 *
 * Uplink is the direction from the client to the target; downlink is the reverse.
 */
export type ImpairedContainerNetwork = {
  /** The container's IP. Connect to this, not to a published port. */
  address: string
  shaperContainer: string
}

export type ImpairedNetworkPath = ImpairedNetworkLink | ImpairedContainerNetwork
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
   * rate while bad (every packet, if omitted). Long-run loss is enter / (enter + leave) and the
   * mean burst is 1 / leave packets. The state advances per packet, not per second, so an outage
   * of a given duration has to be a timed cut, not a loss setting.
   */
  | { kind: 'bursty'; enterBadPercent: number; leaveBadPercent: number; lossInBadPercent?: number }

/** One direction of the link. */
export type NetworkDirectionShape = {
  delayMs: number
  /** Standard deviation of the delay. Requires `rateKbit`. */
  jitterMs?: number
  /** Shape of the delay spread; `paretonormal` and `pareto` have long tails. Default `normal`. */
  jitterDistribution?: 'normal' | 'pareto' | 'paretonormal'
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
    image,
    'link-end'
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
  waitForFile(farContainer, '/run/link-device')
  waitForFile(nearContainer, '/run/link-device')
  return { localPort, nearContainer, farContainer, network }
}

function waitForFile(container: string, file: string): void {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = spawnSync('docker', ['exec', container, 'test', '-s', file], {
      stdio: 'ignore',
      timeout: 5_000
    })
    if (found.status === 0) {
      return
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: 10_000 })
  throw new Error(`${container} did not come up: ${logs.stderr || logs.stdout}`)
}

/** The `tc ... netem` arguments for one direction. Exported so a test can assert on them. */
export function netemArguments(shape: NetworkDirectionShape): string[] {
  const args = ['delay', `${shape.delayMs}ms`]
  if (shape.jitterMs && shape.jitterMs > 0) {
    if (!shape.rateKbit) {
      // Why: netem releases each packet at its own delayed time, so jitter with no rate limit
      // reorders packets, which a real first-in-first-out path does not do.
      throw new Error('jitterMs needs rateKbit: jitter without a rate limit reorders packets')
    }
    args.push(`${shape.jitterMs}ms`, 'distribution', shape.jitterDistribution ?? 'normal')
  }
  const loss = shape.loss ?? { kind: 'none' }
  if (loss.kind === 'random') {
    args.push('loss', 'random', `${loss.percent}%`)
  } else if (loss.kind === 'bursty') {
    args.push('loss', 'gemodel', `${loss.enterBadPercent}%`, `${loss.leaveBadPercent}%`)
    if (loss.lossInBadPercent !== undefined) {
      // gemodel p r 1-h 1-k: 1-h is the loss rate in the bad state, 1-k in the good one.
      args.push(`${loss.lossInBadPercent}%`, '0%')
    }
  }
  if (shape.rateKbit) {
    args.push('rate', `${shape.rateKbit}kbit`)
  }
  if (shape.queuePackets) {
    args.push('limit', String(shape.queuePackets))
  }
  return args
}

function isContainerNetwork(path: ImpairedNetworkPath): path is ImpairedContainerNetwork {
  return 'shaperContainer' in path
}

/** [container, shell expression naming the device] for each direction of a path. */
function shapedDevices(path: ImpairedNetworkPath): { uplink: string[]; downlink: string[] } {
  return isContainerNetwork(path)
    ? {
        uplink: [path.shaperContainer, '$(cat /run/shaper/up)'],
        downlink: [path.shaperContainer, '$(cat /run/shaper/down)']
      }
    : {
        uplink: [path.nearContainer, '$(cat /run/link-device)'],
        downlink: [path.farContainer, '$(cat /run/link-device)']
      }
}

function setNetem([container, device]: string[], args: string[]): void {
  // Why replace, not change: `tc qdisc change` keeps none of the previous settings, and replace
  // also works when no qdisc is there yet.
  docker([
    'exec',
    container,
    'sh',
    '-c',
    `tc qdisc replace dev "${device}" root handle 1: netem ${args.join(' ')}`
  ])
}

export function shapeImpairedNetwork(path: ImpairedNetworkPath, shape: NetworkLinkShape): void {
  const devices = shapedDevices(path)
  setNetem(devices.uplink, netemArguments(shape.uplink))
  setNetem(devices.downlink, netemArguments(shape.downlink))
}

/**
 * Drops every packet in both directions until the path is shaped again. To TCP this is a tunnel
 * or a coverage hole: nothing is refused, packets just stop arriving. Packets already held by the
 * path are discarded.
 */
export function cutImpairedNetwork(path: ImpairedNetworkPath): void {
  const devices = shapedDevices(path)
  setNetem(devices.uplink, ['loss', '100%'])
  setNetem(devices.downlink, ['loss', '100%'])
}

export type NetworkOutageSchedule = {
  /** Seconds from the end of one outage to the start of the next. */
  everySeconds: number
  forSeconds: number
}

/**
 * Cuts the path on a fixed cycle until the returned function is called, restoring `shape` after
 * each cut. A fixed cycle keeps runs comparable. `onOutage` receives each cut's start and end
 * times so results can be lined up against them.
 */
export function scheduleNetworkOutages(
  path: ImpairedNetworkPath,
  shape: NetworkLinkShape,
  schedule: NetworkOutageSchedule,
  onOutage?: (startedAtMs: number, endedAtMs: number) => void
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const waitThenCut = (): void => {
    timer = setTimeout(() => {
      const startedAtMs = Date.now()
      cutImpairedNetwork(path)
      timer = setTimeout(() => {
        shapeImpairedNetwork(path, shape)
        onOutage?.(startedAtMs, Date.now())
        if (!stopped) {
          waitThenCut()
        }
      }, schedule.forSeconds * 1000)
    }, schedule.everySeconds * 1000)
  }
  waitThenCut()
  return () => {
    stopped = true
    clearTimeout(timer)
    shapeImpairedNetwork(path, shape)
  }
}

/**
 * Starts shaping an existing container's traffic. The path starts unimpaired. The container
 * needs no extra privileges and no changes; the shaper works from the host's network namespace.
 */
export function impairContainerNetwork(root: string, container: string): ImpairedContainerNetwork {
  const image = ensureImpairedNetworkLinkImage(root)
  const address = docker([
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    container
  ])
  const vethIndex = docker(['exec', container, 'cat', '/sys/class/net/eth0/iflink'])
  const id = randomUUID().slice(0, 8)
  const shaperContainer = `orca-e2e-shaper-${id}`
  docker([
    'run',
    '-d',
    '--name',
    shaperContainer,
    '--privileged',
    '--net=host',
    '-e',
    `VETH_INDEX=${vethIndex}`,
    '-e',
    // Interface names are limited to 15 characters.
    `IFB_NAME=ifb${id}`,
    image,
    'veth-shaper'
  ])
  const path = { address, shaperContainer }
  waitForFile(shaperContainer, '/run/shaper/down')
  return path
}

export function stopImpairedNetwork(path: ImpairedNetworkPath): void {
  if (isContainerNetwork(path)) {
    // Why stop before rm: the shaper removes its qdiscs and ifb device on SIGTERM, and they live
    // in the host's network namespace, so they would outlast a killed container.
    spawnSync('docker', ['stop', '-t', '10', path.shaperContainer], {
      stdio: 'ignore',
      timeout: 30_000
    })
    spawnSync('docker', ['rm', '-f', path.shaperContainer], { stdio: 'ignore', timeout: 30_000 })
    return
  }
  spawnSync('docker', ['rm', '-f', path.nearContainer, path.farContainer], {
    stdio: 'ignore',
    timeout: 30_000
  })
  spawnSync('docker', ['network', 'rm', path.network], { stdio: 'ignore', timeout: 30_000 })
}
