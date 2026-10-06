import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { summarizeLatencies } from '../codex-composer-echo-latency-probe'
import { shapeImpairedNetwork, UNSHAPED } from './impaired-network-link'
import {
  measureBurst,
  measureCut,
  measureTyping,
  TYPED_CHARACTERS,
  TYPING_CADENCE_MS,
  type BurstMeasurement,
  type CutMeasurement,
  type ImpairedTerminalSession,
  type TypingMeasurement
} from './impaired-terminal-latency-scenarios'
import { summarizeImpairedLatencyRuns } from './impaired-terminal-latency-report'
import { clearMeasuredShell, prepareMeasuredShell, randomShellToken } from './measured-remote-shell'
import {
  applyNetworkTravelProfile,
  NETWORK_TRAVEL_PROFILES,
  type NetworkTravelProfile
} from './network-travel-profiles'
import { focusActiveTerminalInput } from './terminal'
import { installTerminalEchoProbe, readTerminalEchoProbe } from './terminal-echo-probe'

export type TravelProfileKey = keyof typeof NETWORK_TRAVEL_PROFILES

/**
 * How the shell was found before the next scenario could start: it answered within 30 s, within
 * 90 s, a different shell pid answered, or the test had to reconnect and open a new terminal.
 */
export type ShellRecovery = 'ready' | 'slow' | 'shell-replaced' | 'reopened-by-test'

export type ImpairedLatencyRun = {
  spec: string
  run: number
  profile: string
  startedAt: string
  wallMs: number
  /** Timed outages of the profile's own schedule that fell inside typing or the burst. */
  outagesDuringTyping: { startedAtMs: number; endedAtMs: number }[]
  typing: TypingMeasurement
  burst: BurstMeasurement
  cut: CutMeasurement
  afterCut: ShellRecovery
  /** Only for profiles that define timed outages. */
  outage?: CutMeasurement
  afterOutage?: ShellRecovery
  context: Record<string, string | number | null>
}

export type ImpairedLatencyMatrixOptions = {
  spec: string
  outputDir: string
  runs: number
  profiles: TravelProfileKey[]
  /** Keep earlier results in the output file and skip the (run, profile) pairs they cover. */
  resume: boolean
  /** Constant facts about the topology, repeated on every line. */
  context: Record<string, string | number | null>
  /**
   * What a person does with a dead terminal: reconnect and open a new terminal tab. Gets the pid
   * of the shell that stopped answering, so the topology can report whether it is still alive.
   * Without it a dead shell ends the matrix; `ORCA_E2E_IMPAIRED_RESUME=1` continues it.
   */
  reopenTerminal?: (deadShellPid: string) => Promise<void>
}

const FORCED_CUT_MS = 8_000

function isTravelProfileKey(value: string): value is TravelProfileKey {
  return Object.hasOwn(NETWORK_TRAVEL_PROFILES, value)
}

/**
 * `ORCA_E2E_IMPAIRED_RUNS`, `_PROFILES` (comma-separated keys), `_OUTPUT_DIR`, and `_RESUME=1` to
 * keep the results already in the output file and measure only what is missing.
 */
export function readImpairedLatencyMatrixSettings(
  env: NodeJS.ProcessEnv,
  defaultOutputDir: string
): Pick<ImpairedLatencyMatrixOptions, 'runs' | 'profiles' | 'outputDir' | 'resume'> {
  const requested = env.ORCA_E2E_IMPAIRED_PROFILES?.split(',').map((name) => name.trim())
  const profiles = requested?.filter(isTravelProfileKey)
  if (requested && profiles?.length !== requested.length) {
    throw new Error(`Unknown travel profile in ORCA_E2E_IMPAIRED_PROFILES: ${requested.join(',')}`)
  }
  const runs = Number(env.ORCA_E2E_IMPAIRED_RUNS ?? 10)
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(`ORCA_E2E_IMPAIRED_RUNS must be a positive integer: ${runs}`)
  }
  return {
    runs,
    profiles: profiles ?? Object.keys(NETWORK_TRAVEL_PROFILES).filter(isTravelProfileKey),
    outputDir: env.ORCA_E2E_IMPAIRED_OUTPUT_DIR ?? defaultOutputDir,
    resume: env.ORCA_E2E_IMPAIRED_RESUME === '1'
  }
}

