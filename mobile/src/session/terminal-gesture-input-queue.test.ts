import { describe, expect, it } from 'vitest'
import {
  TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES,
  TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS
} from './mobile-session-route-helpers'
import {
  appendTerminalGestureInput,
  countQueuedTerminalGestureSequences,
  createTerminalGestureInputQueue,
  pruneTerminalGestureInputQueue,
  queuedTerminalGestureInputBytes
} from './terminal-gesture-input-queue'

const START_MS = 10_000

describe('terminal gesture input queue', () => {
  it('keeps fresh reports in the order they were queued', () => {
    const queue = createTerminalGestureInputQueue()
    appendTerminalGestureInput(queue, 'a', 1, START_MS)
    appendTerminalGestureInput(queue, 'bb', 2, START_MS + 10)

    pruneTerminalGestureInputQueue(queue, START_MS + 20)

    expect(queuedTerminalGestureInputBytes(queue)).toBe('abb')
    expect(countQueuedTerminalGestureSequences(queue)).toBe(3)
  })

  it('drops only the reports older than the freshness window', () => {
    const queue = createTerminalGestureInputQueue()
    appendTerminalGestureInput(queue, 'stale', 1, START_MS)
    appendTerminalGestureInput(queue, 'edge', 1, START_MS + 1)
    appendTerminalGestureInput(queue, 'fresh', 1, START_MS + 200)

    pruneTerminalGestureInputQueue(queue, START_MS + 1 + TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS)

    expect(queuedTerminalGestureInputBytes(queue)).toBe('edgefresh')
  })

  it('keeps the newest reports when a fresh batch is over the cap', () => {
    const queue = createTerminalGestureInputQueue()
    for (let i = 0; i < TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES + 5; i++) {
      appendTerminalGestureInput(queue, `<${i}>`, 1, START_MS + i)
    }

    pruneTerminalGestureInputQueue(queue, START_MS + 100)

    expect(countQueuedTerminalGestureSequences(queue)).toBe(
      TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES
    )
    expect(queuedTerminalGestureInputBytes(queue).startsWith('<5>')).toBe(true)
    expect(queuedTerminalGestureInputBytes(queue).endsWith('<36>')).toBe(true)
  })

  it('drops a whole chunk rather than part of one to fit the cap', () => {
    const queue = createTerminalGestureInputQueue()
    appendTerminalGestureInput(queue, 'older', 20, START_MS)
    appendTerminalGestureInput(queue, 'newer', 20, START_MS + 10)

    pruneTerminalGestureInputQueue(queue, START_MS + 20)

    expect(queuedTerminalGestureInputBytes(queue)).toBe('newer')
  })

  it('never empties the queue to fit the cap', () => {
    const queue = createTerminalGestureInputQueue()
    appendTerminalGestureInput(
      queue,
      'oversized',
      TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES + 1,
      START_MS
    )

    pruneTerminalGestureInputQueue(queue, START_MS)

    expect(queuedTerminalGestureInputBytes(queue)).toBe('oversized')
  })
})
