import { execFileSync } from 'node:child_process'

/** Runs `docker` with `args` and returns its trimmed stdout; throws on a non-zero exit. */
export function docker(args: string[], timeoutMs = 30_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs
  }).trim()
}