export type OutageSettings = {
  /** The link's shape before and after the cut. */
  profile: NetworkTravelProfile
  cutMs: number
  runs: number
}

/**
 * For the outage reproductions: `ORCA_E2E_OUTAGE_PROFILE` (a travel profile key, or `unshaped`),
 * `ORCA_E2E_OUTAGE_MS` and `ORCA_E2E_OUTAGE_RUNS`, each falling back to the given default.
 */
export function readOutageSettings(
  env: NodeJS.ProcessEnv,
  defaults: { profile: TravelProfileKey | 'unshaped'; cutMs: number; runs: number }
): OutageSettings {
  const key = env.ORCA_E2E_OUTAGE_PROFILE ?? defaults.profile
  if (key !== 'unshaped' && !isTravelProfileKey(key)) {
    throw new Error(`Unknown travel profile in ORCA_E2E_OUTAGE_PROFILE: ${key}`)
  }
  const profile: NetworkTravelProfile =
    key === 'unshaped'
      ? { name: 'unshaped', describes: 'No impairment', shape: UNSHAPED, basis: 'None.' }
      : NETWORK_TRAVEL_PROFILES[key]
  const cutMs = Number(env.ORCA_E2E_OUTAGE_MS ?? defaults.cutMs)
  const runs = Number(env.ORCA_E2E_OUTAGE_RUNS ?? defaults.runs)
  if (!Number.isInteger(cutMs) || cutMs <= 0 || !Number.isInteger(runs) || runs <= 0) {
    throw new Error(`ORCA_E2E_OUTAGE_MS and ORCA_E2E_OUTAGE_RUNS must be positive integers`)
  }
  return { profile, cutMs, runs }
}

function readPreviousRuns(resultsPath: string): ImpairedLatencyRun[] {
  if (!existsSync(resultsPath)) {
    return []
  }
  return readFileSync(resultsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): ImpairedLatencyRun => JSON.parse(line))
}

async function recoverShell(
  session: ImpairedTerminalSession,
  reopenTerminal: ImpairedLatencyMatrixOptions['reopenTerminal']
): Promise<ShellRecovery> {
  if (await clearMeasuredShell(session.page, session.shell, 30_000)) {
    return 'ready'
  }
  let shell = await prepareMeasuredShell(session.page, 60_000)
  let recovery: ShellRecovery = shell?.pid === session.shell.pid ? 'slow' : 'shell-replaced'
  if (!shell) {
    if (!reopenTerminal) {
      throw new Error(
        `Shell ${session.shell.pid} stopped answering and this topology cannot reopen`
      )
    }
    await reopenTerminal(session.shell.pid)
    shell = await prepareMeasuredShell(session.page, 120_000)
    recovery = 'reopened-by-test'
  }
  if (!shell) {
    throw new Error('The remote shell did not answer, even in a new terminal after reconnecting')
  }
  session.shell = shell
  return recovery
}

/** Median echo time for keys typed one at a time, each waiting for its own echo. */
async function sequentialEchoMedianMs(session: ImpairedTerminalSession): Promise<number> {
  const { page, shell } = session
  const token = randomShellToken(10)
  await installTerminalEchoProbe(page, { prompt: shell.prompt, target: token })
  await focusActiveTerminalInput(page)
  for (let index = 0; index < token.length; index += 1) {
    await page.keyboard.type(token[index])
    const deadline = Date.now() + 30_000
    while ((await readTerminalEchoProbe(page)).samples[index]?.parsedAtMs == null) {
      if (Date.now() > deadline) {
        throw new Error(`Typed character ${index} was not echoed within 30s`)
      }
    }
  }
  const { samples } = await readTerminalEchoProbe(page)
  return summarizeLatencies(
    samples.flatMap((sample) =>
      sample.parsedAtMs === null ? [] : [sample.parsedAtMs - sample.keyAtMs]
    )
  ).p50
}

/**
 * Proves the app's connection really crosses the shaped path: 300 ms each way must add at least
 * 600 ms to an echo. A connection that reached the container some other way would add nothing.
 */
