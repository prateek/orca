import {
  TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES,
  TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS
} from './mobile-session-route-helpers'
import type { TerminalGestureInputQueue } from './mobile-session-route-types'

export function createTerminalGestureInputQueue(): TerminalGestureInputQueue {
  return { chunks: [], timer: null }
}

export function appendTerminalGestureInput(
  queue: TerminalGestureInputQueue,
  bytes: string,
  sequenceCount: number,
  nowMs: number
): void {
  queue.chunks.push({ bytes, sequenceCount, queuedAtMs: nowMs })
}

export function countQueuedTerminalGestureSequences(queue: TerminalGestureInputQueue): number {
  return queue.chunks.reduce((total, chunk) => total + chunk.sequenceCount, 0)
}

export function queuedTerminalGestureInputBytes(queue: TerminalGestureInputQueue): string {
  return queue.chunks.map((chunk) => chunk.bytes).join('')
}

/**
 * Drops what a swipe no longer means: reports older than the freshness window, then the oldest
 * of the rest until the batch fits the cap.
 *
 * Why whole chunks: each is one validated run of complete control sequences, so dropping one can
 * never split an escape sequence. The newest chunk always survives the cap.
 */
export function pruneTerminalGestureInputQueue(
  queue: TerminalGestureInputQueue,
  nowMs: number
): void {
  let kept = queue.chunks.filter(
    (chunk) => nowMs - chunk.queuedAtMs <= TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS
  )
  let sequences = kept.reduce((total, chunk) => total + chunk.sequenceCount, 0)
  while (kept.length > 1 && sequences > TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES) {
    sequences -= kept[0].sequenceCount
    kept = kept.slice(1)
  }
  queue.chunks = kept
}
