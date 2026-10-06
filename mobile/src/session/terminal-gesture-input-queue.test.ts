import { describe, expect, it } from 'vitest'
import { splitTerminalGestureInput } from '../terminal/terminal-gesture-input'
import type { TerminalGestureInputQueue } from './mobile-session-route-types'
import {
  appendTerminalGestureInput,
  dropStaleTerminalGestureMovement,
  hasQueuedTerminalGestureClick,
  queuedTerminalGestureBytes,
  queuedTerminalGestureSequenceCount,
  takeTerminalGestureInputBatch
} from './terminal-gesture-input-queue'

const WHEEL_UP = '\x1b[<64;10;5M'
const PRESS = '\x1b[<0;10;5M'
const RELEASE = '\x1b[<0;10;5m'

function queueOf(...arrivals: [bytes: string, atMs: number][]): TerminalGestureInputQueue {
  const queue: TerminalGestureInputQueue = { runs: [], timer: null }
  for (const [bytes, atMs] of arrivals) {
    appendTerminalGestureInput(queue, splitTerminalGestureInput(bytes) ?? [], atMs)
  }
  return queue
}

describe('terminal gesture input queue', () => {
  it('keeps reports in the order they arrived', () => {
    const queue = queueOf([WHEEL_UP.repeat(2), 0], [PRESS + RELEASE, 10], [WHEEL_UP, 20])

    expect(queuedTerminalGestureSequenceCount(queue)).toBe(5)
    expect(queuedTerminalGestureBytes(queue)).toBe(WHEEL_UP.repeat(2) + PRESS + RELEASE + WHEEL_UP)
  })

  it('drops movement older than the limit and keeps the click queued with it', () => {
    const queue = queueOf([WHEEL_UP.repeat(3), 0], [PRESS + RELEASE, 10], [WHEEL_UP, 300])

    dropStaleTerminalGestureMovement(queue, 500, 250)

    expect(queuedTerminalGestureBytes(queue)).toBe(PRESS + RELEASE + WHEEL_UP)
    expect(hasQueuedTerminalGestureClick(queue)).toBe(true)
  })

  it('keeps movement exactly at the limit', () => {
    const queue = queueOf([WHEEL_UP, 0])

    dropStaleTerminalGestureMovement(queue, 250, 250)

    expect(queuedTerminalGestureSequenceCount(queue)).toBe(1)
  })

  it('takes whole runs from the front up to the cap and leaves the rest queued', () => {
    const queue = queueOf([WHEEL_UP.repeat(3), 0], [PRESS + RELEASE, 10], [WHEEL_UP.repeat(2), 20])

    expect(takeTerminalGestureInputBatch(queue, 5)).toBe(WHEEL_UP.repeat(3) + PRESS + RELEASE)
    expect(queuedTerminalGestureBytes(queue)).toBe(WHEEL_UP.repeat(2))
  })

  it('sends a run larger than the cap on its own instead of splitting or stranding it', () => {
    const queue = queueOf([WHEEL_UP.repeat(4), 0], [PRESS, 10])

    expect(takeTerminalGestureInputBatch(queue, 2)).toBe(WHEEL_UP.repeat(4))
    expect(takeTerminalGestureInputBatch(queue, 2)).toBe(PRESS)
    expect(queue.runs).toEqual([])
  })
})
