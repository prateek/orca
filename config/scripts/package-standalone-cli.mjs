#!/usr/bin/env node

import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { create as createTar } from 'tar'

const root = resolve(import.meta.dirname, '../..')

export async function createStandaloneCliArchive({
  entryPath,
  launcherPath,
  licensePath,
  outputDirectory,
  version
}) {
  const stage = await mkdtemp(join(tmpdir(), 'orca-cli-package-'))
  const cliDirectory = join(stage, 'lib', 'orca-cli', 'cli')
  const archivePath = join(outputDirectory, `orca-cli-${version}.tgz`)
  try {
    await mkdir(join(stage, 'bin'), { recursive: true })
    await mkdir(cliDirectory, { recursive: true })
    await mkdir(join(stage, 'share', 'doc', 'orca-cli'), { recursive: true })
    await mkdir(outputDirectory, { recursive: true })

    await copyFile(entryPath, join(cliDirectory, 'index.js'))
    await copyFile(
      join(dirname(entryPath), '..', 'package.json'),
      join(stage, 'lib', 'orca-cli', 'package.json')
    )
    await copyFile(launcherPath, join(stage, 'bin', 'orca'))
    await copyFile(licensePath, join(stage, 'share', 'doc', 'orca-cli', 'LICENSE'))
    await chmod(join(stage, 'bin', 'orca'), 0o755)
    await chmod(join(cliDirectory, 'index.js'), 0o755)

    await createTar.asyncFile(
      {
        cwd: stage,
        file: archivePath,
        gzip: true,
        portable: true,
        noMtime: true,
        strict: true
      },
      ['bin', 'lib', 'share']
    )
    return archivePath
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function main() {
  const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const compiledPackage = JSON.parse(await readFile(join(root, 'out', 'package.json'), 'utf8'))
  if (compiledPackage.version !== sourcePackage.version) {
    throw new Error(
      `Compiled CLI version ${compiledPackage.version ?? '<missing>'} does not match package version ${sourcePackage.version}`
    )
  }
  const archivePath = await createStandaloneCliArchive({
    entryPath: join(root, 'out', 'cli', 'index.js'),
    launcherPath: join(root, 'resources', 'cli', 'bin', 'orca'),
    licensePath: join(root, 'LICENSE'),
    outputDirectory: join(root, 'dist'),
    version: sourcePackage.version
  })
  const latestPath = join(dirname(archivePath), 'orca-cli.tgz')
  await copyFile(archivePath, latestPath)
  process.stdout.write(`${archivePath}\n${latestPath}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
