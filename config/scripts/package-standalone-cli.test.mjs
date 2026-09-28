import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { t as listTar, x as extractTar } from 'tar'
import { createStandaloneCliArchive } from './package-standalone-cli.mjs'

const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(name) {
  const directory = mkdtempSync(join(tmpdir(), name))
  directories.push(directory)
  return directory
}

describe('standalone CLI archive', () => {
  it('installs under a prefix and runs with only Node', async () => {
    const fixture = temporaryDirectory('orca-cli-fixture-')
    const output = temporaryDirectory('orca-cli-output-')
    const install = temporaryDirectory('orca-cli-install-')
    const entryPath = join(fixture, 'out', 'cli', 'index.js')
    mkdirSync(dirname(entryPath), { recursive: true })
    writeFileSync(
      entryPath,
      "#!/usr/bin/env node\nconst fs = require('node:fs')\nconst path = require('node:path')\nconst metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))\nprocess.stdout.write(metadata.version + '\\n')\n"
    )
    const archive = await createStandaloneCliArchive({
      entryPath,
      launcherPath: resolve('resources/cli/bin/orca'),
      licensePath: resolve('LICENSE'),
      outputDirectory: output,
      version: '1.2.3'
    })

    const entries = []
    await listTar({ file: archive, onentry: (entry) => entries.push(entry.path) })
    expect(entries).toEqual(
      expect.arrayContaining([
        'bin/orca',
        'lib/orca-cli/cli/index.js',
        'lib/orca-cli/package.json',
        'share/doc/orca-cli/LICENSE'
      ])
    )
    expect(entries.some((entry) => entry.includes('node_modules') || entry.endsWith('.node'))).toBe(
      false
    )

    await extractTar({ file: archive, cwd: install, strict: true })
    expect(execFileSync(join(install, 'bin', 'orca'), { encoding: 'utf8' })).toBe('1.2.3\n')
    expect(
      JSON.parse(readFileSync(join(install, 'lib', 'orca-cli', 'package.json'), 'utf8'))
    ).toMatchObject({ version: '1.2.3', engines: { node: '>=22' } })
  })
})
