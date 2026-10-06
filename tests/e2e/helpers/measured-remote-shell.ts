import { randomInt } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { focusActiveTerminalInput } from './terminal'
import { readTerminalScreen } from './terminal-echo-probe'

/**
 * A bash prompt set up so a test can tell what the shell showed from what it received.
 *
 * The prompt carries the shell's pid, so a shell that was replaced during a network cut shows a
 * different prompt. A typed token is submitted as a command name: bash answers "<token>: command
 * not found", which is the far side's own record of the bytes that reached it.
 */
export type MeasuredShell = {
  /** Includes the trailing space. */
  prompt: string
  pid: string
}

export type SubmittedLine = {
  /** What the screen showed after the prompt before Enter. */
  displayed: string
  /** What bash reported receiving. Null if neither an answer nor a prompt came back in time. */
  received: string | null
}

const PROMPT_LINE = /^O(\d+)>$/
const PID_LINE = /^pid=(\d+)$/
const COMMAND_NOT_FOUND = /^(?:-?bash: )(?:line \d+: )?(.*): command not found$/
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Starts with letters no command begins with, and has no spaces. */
export function randomShellToken(length: number): string {
  let token = 'zq'
  while (token.length < length) {
    token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]
  }
  return token
}

async function waitForScreen(
  page: Page,
  accept: (lines: string[]) => boolean,
  timeoutMs: number
): Promise<string[] | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lines = (await readTerminalScreen(page))?.lines ?? []
    if (accept(lines)) {
      return lines
    }
    if (Date.now() >= deadline) {
      return null
    }
    await sleep(100)
  }
}

/**
 * Proves the shell still answers: a screen frozen on a prompt looks exactly like a cleared one.
 * Leaves the line empty. False means nothing came back in time.
 */
async function proveShellAlive(page: Page, timeoutMs: number): Promise<boolean> {
  const nonce = randomShellToken(12)
  await focusActiveTerminalInput(page)
  await page.keyboard.press('Control+c')
  // Why the leading spaces: a terminal that has just opened has been seen to drop the first key.
  await page.keyboard.type(`  echo ${nonce}`)
  await page.keyboard.press('Enter')
  const lines = await waitForScreen(page, (screen) => screen.includes(nonce), timeoutMs)
  return lines !== null
}

/** Null means the shell did not answer in time, which the caller treats as a lost connection. */
export async function prepareMeasuredShell(
  page: Page,
  timeoutMs: number
): Promise<MeasuredShell | null> {
  const deadline = Date.now() + timeoutMs
  // Why two attempts: a terminal that has just opened has been seen to drop keys.
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
    if (!(await proveShellAlive(page, deadline - Date.now()))) {
      return null
    }
    // Why the leading space: keeps the setup line out of shell history on hosts that honour it.
    await page.keyboard.type(" PS1='O$$> ';clear")
    await page.keyboard.press('Enter')
    const lines = await waitForScreen(
      page,
      (screen) => screen.length === 1 && PROMPT_LINE.test(screen[0]),
      Math.min(15_000, deadline - Date.now())
    )
    const pid = lines ? PROMPT_LINE.exec(lines[0])?.[1] : undefined
    if (pid) {
      return { prompt: `O${pid}> `, pid }
    }
  }
  return null
}

/**
 * Asks whichever shell is behind the pane for its pid. Null means nothing answered in time, so
 * the caller cannot say which shell, if any, is there. A prompt left on screen is not evidence.
 */
export async function readShellPid(page: Page, timeoutMs: number): Promise<string | null> {
  await focusActiveTerminalInput(page)
  await page.keyboard.type(' echo pid=$$')
  await page.keyboard.press('Enter')
  const lines = await waitForScreen(
    page,
    (screen) => screen.some((l) => PID_LINE.test(l)),
    timeoutMs
  )
  return lines?.flatMap((line) => PID_LINE.exec(line)?.[1] ?? []).at(-1) ?? null
}

/** Leaves the prompt alone on the first row. False means the shell did not answer in time. */
export async function clearMeasuredShell(
  page: Page,
  shell: MeasuredShell,
  timeoutMs: number
): Promise<boolean> {
  if (!(await proveShellAlive(page, timeoutMs))) {
    return false
  }
  await page.keyboard.type('clear')
  await page.keyboard.press('Enter')
  const lines = await waitForScreen(
    page,
    (screen) => screen.length === 1 && screen[0] === shell.prompt.trimEnd(),
    timeoutMs
  )
  return lines !== null
}

/** Presses Enter on the typed token and reads bash's answer. Expects a cleared screen. */
export async function submitTypedToken(
  page: Page,
  shell: MeasuredShell,
  timeoutMs: number
): Promise<SubmittedLine> {
  const before = (await readTerminalScreen(page))?.lines ?? []
  const first = before[0] ?? ''
  const bare = shell.prompt.trimEnd()
  const displayed = first.startsWith(bare) ? first.slice(bare.length).trimStart() : first
  await page.keyboard.press('Enter')
  // Why wait for the next prompt: it is what shows which shell answered.
  const answered = (screen: string[]): boolean =>
    screen.length > 1 && PROMPT_LINE.test(screen.at(-1) ?? '')
  const lines = await waitForScreen(page, answered, timeoutMs)
  if (!lines) {
    return { displayed, received: null }
  }
  const answer = lines.map((line) => COMMAND_NOT_FOUND.exec(line)?.[1]).find((match) => match)
  return { displayed, received: answer ?? '' }
}

/** Characters of `sent` missing from `got`, and characters of `got` that `sent` does not explain. */
export function compareTypedText(sent: string, got: string): { lost: number; duplicated: number } {
  const previous = Array.from({ length: got.length + 1 }, () => 0)
  for (let i = 1; i <= sent.length; i += 1) {
    let diagonal = 0
    for (let j = 1; j <= got.length; j += 1) {
      const above = previous[j]
      previous[j] =
        sent[i - 1] === got[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1])
      diagonal = above
    }
  }
  const common = previous[got.length]
  return { lost: sent.length - common, duplicated: got.length - common }
}
