import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Reads the timing lines the phone app's latency probes print through Metro (`[lat] ...`).
 * Each line carries the phone's own clock, so Metro's delivery delay does not matter.
 */
export type PhoneProbeLog = {
  /** A position to read from later. */
  mark: () => number
  /** Probe lines written since `mark`, without the `[lat] ` prefix. */
  since: (mark: number) => string[]
}

const PROBE_TAG = '[lat] '

export function phoneProbeLog(metroLogPath: string): PhoneProbeLog {
  return {
    mark: () => statSync(metroLogPath).size,
    since: (mark) => {
      const file = openSync(metroLogPath, 'r')
      try {
        const length = fstatSync(file).size - mark
        if (length <= 0) {
          return []
        }
        const bytes = Buffer.alloc(length)
        readSync(file, bytes, 0, length, mark)
        return bytes
          .toString('utf8')
          .split('\n')
          .filter((line) => line.includes(PROBE_TAG))
          .map((line) => line.slice(line.indexOf(PROBE_TAG) + PROBE_TAG.length))
      } finally {
        closeSync(file)
      }
    }
  }
}
