import { execFileSync, spawnSync } from 'node:child_process'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cutImpairedNetwork,
  ensureImpairedNetworkLinkImage,
  impairContainerNetwork,
  netemArguments,
  shapeImpairedNetwork,
  startImpairedNetworkLink,
  stopImpairedNetwork,
  type ImpairedContainerNetwork,
  type ImpairedNetworkLink,
  type NetworkLinkShape
} from './helpers/impaired-network-link'
import { NETWORK_TRAVEL_PROFILES } from './helpers/network-travel-profiles'

const runDocker = process.env.ORCA_RUN_DOCKER_NETWORK_LINK_E2E === '1'
const ECHO_PORT = 9000

const symmetric = (direction: NetworkLinkShape['uplink']): NetworkLinkShape => ({
  uplink: direction,
  downlink: direction
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function connect(host: string, port: number): Promise<{ socket: net.Socket; connectMs: number }> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () =>
      resolve({ socket, connectMs: performance.now() - started })
    )
    socket.once('error', reject)
  })
}

/** Sends one line every 50ms to an echo server; resolves with sorted round trips. */
async function measureRoundTrips(
  host: string,
  port: number,
  count: number
): Promise<{ roundTrips: number[]; connectMs: number }> {
  const { socket, connectMs } = await connect(host, port)
  socket.setNoDelay(true)
  const sentAt = new Map<string, number>()
  const roundTrips: number[] = []
  let buffered = ''
  socket.on('data', (chunk) => {
    buffered += chunk.toString()
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const started = sentAt.get(buffered.slice(0, end))
      buffered = buffered.slice(end + 1)
      if (started !== undefined) {
        roundTrips.push(performance.now() - started)
      }
    }
  })
  for (let i = 0; i < count; i++) {
    sentAt.set(String(i), performance.now())
    socket.write(`${i}\n`)
    await sleep(50)
  }
  const deadline = Date.now() + 30_000
  while (roundTrips.length < count && Date.now() < deadline) {
    await sleep(50)
  }
  socket.destroy()
  return { roundTrips: roundTrips.sort((a, b) => a - b), connectMs }
}

const median = (sorted: number[]): number => sorted[Math.floor(sorted.length / 2)]

describe('netem arguments', () => {
  it('writes delay, jitter, bursty loss, rate and queue', () => {
    expect(
      netemArguments({
        delayMs: 150,
        jitterMs: 30,
        jitterDistribution: 'paretonormal',
        loss: { kind: 'bursty', enterBadPercent: 1, leaveBadPercent: 20 },
        rateKbit: 2000,
        queuePackets: 200
      }).join(' ')
    ).toBe('delay 150ms 30ms distribution paretonormal loss gemodel 1% 20% rate 2000kbit limit 200')
  })

  it('refuses jitter without a rate limit, which would reorder packets', () => {
    expect(() => netemArguments({ delayMs: 50, jitterMs: 10 })).toThrow(/rateKbit/)
  })

  it('accepts every travel profile', () => {
    for (const profile of Object.values(NETWORK_TRAVEL_PROFILES)) {
      expect(netemArguments(profile.shape.uplink).length).toBeGreaterThan(0)
      expect(netemArguments(profile.shape.downlink).length).toBeGreaterThan(0)
    }
  })
})

describe.runIf(runDocker)('impaired container network (end to end)', () => {
  const server = `orca-e2e-echo-${process.pid}`
  let path: ImpairedContainerNetwork

  beforeAll(() => {
    const image = ensureImpairedNetworkLinkImage(process.cwd())
    execFileSync('docker', [
      'run',
      '-d',
      '--name',
      server,
      image,
      'socat',
      `TCP-LISTEN:${ECHO_PORT},fork,reuseaddr,nodelay`,
      'EXEC:cat'
    ])
    path = impairContainerNetwork(process.cwd(), server)
  }, 400_000)

  afterAll(() => {
    stopImpairedNetwork(path)
    spawnSync('docker', ['rm', '-f', server], { stdio: 'ignore' })
  })

  it('delays the TCP handshake itself, so the client stack is on the impaired path', async () => {
    shapeImpairedNetwork(path, symmetric({ delayMs: 100 }))
    const { roundTrips, connectMs } = await measureRoundTrips(path.address, ECHO_PORT, 30)
    expect(connectMs).toBeGreaterThan(190)
    expect(median(roundTrips)).toBeGreaterThan(195)
    expect(median(roundTrips)).toBeLessThan(260)
  }, 60_000)

  it('turns packet loss into late delivery, never missing bytes', async () => {
    shapeImpairedNetwork(path, symmetric({ delayMs: 50, loss: { kind: 'random', percent: 10 } }))
    const { roundTrips } = await measureRoundTrips(path.address, ECHO_PORT, 80)
    expect(roundTrips).toHaveLength(80)
    // A retransmission costs at least one retransmission timeout on top of the 100ms round trip.
    expect(roundTrips.at(-1)).toBeGreaterThan(250)
  }, 90_000)

  it('holds traffic through a cut and delivers it after the path returns', async () => {
    const shape = symmetric({ delayMs: 50 })
    shapeImpairedNetwork(path, shape)
    const measuring = measureRoundTrips(path.address, ECHO_PORT, 60)
    await sleep(1_000)
    cutImpairedNetwork(path)
    await sleep(2_000)
    shapeImpairedNetwork(path, shape)
    const { roundTrips } = await measuring
    expect(roundTrips).toHaveLength(60)
    expect(roundTrips.at(-1)).toBeGreaterThan(2_000)
  }, 90_000)

  it('applies a full travel profile', async () => {
    shapeImpairedNetwork(path, NETWORK_TRAVEL_PROFILES.inflightGeo.shape)
    const { roundTrips, connectMs } = await measureRoundTrips(path.address, ECHO_PORT, 30)
    expect(connectMs).toBeGreaterThan(500)
    expect(median(roundTrips)).toBeGreaterThan(600)
  }, 90_000)
})

describe.runIf(runDocker)('impaired forwarding link (relay-shaped)', () => {
  let echoServer: net.Server
  let link: ImpairedNetworkLink

  beforeAll(async () => {
    echoServer = net.createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echoServer.listen(0, '0.0.0.0', resolve))
    const address = echoServer.address()
    if (address === null || typeof address === 'string') {
      throw new Error('echo server has no port')
    }
    link = startImpairedNetworkLink(process.cwd(), `host.docker.internal:${address.port}`)
  }, 400_000)

  afterAll(() => {
    stopImpairedNetwork(link)
    echoServer.close()
  })

  it('adds the configured delay in each direction and no more', async () => {
    shapeImpairedNetwork(link, symmetric({ delayMs: 100 }))
    const { roundTrips } = await measureRoundTrips('127.0.0.1', link.localPort, 40)
    expect(roundTrips).toHaveLength(40)
    expect(median(roundTrips)).toBeGreaterThan(195)
    expect(median(roundTrips)).toBeLessThan(260)
  }, 60_000)

  it('holds traffic through a cut and delivers it after the link returns', async () => {
    const shape = symmetric({ delayMs: 50 })
    shapeImpairedNetwork(link, shape)
    const measuring = measureRoundTrips('127.0.0.1', link.localPort, 60)
    await sleep(1_000)
    cutImpairedNetwork(link)
    await sleep(2_000)
    shapeImpairedNetwork(link, shape)
    const { roundTrips } = await measuring
    expect(roundTrips).toHaveLength(60)
    expect(roundTrips.at(-1)).toBeGreaterThan(2_000)
  }, 60_000)
})
