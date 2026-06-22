import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync, mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'

import type { Repo } from '../../../src/shared/types'
import { createLocalGitRepo } from './local-git-repo-fixture'
import { attachServerOutputDrains, cleanupStartedServer } from './remote-orca-server-process'

const SHARED_ORIGIN_URL = 'git@github.com:prateek/orca.git'
const SHARED_UPSTREAM_URL = 'git@github.com:stablyai/orca.git'
const SERVE_READY_TIMEOUT_MS = 60_000

export const REMOTE_ORCA_SHARED_PROJECT_ID = 'github:stablyai/orca'

export type RemoteOrcaRepoSeed = {
  slug: string
  sharedProject: boolean
}

export type RemoteScenarioRepo = Pick<Repo, 'id' | 'path' | 'displayName' | 'upstream'>

export type RemoteOrcaServerScenario = {
  key: 'server-a' | 'server-b'
  name: string
  child: ChildProcessWithoutNullStreams
  userDataPath: string
  reposRoot: string
  pairingCode: string
  runtimeId: string
  stdout: string
  stderr: string
  repos: RemoteScenarioRepo[]
  environmentId?: string
}

type ServeReadyMessage = {
  type: 'orca_server_ready'
  runtimeId: string
  pairing?: {
    url?: string
  }
}

function devCliPath(): string {
  return path.join(process.cwd(), 'out', 'cli', 'index.js')
}

function electronExecutablePath(): string {
  return process.platform === 'win32'
    ? path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(process.cwd(), 'node_modules', '.bin', 'electron')
}

function cleanServeEnv(userDataPath: string): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env
  void _unused
  return {
    ...env,
    ORCA_DEV_USER_DATA_PATH: userDataPath,
    ORCA_USER_DATA_PATH: userDataPath,
    ORCA_APP_EXECUTABLE: electronExecutablePath(),
    ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT: '1'
  }
}

function parseReadyLine(line: string): ServeReadyMessage | null {
  try {
    const parsed = JSON.parse(line) as Partial<ServeReadyMessage>
    return parsed.type === 'orca_server_ready' && typeof parsed.runtimeId === 'string'
      ? (parsed as ServeReadyMessage)
      : null
  } catch {
    return null
  }
}

async function waitForServeReady(
  scenario: Omit<RemoteOrcaServerScenario, 'pairingCode' | 'runtimeId'>
): Promise<ServeReadyMessage> {
  let stdoutOffset = 0
  let pendingStdoutLine = ''
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          [
            `Timed out waiting for ${scenario.name} to print orca_server_ready.`,
            scenario.stdout.trim() ? `stdout: ${scenario.stdout.trim()}` : null,
            scenario.stderr.trim() ? `stderr: ${scenario.stderr.trim()}` : null
          ]
            .filter(Boolean)
            .join(' ')
        )
      )
    }, SERVE_READY_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timeout)
      scenario.child.stdout.off('data', onStdout)
      scenario.child.off('exit', onExit)
      scenario.child.off('error', onError)
    }
    const scanStdout = (): void => {
      const chunk = scenario.stdout.slice(stdoutOffset)
      stdoutOffset = scenario.stdout.length
      pendingStdoutLine += chunk
      const lines = pendingStdoutLine.split(/\r?\n/)
      pendingStdoutLine = lines.pop() ?? ''
      for (const line of [...lines, pendingStdoutLine]) {
        const ready = parseReadyLine(line.trim())
        if (ready?.pairing?.url) {
          cleanup()
          resolve(ready)
          return
        }
      }
    }
    const onStdout = (): void => {
      scanStdout()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(
        new Error(
          [
            `${scenario.name} exited before ready: code=${code} signal=${signal}.`,
            scenario.stdout.trim() ? `stdout: ${scenario.stdout.trim()}` : null,
            scenario.stderr.trim() ? `stderr: ${scenario.stderr.trim()}` : null
          ]
            .filter(Boolean)
            .join(' ')
        )
      )
    }
    scenario.child.stdout.on('data', onStdout)
    scenario.child.once('error', onError)
    scenario.child.once('exit', onExit)
    scanStdout()
  })
}

export async function startRemoteOrcaServerScenario(args: {
  key: 'server-a' | 'server-b'
  name: string
}): Promise<RemoteOrcaServerScenario> {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), `orca-remote-server-${args.key}-`))
  const reposRoot = path.join(userDataPath, 'repos')
  mkdirSync(reposRoot, { recursive: true })
  const child = spawn(
    process.execPath,
    [devCliPath(), 'serve', '--json', '--port', '0', '--pairing-address', '127.0.0.1'],
    {
      env: cleanServeEnv(userDataPath),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const scenario = {
    key: args.key,
    name: args.name,
    child,
    userDataPath,
    reposRoot,
    stdout: '',
    stderr: '',
    repos: []
  }
  attachServerOutputDrains(scenario)
  let ready: ServeReadyMessage
  try {
    ready = await waitForServeReady(scenario)
  } catch (error) {
    try {
      await cleanupStartedServer(scenario)
    } catch (cleanupError) {
      console.warn(`Failed to clean up ${scenario.name} after startup error:`, cleanupError)
    }
    throw error
  }
  return {
    ...scenario,
    pairingCode: ready.pairing?.url ?? '',
    runtimeId: ready.runtimeId
  }
}

export function createRemoteServerGitRepo(
  scenario: RemoteOrcaServerScenario,
  seed: RemoteOrcaRepoSeed
): string {
  return createLocalGitRepo(scenario.reposRoot, seed.slug, {
    originUrl: seed.sharedProject ? SHARED_ORIGIN_URL : `git@github.com:prateek/${seed.slug}.git`,
    ...(seed.sharedProject ? { upstreamUrl: SHARED_UPSTREAM_URL } : {})
  })
}

export function rememberRemoteScenarioRepo(
  scenario: RemoteOrcaServerScenario,
  repo: RemoteScenarioRepo
): void {
  const index = scenario.repos.findIndex((entry) => entry.id === repo.id)
  if (index === -1) {
    scenario.repos.push(repo)
    return
  }
  scenario.repos[index] = repo
}

export function removeRemoteScenarioRepo(scenario: RemoteOrcaServerScenario, repoId: string): void {
  scenario.repos = scenario.repos.filter((entry) => entry.id !== repoId)
}

export async function stopRemoteOrcaServerScenario(
  scenario: RemoteOrcaServerScenario | null
): Promise<void> {
  if (!scenario) {
    return
  }
  await cleanupStartedServer(scenario)
}
