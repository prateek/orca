import { spawnSync } from 'node:child_process'

const extraArgs = process.argv.slice(2)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const env = {
  ...process.env,
  ORCA_E2E_REMOTE_ORCA_SERVERS: '1'
}

const cli = spawnSync(pnpm, ['run', 'build:cli'], {
  stdio: 'inherit',
  env
})

if (cli.status !== 0) {
  process.exit(cli.status ?? 1)
}

const runtime = spawnSync(pnpm, ['run', 'ensure:electron-runtime'], {
  stdio: 'inherit',
  env
})

if (runtime.status !== 0) {
  process.exit(runtime.status ?? 1)
}

const result = spawnSync(
  pnpm,
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/remote-orca-servers-multi-repo.property.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    ...extraArgs
  ],
  {
    stdio: 'inherit',
    env
  }
)

process.exit(result.status ?? 1)
