import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cutImpairedNetworkLink,
  netemArguments,
  shapeImpairedNetworkLink,
  startImpairedNetworkLink,
  stopImpairedNetworkLink,
  type ImpairedNetworkLink,
  type NetworkLinkShape
} from './helpers/impaired-network-link'

const runDocker = process.env.ORCA_RUN_DOCKER_NETWORK_LINK_E2E === '1'

const symmetric = (direction: NetworkLinkShape['uplink']): NetworkLinkShape => ({
  uplink: direction,
  downlink: direction
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Sends one line every 50ms through the link to an echo server; resolves with sorted round trips. */
async function measureRoundTrips(port: number, count: number): Promise<number[]> {
  const socket = net.connect(port, '127.0.0.1')
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
  const deadline = Date.now() + 20_000
  while (roundTrips.length < count && Date.now() < deadline) {
    await sleep(50)
  }
  socket.destroy()
  return roundTrips.sort((a, b) => a - b)
}

const median = (sorted: number[]): number => sorted[Math.floor(sorted.length / 2)]

describe('impaired network link arguments', () => {
  it('writes delay, jitter, bursty loss, rate and queue as netem arguments', () => {
    expect(
      netemArguments({
        delayMs: 150,
        jitterMs: 30,
        loss: { kind: 'bursty', enterBadPercent: 1, leaveBadPercent: 20, lossInBadPercent: 80 },
        rateKbit: 2000,
        queuePackets: 200
      }).join(' ')
    ).toBe(
      'delay 150ms 30ms distribution normal loss gemodel 1% 20% 80% 0% rate 2000kbit limit 200'
    )
  })
})

describe.runIf(runDocker)('impaired network link over Docker', () => {
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
    stopImpairedNetworkLink(link)
    echoServer.close()
  })

  it('adds the configured delay in each direction and no more', async () => {
    shapeImpairedNetworkLink(link, symmetric({ delayMs: 100 }))
    const roundTrips = await measureRoundTrips(link.localPort, 40)
    expect(roundTrips).toHaveLength(40)
    expect(median(roundTrips)).toBeGreaterThan(195)
    expect(median(roundTrips)).toBeLessThan(260)
  }, 60_000)

  it('turns packet loss into late delivery, never missing bytes', async () => {
    shapeImpairedNetworkLink(
      link,
      symmetric({ delayMs: 50, loss: { kind: 'random', percent: 10 } })
    )
    const roundTrips = await measureRoundTrips(link.localPort, 80)
    expect(roundTrips).toHaveLength(80)
    // A retransmission costs at least one retransmission timeout on top of the 100ms round trip.
    expect(roundTrips.at(-1)).toBeGreaterThan(250)
  }, 60_000)

  it('holds traffic through a cut and delivers it after the link returns', async () => {
    const shape = symmetric({ delayMs: 50 })
    shapeImpairedNetworkLink(link, shape)
    const measuring = measureRoundTrips(link.localPort, 60)
    await sleep(1_000)
    cutImpairedNetworkLink(link)
    await sleep(2_000)
    shapeImpairedNetworkLink(link, shape)
    const roundTrips = await measuring
    expect(roundTrips).toHaveLength(60)
    expect(roundTrips.at(-1)).toBeGreaterThan(2_000)
  }, 60_000)
})
