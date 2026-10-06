import type { Page } from '@stablyai/playwright-test'
import { resolveActiveTabId } from './terminal-pane-identity'

/** Times are the renderer's `performance.now()`, so no cross-process work sits inside a sample. */
export type TerminalEchoSample = {
  index: number
  keyAtMs: number
  /** xterm finished parsing the output that shows this character. Null if it never appeared. */
  parsedAtMs: number | null
  /** First paint after that parse. Null if it never appeared or the renderer did not paint. */
  renderedAtMs: number | null
}

export type TerminalOutputBurstTiming = {
  /** The Enter keydown that submitted the command. */
  startedAtMs: number | null
  parsedAtMs: number | null
  renderedAtMs: number | null
}

export type TerminalEchoProbeReport = {
  samples: TerminalEchoSample[]
  burst: TerminalOutputBurstTiming
  renderEvents: number
  nowMs: number
  /** The pane was remounted after the probe attached, so the probe no longer sees its output. */
  paneReplaced: boolean
}

export type TerminalEchoProbeOptions = {
  /** Text that precedes the typed characters on screen; it makes a short prefix unambiguous. */
  prompt: string
  /** The characters that will be typed, in order. Must not contain spaces: rows are trimmed. */
  target: string
  /** A line that appears on its own once the output burst has finished. */
  burstMarker?: string
}

export type TerminalScreen = {
  /** Live screen lines with wrapped rows rejoined and trailing whitespace removed. */
  lines: string[]
  ptyId: string | null
  cols: number
  rows: number
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __terminalEchoProbe?: {
      report(): TerminalEchoProbeReport
      dispose(): void
    }
  }
}

/**
 * Records, inside the renderer, when each typed character is echoed on the active terminal pane.
 * A sample completes when the screen shows the prompt followed by everything typed up to and
 * including that character, so lost, duplicated or reordered input leaves later samples open.
 */
export async function installTerminalEchoProbe(
  page: Page,
  options: TerminalEchoProbeOptions
): Promise<void> {
  const tabId = await resolveActiveTabId(page)
  await page.evaluate(
    ({ prompt, target, burstMarker, tabId }) => {
      // Why by tab id: a remounted or replaced pane under the same tab no longer holds `terminal`.
      const activePane = () => {
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        return manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      }
      window.__terminalEchoProbe?.dispose()
      const pane = activePane()
      if (!pane) {
        throw new Error('Terminal echo probe: no active terminal pane')
      }
      const terminal = pane.terminal
      const samples: TerminalEchoSample[] = []
      const pending: TerminalEchoSample[] = []
      const awaitingRender: TerminalEchoSample[] = []
      const burst: TerminalOutputBurstTiming = {
        startedAtMs: null,
        parsedAtMs: null,
        renderedAtMs: null
      }
      let renderEvents = 0

      // Why no separator: a wrapped line splits across rows and trimmed rows rejoin at the break.
      // Why baseY: the live screen, whether or not the viewport is scrolled up into history.
      const screenText = (): string => {
        const buffer = terminal.buffer.active
        let text = ''
        for (let row = 0; row < terminal.rows; row += 1) {
          text += buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
        }
        return text
      }
      const burstFinished = (): boolean => {
        const buffer = terminal.buffer.active
        const last = buffer.baseY + buffer.cursorY
        for (let row = last; row >= Math.max(0, last - 6); row -= 1) {
          if (buffer.getLine(row)?.translateToString(true) === burstMarker) {
            return true
          }
        }
        return false
      }

      const parsed = terminal.onWriteParsed(() => {
        const now = performance.now()
        if (pending.length > 0) {
          const text = screenText()
          // Why in order: one parse can land several queued characters at once.
          while (
            pending.length > 0 &&
            text.includes(prompt + target.slice(0, pending[0].index + 1))
          ) {
            const sample = pending.shift()
            if (sample) {
              sample.parsedAtMs = now
              awaitingRender.push(sample)
            }
          }
        }
        if (burstMarker && burst.startedAtMs !== null && burst.parsedAtMs === null) {
          if (burstFinished()) {
            burst.parsedAtMs = now
          }
        }
      })
      const rendered = terminal.onRender(() => {
        renderEvents += 1
        const now = performance.now()
        for (const sample of awaitingRender.splice(0)) {
          sample.renderedAtMs = now
        }
        if (burst.parsedAtMs !== null && burst.renderedAtMs === null) {
          burst.renderedAtMs = now
        }
      })
      // Why window capture: it runs before xterm's own handler forwards the key to the PTY.
      const onKeyDown = (event: KeyboardEvent): void => {
        const now = performance.now()
        if (event.key === 'Enter') {
          if (burstMarker && burst.startedAtMs === null) {
            burst.startedAtMs = now
          }
          return
        }
        if (event.key.length !== 1 || samples.length >= target.length) {
          return
        }
        const sample = { index: samples.length, keyAtMs: now, parsedAtMs: null, renderedAtMs: null }
        samples.push(sample)
        pending.push(sample)
      }
      window.addEventListener('keydown', onKeyDown, { capture: true })

      window.__terminalEchoProbe = {
        report: () => ({
          samples: samples.map((sample) => ({ ...sample })),
          burst: { ...burst },
          renderEvents,
          nowMs: performance.now(),
          paneReplaced: activePane()?.terminal !== terminal
        }),
        dispose: () => {
          window.removeEventListener('keydown', onKeyDown, { capture: true })
          parsed.dispose()
          rendered.dispose()
        }
      }
    },
    { ...options, tabId }
  )
}

export async function readTerminalEchoProbe(page: Page): Promise<TerminalEchoProbeReport> {
  return page.evaluate(() => {
    const probe = window.__terminalEchoProbe
    if (!probe) {
      throw new Error('Terminal echo probe was never installed')
    }
    return probe.report()
  })
}

export async function rendererNowMs(page: Page): Promise<number> {
  return page.evaluate(() => performance.now())
}

/** Reads the active pane's screen fresh each call, so it follows a remounted pane. */
export async function readTerminalScreen(page: Page): Promise<TerminalScreen | null> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    return null
  }
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return null
    }
    const buffer = pane.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < pane.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row)
      const text = line?.translateToString(true) ?? ''
      if (line?.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text
      } else {
        lines.push(text)
      }
    }
    // Why trim again: a space the shell printed, such as the one ending a prompt, is kept above.
    const trimmed = lines.map((line) => line.trimEnd())
    while (trimmed.length > 0 && trimmed.at(-1) === '') {
      trimmed.pop()
    }
    return {
      lines: trimmed,
      ptyId: pane.container.dataset.ptyId ?? null,
      cols: pane.terminal.cols,
      rows: pane.terminal.rows
    }
  }, tabId)
}
