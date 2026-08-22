/**
 * Prepare the fork-only package publish surface under .upstream-publish/.
 *
 * The pinned submodule declares its dependencies with pnpm `workspace:^`
 * ranges, which the product's Yarn workspace cannot resolve. This script
 * copies the fork-only packages (including their built lib/) and rewrites
 * every workspace range to a concrete version: @deepseek-ai/cordis* to the
 * versions the desktop plugin pins, @deepseek-ai/dsh-* to the recorded
 * runtime family. dsh-plugin-desktop references these copies through file:.
 *
 * Run after `upstream:build` (the submodule must have lib/ artifacts), and
 * before `yarn install` in CI.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, '.upstream-publish', 'packages')
const RUNTIME_VERSION = JSON.parse(readFileSync(join(ROOT, 'upstream.json'), 'utf8')).runtimePackageVersion

/** Fork-only package directory -> npm name. */
const FORK_ONLY = {
  'client/ui-aqua': 'dsh-client-ui-aqua',
  'client/ui-desktop-notify': 'dsh-client-ui-desktop-notify',
  'client/ui-settings-dev-checks': 'dsh-client-ui-settings-dev-checks',
  'client/ui-settings-mcp': 'dsh-client-ui-settings-mcp',
  'client/ui-settings-vision-model': 'dsh-client-ui-settings-vision-model',
  'llm/llm-vision-route': 'dsh-llm-vision-route',
  'mcp/mcp-servers': 'dsh-mcp-servers',
}

// Versions the product workspace pins for the rescoped Cordis ecosystem.
const pluginManifest = JSON.parse(readFileSync(join(ROOT, 'dsh-plugin-desktop', 'package.json'), 'utf8'))
const pluginDeps = { ...pluginManifest.dependencies, ...pluginManifest.devDependencies }

const cordisVersionOf = (name) => {
  const pinned = pluginDeps[name]
  if (pinned !== undefined) return pinned
  if (name === '@deepseek-ai/cordis') return '4.0.1'
  throw new Error(`prepare-upstream-publish: no pinned version for ${name} in dsh-plugin-desktop`)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const [dir, shortName] of Object.entries(FORK_ONLY)) {
  const src = join(ROOT, 'deepseek-harness', 'packages', dir)
  const manifestPath = join(src, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!existsSync(join(src, 'lib'))) {
    throw new Error(`prepare-upstream-publish: ${manifest.name} has no lib/ — run the upstream build first`)
  }
  const dst = join(OUT, dir)
  cpSync(src, dst, { recursive: true })
  const staged = JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8'))
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(staged[section] ?? {})) {
      if (!range.startsWith('workspace:')) continue
      staged[section][dep] = dep.startsWith('@deepseek-ai/dsh')
        ? RUNTIME_VERSION
        : cordisVersionOf(dep)
    }
  }
  writeFileSync(join(dst, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`)
  console.log(`prepare-upstream-publish: staged ${manifest.name} -> ${join('.upstream-publish', 'packages', dir)}`)
}

console.log(`prepare-upstream-publish: ${Object.keys(FORK_ONLY).length} fork-only package(s) staged under .upstream-publish/`)
