import type { Page } from '@stablyai/playwright-test'
import { summarizeLatencies, type LatencyDistribution } from '../codex-composer-echo-latency-probe'
import {
  cutImpairedNetwork,
  scheduleNetworkOutages,
  shapeImpairedNetwork,
  type ImpairedContainerNetwork
} from './impaired-network-link'
import type { NetworkTravelProfile } from './network-travel-profiles'
import {
  compareTypedText,
  randomShellToken,
  readShellPid,
  sleep,
  submitTypedToken,
  type MeasuredShell
} from './measured-remote-shell'
import {
  remoteConnectionChanges,
  sampleRemoteConnection,
  type RemoteConnectionChange,
  type RemoteConnectionSample,
  type RemoteConnectionSource
} from './remote-connection-observation'
import { focusActiveTerminalInput } from './terminal'
import {
  installTerminalEchoProbe,
  readTerminalEchoProbe,
  readTerminalScreen,
  rendererNowMs,
  type TerminalEchoProbeReport
} from './terminal-echo-probe'

/** One app, one connection and one remote shell, measured across many network conditions. */
export type ImpairedTerminalSession = {
  page: Page
  network: ImpairedContainerNetwork
  connection: RemoteConnectionSource
  shell: MeasuredShell
}

export type TypedTextCheck = {
  typed: number
  echoed: number
  displayed: string
  /** Null when the shell did not answer, so loss could not be judged. */
  lost: number | null
  duplicated: number | null
}

export type TypingMeasurement = TypedTextCheck & {
  /** Keydown to the echo being parsed by the terminal. */
  parse: LatencyDistribution
  /** Keydown to the first paint after that parse. Empty when the hidden window did not paint. */
  render: LatencyDistribution
}

export type BurstMeasurement = {
  lines: number
  /** Enter to the last line being parsed. Null if the burst never finished. */
  parseMs: number | null
  renderMs: number | null
}

export type CutPlan =
  | { kind: 'forced'; cutMs: number }
  /** One outage of the profile's own length, started soon so a run does not wait a full cycle. */
  | { kind: 'scheduled'; forSeconds: number }

export type CutMeasurement = TypedTextCheck & {
  kind: CutPlan['kind']
  /** Null when a scheduled outage never happened. */
  cutMs: number | null
  typedDuringCut: number
  /** Changes in what the app showed, timed from the start of the cut. */
  connection: RemoteConnectionChange[]
  firstEchoAfterRestoreMs: number | null
  /** Restore until everything typed had been echoed. Null if some of it never was. */
  allEchoedAfterRestoreMs: number | null
  samePty: boolean
  /** The shell asked for its pid after the cut gave the same one. Null when nothing answered. */
  sameShell: boolean | null
  paneReplaced: boolean
}

export const TYPED_CHARACTERS = 40
export const TYPING_CADENCE_MS = 100
const BURST_LINES = 20_000

export async function typeAtCadence(page: Page, text: string, cadenceMs: number): Promise<void> {
  for (const char of text) {
    const started = Date.now()
    await page.keyboard.type(char)
    await sleep(Math.max(0, cadenceMs - (Date.now() - started)))
  }
}

/** Returns once `count` characters are echoed, or once no new echo has arrived for `stallMs`. */
async function waitForEchoes(
  page: Page,
  count: number,
  stallMs: number
): Promise<TerminalEchoProbeReport> {
  let echoed = -1
  let lastProgress = Date.now()
  for (;;) {
    const report = await readTerminalEchoProbe(page)
    const now = report.samples.filter((sample) => sample.parsedAtMs !== null).length
    if (now >= count || report.paneReplaced) {
      return report
    }
    if (now !== echoed) {
      echoed = now
      lastProgress = Date.now()
    } else if (Date.now() - lastProgress > stallMs) {
      return report
    }
    await sleep(100)
  }
}

function elapsed(from: number, to: number | null): number[] {
  return to === null ? [] : [to - from]
}

async function checkTypedText(
  session: ImpairedTerminalSession,
  sent: string,
  report: TerminalEchoProbeReport,
  answerTimeoutMs: number
): Promise<TypedTextCheck> {
  const submitted = await submitTypedToken(session.page, session.shell, answerTimeoutMs)
  const compared = submitted.received === null ? null : compareTypedText(sent, submitted.received)
  return {
    typed: sent.length,
    echoed: report.samples.filter((sample) => sample.parsedAtMs !== null).length,
    displayed: submitted.displayed,
    lost: compared?.lost ?? null,
    duplicated: compared?.duplicated ?? null
  }
}

/** Types into the shell prompt at a steady pace. Expects a cleared screen. */
export async function measureTyping(session: ImpairedTerminalSession): Promise<TypingMeasurement> {
  const { page, shell } = session
  const token = randomShellToken(TYPED_CHARACTERS)
  await installTerminalEchoProbe(page, { prompt: shell.prompt, target: token })
  await focusActiveTerminalInput(page)
  await typeAtCadence(page, token, TYPING_CADENCE_MS)
  const report = await waitForEchoes(page, token.length, 30_000)
  const check = await checkTypedText(session, token, report, 30_000)
  return {
    ...check,
    parse: summarizeLatencies(
      report.samples.flatMap((sample) => elapsed(sample.keyAtMs, sample.parsedAtMs))
    ),
    render: summarizeLatencies(
      report.samples.flatMap((sample) => elapsed(sample.keyAtMs, sample.renderedAtMs))
    )
  }
}

