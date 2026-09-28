#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '../..')
const allowedOptionalModules = new Set(['bufferutil', 'utf-8-validate'])

function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function verifyExternalImports(metafile) {
  const unsupported = new Set()
  for (const input of Object.values(metafile.inputs)) {
    for (const dependency of input.imports) {
      if (!dependency.external || isBuiltin(dependency.path)) {
        continue
      }
      const dependencyPackage = packageName(dependency.path)
      if (!allowedOptionalModules.has(dependencyPackage)) {
        unsupported.add(dependencyPackage)
      }
    }
  }
  if (unsupported.size > 0) {
    throw new Error(`CLI bundle has unbundled dependencies: ${[...unsupported].sort().join(', ')}`)
  }
}

export async function bundleCliEntry({ entryPath }) {
  const result = await build({
    entryPoints: [entryPath],
    outfile: entryPath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    metafile: true,
    legalComments: 'none',
    write: false
  })
  verifyExternalImports(result.metafile)
  const [output] = result.outputFiles
  if (!output) {
    throw new Error('CLI bundle produced no output')
  }
  await writeFile(entryPath, output.contents)
}

async function main() {
  await bundleCliEntry({ entryPath: join(root, 'out', 'cli', 'index.js') })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