export async function measureAddedEchoDelay(
  session: ImpairedTerminalSession
): Promise<{ baselineMs: number; delayedMs: number }> {
  shapeImpairedNetwork(session.network, UNSHAPED)
  await clearMeasuredShell(session.page, session.shell, 30_000)
  const baselineMs = await sequentialEchoMedianMs(session)
  shapeImpairedNetwork(session.network, { uplink: { delayMs: 300 }, downlink: { delayMs: 300 } })
  await clearMeasuredShell(session.page, session.shell, 30_000)
  const delayedMs = await sequentialEchoMedianMs(session)
  shapeImpairedNetwork(session.network, UNSHAPED)
  return { baselineMs, delayedMs }
}

async function measureProfile(
  session: ImpairedTerminalSession,
  profile: NetworkTravelProfile,
  options: ImpairedLatencyMatrixOptions,
  run: number
): Promise<ImpairedLatencyRun> {
  const started = Date.now()
  const outagesDuringTyping: ImpairedLatencyRun['outagesDuringTyping'] = []
  const stopOutages = applyNetworkTravelProfile(
    session.network,
    profile,
    (startedAtMs, endedAtMs) => outagesDuringTyping.push({ startedAtMs, endedAtMs })
  )
  let typing: TypingMeasurement
  let burst: BurstMeasurement
  try {
    await recoverShell(session, options.reopenTerminal)
    typing = await measureTyping(session)
    await recoverShell(session, options.reopenTerminal)
    burst = await measureBurst(session)
  } finally {
    // Why before the cut: a scheduled restore would end the forced cut early.
    await stopOutages()
  }
  await recoverShell(session, options.reopenTerminal)
  const cut = await measureCut(session, profile, { kind: 'forced', cutMs: FORCED_CUT_MS })
  const afterCut = await recoverShell(session, options.reopenTerminal)
  const outage = profile.outages
    ? await measureCut(session, profile, {
        kind: 'scheduled',
        forSeconds: profile.outages.forSeconds
      })
    : undefined
  const afterOutage = outage ? await recoverShell(session, options.reopenTerminal) : undefined
  return {
    spec: options.spec,
    run,
    profile: profile.name,
    startedAt: new Date(started).toISOString(),
    wallMs: Date.now() - started,
    outagesDuringTyping,
    typing,
    burst,
    cut,
    afterCut,
    ...(outage ? { outage, afterOutage } : {}),
    context: {
      typedChars: TYPED_CHARACTERS,
      typingCadenceMs: TYPING_CADENCE_MS,
      ...options.context
    }
  }
}

/**
 * Runs every profile once per round, so slow drift in the machine or the app spreads across all
 * profiles instead of landing on whichever ran last. Each result is appended as it is measured.
 */
export async function runImpairedLatencyMatrix(
  session: ImpairedTerminalSession,
  options: ImpairedLatencyMatrixOptions
): Promise<ImpairedLatencyRun[]> {
  mkdirSync(options.outputDir, { recursive: true })
  const resultsPath = path.join(options.outputDir, `${options.spec}.jsonl`)
  const results = options.resume ? readPreviousRuns(resultsPath) : []
  if (!options.resume) {
    writeFileSync(resultsPath, '')
  }
  const done = new Set(results.map((result) => `${result.run} ${result.profile}`))
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      for (const key of options.profiles) {
        if (done.has(`${run} ${NETWORK_TRAVEL_PROFILES[key].name}`)) {
          continue
        }
        const result = await measureProfile(session, NETWORK_TRAVEL_PROFILES[key], options, run)
        results.push(result)
        appendFileSync(resultsPath, `${JSON.stringify(result)}\n`)
        console.log(
          `[${options.spec}] run ${run} ${result.profile}: echo p50=${result.typing.parse.p50.toFixed(0)}ms ` +
            `p95=${result.typing.parse.p95.toFixed(0)}ms burst=${result.burst.parseMs?.toFixed(0) ?? 'never'}ms ` +
            `cut first echo=${result.cut.firstEchoAfterRestoreMs?.toFixed(0) ?? 'never'}ms ` +
            `after cut=${result.afterCut} wall=${(result.wallMs / 1000).toFixed(1)}s`
        )
      }
    }
  } finally {
    writeFileSync(
      path.join(options.outputDir, `${options.spec}.md`),
      summarizeImpairedLatencyRuns(options.spec, results)
    )
  }
  return results
}
