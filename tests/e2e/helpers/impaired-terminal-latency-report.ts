import type { CutMeasurement } from './impaired-terminal-latency-scenarios'
import type { ImpairedLatencyRun } from './impaired-terminal-latency-matrix'

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** "median (min–max)" across runs, in whole milliseconds. */
function spread(values: (number | null)[]): string {
  const present = values.flatMap((value) => (value === null ? [] : [value]))
  const middle = median(present)
  if (middle === null) {
    return 'never'
  }
  const missing = values.length - present.length
  const range = `${Math.min(...present).toFixed(0)}–${Math.max(...present).toFixed(0)}`
  return `${middle.toFixed(0)} (${range})${missing > 0 ? `, never in ${missing}` : ''}`
}

function sum(values: (number | null)[]): string {
  const unknown = values.filter((value) => value === null).length
  const total = values.reduce<number>((all, value) => all + (value ?? 0), 0)
  return unknown > 0 ? `${total} (+${unknown} runs unknown)` : String(total)
}

/** A distribution with no samples has no latency, not a latency of zero. */
function measured(distribution: { count: number }, value: number): number | null {
  return distribution.count === 0 ? null : value
}

function row(cells: (string | number)[]): string {
  return `| ${cells.join(' | ')} |`
}

function table(header: string[], rows: (string | number)[][]): string {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
}

function byProfile(runs: ImpairedLatencyRun[]): Map<string, ImpairedLatencyRun[]> {
  const grouped = new Map<string, ImpairedLatencyRun[]>()
  for (const run of runs) {
    grouped.set(run.profile, [...(grouped.get(run.profile) ?? []), run])
  }
  return grouped
}

function cutRow(profile: string, cuts: CutMeasurement[], recoveries: string[]): string[] {
  // Why lost can be unknown: once the terminal had to be reopened, the old shell cannot answer.
  const states = new Set(cuts.flatMap((cut) => cut.connection.map((change) => change.state)))
  const notices = new Set(cuts.flatMap((cut) => cut.connection.flatMap((change) => change.notices)))
  const same = cuts.filter((cut) => cut.sameShell === true && cut.samePty).length
  const unknown = cuts.filter((cut) => cut.sameShell === null).length
  return [
    profile,
    spread(cuts.map((cut) => cut.cutMs)),
    [...states].join(', '),
    notices.size > 0 ? [...notices].join('; ') : 'none',
    spread(cuts.map((cut) => cut.firstEchoAfterRestoreMs)),
    spread(cuts.map((cut) => cut.allEchoedAfterRestoreMs)),
    `${sum(cuts.map((cut) => cut.echoed))}/${sum(cuts.map((cut) => cut.typed))}`,
    sum(cuts.map((cut) => cut.lost)),
    sum(cuts.map((cut) => cut.duplicated)),
    `${same}/${cuts.length}${unknown > 0 ? `, no shell answered in ${unknown}` : ''}`,
    [...new Set(recoveries)].join(', ')
  ]
}

const CUT_HEADER = [
  'profile',
  'cut ms',
  'connection states shown',
  'problem text on screen',
  'first echo after restore ms',
  'all typed text echoed after restore ms',
  'chars echoed/typed',
  'chars lost',
  'chars duplicated',
  'same shell and PTY after',
  'shell before next step'
]

/** Markdown tables: one row per profile, each cell the median across runs with min–max. */
export function summarizeImpairedLatencyRuns(spec: string, runs: ImpairedLatencyRun[]): string {
  const grouped = [...byProfile(runs)]
  const latency = table(
    [
      'profile',
      'runs',
      'chars echoed/typed',
      'echo p50 ms',
      'echo p95 ms',
      'echo max ms',
      'typed chars lost',
      'typed chars duplicated',
      `burst of ${runs[0]?.burst.lines ?? 0} lines ms`,
      'wall s per run'
    ],
    grouped.map(([profile, results]) => [
      profile,
      results.length,
      `${sum(results.map((result) => result.typing.echoed))}/${sum(results.map((result) => result.typing.typed))}`,
      spread(results.map((result) => measured(result.typing.parse, result.typing.parse.p50))),
      spread(results.map((result) => measured(result.typing.parse, result.typing.parse.p95))),
      spread(results.map((result) => measured(result.typing.parse, result.typing.parse.max))),
      sum(results.map((result) => result.typing.lost)),
      sum(results.map((result) => result.typing.duplicated)),
      spread(results.map((result) => result.burst.parseMs)),
      spread(results.map((result) => result.wallMs / 1000))
    ])
  )
  const forced = table(
    CUT_HEADER,
    grouped.map(([profile, results]) =>
      cutRow(
        profile,
        results.map((result) => result.cut),
        results.map((result) => result.afterCut)
      )
    )
  )
  const withOutages = grouped.filter(([, results]) => results.some((result) => result.outage))
  const scheduled = table(
    CUT_HEADER,
    withOutages.map(([profile, results]) =>
      cutRow(
        profile,
        results.flatMap((result) => (result.outage ? [result.outage] : [])),
        results.flatMap((result) => (result.afterOutage ? [result.afterOutage] : []))
      )
    )
  )
  return [
    `# ${spec}`,
    '',
    'Each cell is the median across runs with (min–max). Times are keydown to the terminal parsing the echo, measured in the renderer.',
    '"never in N" counts runs where the event did not happen at all. "+N runs unknown" counts runs where the shell could not be asked what it received, usually because the terminal had to be reopened. "same shell and PTY after" counts runs where the shell, asked for its pid after the cut, gave the pid it had before; a shell that never answered is counted separately.',
    '"shell before next step": ready = the shell answered within 30 s; slow = it answered within 90 s; shell-replaced = a different shell pid answered; reopened-by-test = the test reconnected and opened a new terminal tab.',
    '',
    '## Typing and output burst',
    '',
    latency,
    '',
    '## Forced cut',
    '',
    forced,
    '',
    "## The profile's own timed outage",
    '',
    scheduled,
    ''
  ].join('\n')
}
