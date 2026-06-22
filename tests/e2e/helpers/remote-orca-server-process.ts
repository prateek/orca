import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { rmSync } from 'fs'

const SERVE_STOP_TIMEOUT_MS = 5_000
const SERVER_OUTPUT_TAIL_LIMIT = 64_000

export type RemoteOrcaServerProcessScenario = {
  name: string
  child: ChildProcessWithoutNullStreams
  userDataPath: string
  stdout: string
  stderr: string
}

const serverOutputDrains = new WeakMap<
  ChildProcessWithoutNullStreams,
  { onStdout: (chunk: Buffer) => void; onStderr: (chunk: Buffer) => void }
>()

export function attachServerOutputDrains(scenario: RemoteOrcaServerProcessScenario): void {
  const onStdout = (chunk: Buffer): void => {
    scenario.stdout = appendOutputTail(scenario.stdout, chunk)
  }
  const onStderr = (chunk: Buffer): void => {
    scenario.stderr = appendOutputTail(scenario.stderr, chunk)
  }
  scenario.child.stdout.on('data', onStdout)
  scenario.child.stderr.on('data', onStderr)
  serverOutputDrains.set(scenario.child, { onStdout, onStderr })
}

export async function cleanupStartedServer(
  scenario: RemoteOrcaServerProcessScenario
): Promise<void> {
  try {
    await stopServerProcess(scenario)
  } finally {
    detachServerOutputDrains(scenario)
    rmSync(scenario.userDataPath, { recursive: true, force: true })
  }
}

async function stopServerProcess(scenario: RemoteOrcaServerProcessScenario): Promise<void> {
  if (hasServerExited(scenario.child)) {
    return
  }
  await requestServerStop(scenario.child)
  if (await waitForServerExit(scenario.child, SERVE_STOP_TIMEOUT_MS)) {
    return
  }
  await forceKillServerProcessTree(scenario.child)
  if (!(await waitForServerExit(scenario.child, SERVE_STOP_TIMEOUT_MS))) {
    throw new Error(`Timed out stopping ${scenario.name}.`)
  }
}

function detachServerOutputDrains(scenario: RemoteOrcaServerProcessScenario): void {
  const drains = serverOutputDrains.get(scenario.child)
  if (!drains) {
    return
  }
  scenario.child.stdout.off('data', drains.onStdout)
  scenario.child.stderr.off('data', drains.onStderr)
  serverOutputDrains.delete(scenario.child)
}

async function requestServerStop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === 'win32') {
    await taskkillServerProcessTree(child, false)
    return
  }
  signalServerProcessTree(child, 'SIGTERM')
}

function signalServerProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void {
  if (!child.pid) {
    child.kill(signal)
    return
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the wrapper process if process groups are unavailable.
    }
  }
  child.kill(signal)
}

async function forceKillServerProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform !== 'win32') {
    signalServerProcessTree(child, 'SIGKILL')
    return
  }
  await taskkillServerProcessTree(child, true)
}

async function taskkillServerProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean
): Promise<void> {
  if (!child.pid) {
    child.kill(force ? 'SIGKILL' : 'SIGTERM')
    return
  }
  const args = ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])]
  await new Promise<void>((resolve) => {
    const taskkill = spawn('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true
    })
    taskkill.once('exit', () => resolve())
    taskkill.once('error', () => resolve())
  })
}

async function waitForServerExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (hasServerExited(child)) {
    return true
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

function hasServerExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function appendOutputTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString()
  return next.length > SERVER_OUTPUT_TAIL_LIMIT ? next.slice(-SERVER_OUTPUT_TAIL_LIMIT) : next
}
