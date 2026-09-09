/**
 * Rebuild Electron-ABI native modules that the desktop runtime loads.
 *
 * `yarn install` compiles native modules against the system Node ABI, while
 * the packaged app runs under Electron; electron-builder skips rebuilding
 * (`npmRebuild=false`) because the other native modules ship prebuilds. The
 * fork's session persistence needs fs-ext, so rebuild just that module
 * against the installed Electron headers before packaging.
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(packageRoot, 'package.json'))

const electronVersion = JSON.parse(
  require('fs').readFileSync(require.resolve('electron/package.json'), 'utf8'),
).version
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js')
const modules = ['fs-ext']

for (const name of modules) {
  const moduleDir = join(packageRoot, 'node_modules', name)
  const result = spawnSync(
    process.execPath,
    // nopt forwards space-separated values to gyp as positional build files;
    // the `=` form keeps the version an option value.
    [
      nodeGyp,
      'rebuild',
      `--target=${electronVersion}`,
      `--arch=${process.arch}`,
      '--dist-url=https://electronjs.org/headers',
    ],
    { cwd: moduleDir, env: process.env, stdio: 'inherit' },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`rebuild-electron-native: ${name} exited with ${String(result.status)}`)
  }
  console.log(`rebuild-electron-native: ${name} rebuilt against Electron ${electronVersion}`)
}