/** Times a burst of output from Enter to its last line. Expects a cleared screen. */
export async function measureBurst(session: ImpairedTerminalSession): Promise<BurstMeasurement> {
  const { page, shell } = session
  // Why split quotes: the typed command must not contain the marker its own output ends with.
  await installTerminalEchoProbe(page, {
    prompt: shell.prompt,
    target: '',
    burstMarker: `END${shell.pid}`
  })
  await focusActiveTerminalInput(page)
  await page.keyboard.type(`seq 1 ${BURST_LINES};echo E""ND$$`)
  await page.keyboard.press('Enter')
  const deadline = Date.now() + 180_000
  let report = await readTerminalEchoProbe(page)
  while (report.burst.parsedAtMs === null && Date.now() < deadline) {
    await sleep(50)
    report = await readTerminalEchoProbe(page)
  }
  if (report.burst.parsedAtMs !== null && report.burst.renderedAtMs === null) {
    await sleep(300)
    report = await readTerminalEchoProbe(page)
  }
  const { startedAtMs, parsedAtMs, renderedAtMs } = report.burst
  return {
    lines: BURST_LINES,
    parseMs: startedAtMs === null || parsedAtMs === null ? null : parsedAtMs - startedAtMs,
    renderMs: startedAtMs === null || renderedAtMs === null ? null : renderedAtMs - startedAtMs
  }
}

/**
 * Types before, during and after a cut and records what the app showed meanwhile. Expects a
 * cleared screen and leaves the path shaped as `profile`.
 */
export async function measureCut(
  session: ImpairedTerminalSession,
  profile: NetworkTravelProfile,
  plan: CutPlan
): Promise<CutMeasurement> {
  const { page, network, shell } = session
  const token = randomShellToken(70)
  const ptyBefore = (await readTerminalScreen(page))?.ptyId ?? null
  await installTerminalEchoProbe(page, { prompt: shell.prompt, target: token })
  await focusActiveTerminalInput(page)
  // Renderer clock minus this process's clock, so cut times can be placed among echo times.
  const clockOffsetMs = (await rendererNowMs(page)) - Date.now()

  const samples: RemoteConnectionSample[] = []
  let sampling = true
  const sampler = (async (): Promise<void> => {
    while (sampling) {
      samples.push(await sampleRemoteConnection(page, session.connection))
      await sleep(400)
    }
  })()

  let typed = 0
  const type = async (count: number, cadenceMs: number): Promise<void> => {
    await typeAtCadence(page, token.slice(typed, typed + count), cadenceMs)
    typed += count
  }
  let cutAt: number | null = null
  let restoredAt: number | null = null
  let typedDuringCut = 0
  try {
    if (plan.kind === 'forced') {
      await type(8, 150)
      cutImpairedNetwork(network)
      cutAt = Date.now()
      typedDuringCut = 16
      await type(typedDuringCut, (plan.cutMs - 800) / typedDuringCut)
      await sleep(Math.max(0, cutAt + plan.cutMs - Date.now()))
      shapeImpairedNetwork(network, profile.shape)
      restoredAt = Date.now()
    } else {
      const cadenceMs = Math.min(1_000, Math.max(150, (plan.forSeconds * 1_000) / 30))
      const stop = scheduleNetworkOutages(
        network,
        profile.shape,
        { everySeconds: 2, forSeconds: plan.forSeconds },
        (startedAtMs, endedAtMs) => {
          cutAt ??= startedAtMs
          restoredAt ??= endedAtMs
        }
      )
      try {
        while (restoredAt === null && typed < token.length - 8) {
          await type(1, cadenceMs)
        }
      } finally {
        await stop()
      }
      typedDuringCut =
        cutAt === null || restoredAt === null ? 0 : Math.floor((restoredAt - cutAt) / cadenceMs)
    }
    await type(8, 150)
    const report = await waitForEchoes(page, typed, 120_000)
    sampling = false
    await sampler

    const restoredAtRendererMs = restoredAt === null ? null : restoredAt + clockOffsetMs
    const echoesAfterRestore = report.samples.flatMap((sample) =>
      restoredAtRendererMs !== null &&
      sample.parsedAtMs !== null &&
      sample.parsedAtMs > restoredAtRendererMs
        ? [sample.parsedAtMs - restoredAtRendererMs]
        : []
    )
    const allEchoed = report.samples.every((sample) => sample.parsedAtMs !== null)
    const check = await checkTypedText(session, token.slice(0, typed), report, 60_000)
    const after = await readTerminalScreen(page)
    const pidAfter = check.lost === null ? null : await readShellPid(page, 30_000)
    return {
      ...check,
      kind: plan.kind,
      cutMs: cutAt === null || restoredAt === null ? null : restoredAt - cutAt,
      typedDuringCut,
      connection: remoteConnectionChanges(samples, (cutAt ?? Date.now()) + clockOffsetMs),
      firstEchoAfterRestoreMs:
        echoesAfterRestore.length > 0 ? Math.min(...echoesAfterRestore) : null,
      allEchoedAfterRestoreMs:
        allEchoed && echoesAfterRestore.length > 0 ? Math.max(...echoesAfterRestore) : null,
      samePty: after?.ptyId === ptyBefore,
      sameShell: pidAfter === null ? null : pidAfter === shell.pid,
      paneReplaced: report.paneReplaced
    }
  } finally {
    sampling = false
    await sampler.catch(() => undefined)
  }
}
