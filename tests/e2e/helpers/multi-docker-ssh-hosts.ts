/**
 * Spin up multiple independent Docker SSH hosts for multi-server E2E tests.
 *
 * Mirrors the single-host helper (docker-ssh-relay-target.ts) but is built to run
 * several hosts at once: each gets its own key, container, and mapped port, and
 * the slow `apt-get install` steps overlap because every container is launched
 * with `docker run -d` before any `waitForSsh` poll begins. Repos are seeded by
 * name so a test can place the *same* project on two different servers and prove
 * Orca keeps them distinct.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { TestInfo } from '@stablyai/playwright-test'

export type DockerSshHost = {
  label: string
  containerName: string
  identityFile: string
  port: number
  tempDir: string
}

const CONTAINER_IMAGE = process.env.ORCA_E2E_SSH_DOCKER_IMAGE ?? 'node:22-bookworm'

function run(command: string, args: string[], opts: { timeoutMs?: number } = {}): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? 30_000
  }).trim()
}

function tryRun(command: string, args: string[], opts: { timeoutMs?: number } = {}): void {
  spawnSync(command, args, { stdio: 'ignore', timeout: opts.timeoutMs ?? 10_000 })
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function dockerExec(host: DockerSshHost, command: string): string {
  return run('docker', ['exec', host.containerName, 'bash', '-lc', command], { timeoutMs: 60_000 })
}

function sshArgs(host: DockerSshHost, command: string): string[] {
  return [
    '-i',
    host.identityFile,
    '-p',
    String(host.port),
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'BatchMode=yes',
    'root@127.0.0.1',
    command
  ]
}

function sleep(ms: number): void {
  // Why: a blocking sleep keeps the helper synchronous like its single-host
  // sibling; the e2e worker has nothing else to do while a container boots.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitForSsh(host: DockerSshHost): void {
  const deadline = Date.now() + 120_000
  let lastError = ''
  while (Date.now() < deadline) {
    const result = spawnSync('ssh', sshArgs(host, 'true'), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000
    })
    if (result.status === 0) {
      return
    }
    lastError = result.stderr || result.stdout || `exit ${result.status}`
    sleep(1_000)
  }
  throw new Error(`Timed out waiting for Docker SSH host ${host.label}: ${lastError}`)
}

function launchContainer(testInfo: TestInfo, index: number, label: string): DockerSshHost {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `orca-multi-ssh-${index}-`))
  const identityFile = path.join(tempDir, 'id_ed25519')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-multi-ssh-${testInfo.workerIndex}-${index}-${Date.now()}`

  tryRun('docker', ['rm', '-f', containerName])
  run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containerName,
      '-p',
      '127.0.0.1::22',
      '-e',
      `AUTHORIZED_KEY=${publicKey}`,
      CONTAINER_IMAGE,
      'bash',
      '-lc',
      [
        'apt-get update >/tmp/apt-update.log',
        'DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server git >/tmp/apt-install.log',
        'mkdir -p /run/sshd /root/.ssh',
        'chmod 700 /root/.ssh',
        'printf "%s\\n" "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys',
        'chmod 600 /root/.ssh/authorized_keys',
        'git config --global user.email e2e@test.local',
        'git config --global user.name "Orca Multi SSH E2E"',
        'exec /usr/sbin/sshd -D -e'
      ].join(' && ')
    ],
    { timeoutMs: 120_000 }
  )

  const port = Number(run('docker', ['port', containerName, '22/tcp']).split(':').at(-1))
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Unable to read mapped SSH port for ${containerName}`)
  }
  return { label, containerName, identityFile, port, tempDir }
}

/** Seed a git repo at `repoPath` on the host, with a one-line README so the
 *  remote checkout has a real commit. Safe to call for several repos per host. */
export function seedRepoOnHost(host: DockerSshHost, repoPath: string, readmeLine: string): void {
  dockerExec(
    host,
    [
      `rm -rf ${shellQuote(repoPath)}`,
      `mkdir -p ${shellQuote(repoPath)}`,
      `cd ${shellQuote(repoPath)}`,
      'git init',
      'git config user.email e2e@test.local',
      'git config user.name "Orca Multi SSH E2E"',
      `printf ${shellQuote(`${readmeLine}\n`)} > README.md`,
      'git add README.md',
      'git commit -m initial'
    ].join(' && ')
  )
}

/**
 * Launch `count` Docker SSH hosts concurrently (containers start detached, so the
 * apt installs overlap) and return them once all accept SSH. On any failure every
 * started container is cleaned up before rethrowing.
 */
export function startDockerSshHosts(testInfo: TestInfo, count: number): DockerSshHost[] {
  const hosts: DockerSshHost[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      hosts.push(launchContainer(testInfo, index, String.fromCharCode(66 + index))) // 'B', 'C', ...
    }
    for (const host of hosts) {
      waitForSsh(host)
    }
    return hosts
  } catch (error) {
    cleanupDockerSshHosts(hosts)
    throw error
  }
}

export function cleanupDockerSshHosts(hosts: readonly DockerSshHost[] | null): void {
  if (!hosts) {
    return
  }
  for (const host of hosts) {
    tryRun('docker', ['rm', '-f', host.containerName], { timeoutMs: 20_000 })
    rmSync(host.tempDir, { recursive: true, force: true })
  }
}
