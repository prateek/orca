import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleCliEntry } from './bundle-cli-entry.mjs'

const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('CLI entry bundle', () => {
  it('includes local modules in the executable entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cli-bundle-'))
    directories.push(root)
    const entryPath = join(root, 'cli', 'index.js')
    mkdirSync(join(root, 'cli'), { recursive: true })
    writeFileSync(entryPath, "#!/usr/bin/env node\nrequire('./message.js')\n")
    writeFileSync(join(root, 'cli', 'message.js'), "process.stdout.write('bundled\\n')\n")

    await bundleCliEntry({ entryPath })

    const output = readFileSync(entryPath, 'utf8')
    rmSync(join(root, 'cli', 'message.js'))
    expect(output).toMatch(/^#!\/usr\/bin\/env node/)
    expect(output).not.toContain("require('./message.js')")
    expect(execFileSync(process.execPath, [entryPath], { encoding: 'utf8' })).toBe('bundled\n')
  })
})
