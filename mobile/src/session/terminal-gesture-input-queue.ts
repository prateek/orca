import type { TerminalGestureInputReport } from '../terminal/terminal-gesture-input'
import type {
  TerminalGestureInputQueue,
  TerminalGestureInputRun
} from './mobile-session-route-types'

export function appendTerminalGestureInput(
  queue: TerminalGestureInputQueue,
  reports: readonly TerminalGestureInputReport[],
  nowMs: number
): void {
  let run: TerminalGestureInputRun | undefined
  for (const report of reports) {
    if (run?.kind === report.kind) {
      run.bytes += report.bytes
      run.sequenceCount += 1
    } else {
      run = { kind: report.kind, bytes: report.bytes, sequenceCount: 1, queuedAtMs: nowMs }
      queue.runs.push(run)
    }
  }
}

/** Movement older than `maxAgeMs` would move the program long after the finger did; a click is never stale. */
export function dropStaleTerminalGestureMovement(
  queue: TerminalGestureInputQueue,
  nowMs: number,
  maxAgeMs: number
): void {
  queue.runs = queue.runs.filter(
    (run) => run.kind === 'click' || nowMs - run.queuedAtMs <= maxAgeMs
  )
}

export function hasQueuedTerminalGestureClick(queue: TerminalGestureInputQueue): boolean {
  return queue.runs.some((run) => run.kind === 'click')
}

export function queuedTerminalGestureSequenceCount(queue: TerminalGestureInputQueue): number {
  return queue.runs.reduce((total, run) => total + run.sequenceCount, 0)
}

export function queuedTerminalGestureBytes(queue: TerminalGestureInputQueue): string {
  return queue.runs.map((run) => run.bytes).join('')
}

/** Removes and returns the bytes of one send: whole runs from the front, in order, up to `maxSequences`. */
export function takeTerminalGestureInputBatch(
  queue: TerminalGestureInputQueue,
  maxSequences: number
): string {
  let bytes = ''
  let sequenceCount = 0
  while (queue.runs.length > 0) {
    const run = queue.runs[0]
    // Why: a run is never split, so one larger than the cap still goes out, alone.
    if (sequenceCount > 0 && sequenceCount + run.sequenceCount > maxSequences) {
      break
    }
    bytes += run.bytes
    sequenceCount += run.sequenceCount
    queue.runs.shift()
  }
  return bytes
}
