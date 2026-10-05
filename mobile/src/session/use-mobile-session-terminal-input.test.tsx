import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { resetWorkerTerminalTakeoverReportsForTest } from '../terminal/worker-terminal-takeover-report'
import {
  TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES,
  TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS
} from './mobile-session-route-helpers'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'

const HANDLE = 'terminal-1'
const REPORT_INTERVAL_MS = 10
const REPORT_COUNT = 150

/** One SGR wheel report whose column says which swipe step produced it. */
function wheelReport(step: number): string {
  return `\u001b[<64;${step + 1};1M`
}

function reportSteps(text: string): number[] {
  return [...text.matchAll(/<64;(\d+);1M/g)].map((match) => Number(match[1]) - 1)
}

describe('terminal gesture input sends', () => {
  let renderer: ReactTestRenderer | undefined
  let sends: { atMs: number; text: string }[]

  function mountGestureInput(ackDelayMs: number) {
    const client = {
      sendRequest: vi.fn(async (method: string, params?: unknown) => {
        if (method === 'terminal.send') {
          const text = typeof params === 'object' && params && 'text' in params ? params.text : ''
          sends.push({ atMs: Date.now(), text: String(text) })
          if (ackDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, ackDelayMs))
          }
        }
        return { id: 'rpc', ok: true as const, result: { send: { accepted: true } } }
      })
    }
    const scope = mountFixture<Parameters<typeof useMobileSessionTerminalInput>[0]>({
      client,
      connState: 'connected',
      activeHandle: HANDLE,
      clientRef: { current: client },
      connStateRef: { current: 'connected' },
      deviceTokenRef: { current: 'phone' },
      activeHandleRef: { current: HANDLE },
      activeSessionTabTypeRef: { current: 'terminal' },
      ptyModesRef: {
        current: new Map([
          [
            HANDLE,
            {
              bracketedPasteMode: false,
              altScreen: true,
              mouseTrackingMode: 'any',
              sgrMouseMode: true,
              sgrMousePixelsMode: false
            }
          ]
        ])
      },
      terminalGestureInputBucketsRef: { current: new Map() },
      terminalGestureInputQueuesRef: { current: new Map() },
      terminalGestureInputInFlightRef: { current: new Set() }
    })
    let input: ReturnType<typeof useMobileSessionTerminalInput> | undefined
    function Harness() {
      input = useMobileSessionTerminalInput(scope)
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    if (!input) {
      throw new Error('terminal input hook did not mount')
    }
    return input
  }

  /** A steady swipe: one wheel report every 10ms, then time for every send to settle. */
  async function swipe(input: ReturnType<typeof useMobileSessionTerminalInput>) {
    const queuedAtMs: number[] = []
    for (let step = 0; step < REPORT_COUNT; step++) {
      queuedAtMs.push(Date.now())
      await input.handleTerminalInput(HANDLE, wheelReport(step))
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS)
    }
    await vi.advanceTimersByTimeAsync(5_000)
    return queuedAtMs
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    sends = []
    resetWorkerTerminalTakeoverReportsForTest()
  })

  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = undefined
    vi.useRealTimers()
  })

  it('sends every report in order when the host answers at once', async () => {
    const input = mountGestureInput(0)

    await swipe(input)

    const sent = sends.flatMap((send) => reportSteps(send.text))
    expect(sent).toEqual(Array.from({ length: REPORT_COUNT }, (_, step) => step))
  })

  it('never sends a stale or oversized batch behind a slow answer', async () => {
    const input = mountGestureInput(900)

    const queuedAtMs = await swipe(input)

    expect(sends.length).toBeGreaterThan(1)
    for (const send of sends) {
      const steps = reportSteps(send.text)
      expect(steps.length).toBeLessThanOrEqual(TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES)
      const oldestAgeMs = Math.max(...steps.map((step) => send.atMs - queuedAtMs[step]))
      expect(oldestAgeMs).toBeLessThanOrEqual(TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS)
    }
  })
})
