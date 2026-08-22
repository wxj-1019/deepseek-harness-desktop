/**
 * Sync the pinned upstream (deepseek-harness submodule) and the DSH runtime
 * package family to a target commit/version, then verify the layout.
 *
 * Usage:
 *   node scripts/sync-upstream.mjs                     # sync to the fork remote master
 *   node scripts/sync-upstream.mjs <commit>            # sync to an explicit commit
 *   node scripts/sync-upstream.mjs <commit> <runtime>  # pin the npm runtime family explicitly
 *
 * The runtime family version is read from the npm registry (@deepseek-ai/dsh)
 * unless given explicitly. Patch CONTENT is not adapted here: `yarn install`
 * reports which patches no longer apply, and each one then needs a manual
 * re-record (yarn patch) or retirement.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const run = (command, args, cwd = root, opts = {}) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...opts,
}).trim()
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const writeJson = (path, value) => writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`)

const upstreamPath = 'upstream.json'
const upstream = readJson(upstreamPath)
const upstreamDir = resolve(root, 'deepseek-harness')

// 1. Resolve the target commit: argument, or the fork remote master.
let target = process.argv[2]
if (target === undefined) {
  run('git', ['fetch', 'origin', 'master'], upstreamDir)
  target = run('git', ['rev-parse', 'origin/master'], upstreamDir)
}
run('git', ['fetch', 'origin'], upstreamDir)
run('git', ['checkout', '--detach', target], upstreamDir)
// Record the new commit in the parent index: verify-layout reads the gitlink.
run('git', ['add', 'deepseek-harness'], root)

// 2. Resolve the runtime family version: argument, or the npm latest.
const runtime = process.argv[3] ?? run('npm', ['view', '@deepseek-ai/dsh', 'version'])
const source = readJson('deepseek-harness/package.json').version

// 3. Rewrite the manifests.
upstream.commit = target
upstream.sourceVersion = source
upstream.runtimePackageVersion = runtime
writeJson(upstreamPath, upstream)

for (const manifestPath of ['dsh-plugin-desktop/package.json', 'dsh-community-market/package.json']) {
  const manifest = readJson(manifestPath)
  let changed = false
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/dsh') {
        manifest[section][name] = runtime
        changed = true
      }
    }
  }
  if (changed) writeJson(manifestPath, manifest)
}

// 4. Rewrite the root resolutions patch family: package version and the
//    versioned patch file names.
const rootManifest = readJson('package.json')
const resolutions = rootManifest.resolutions ?? {}
let resolutionsChanged = false
for (const [name, spec] of Object.entries(resolutions)) {
  if (!name.startsWith('@deepseek-ai/dsh')) continue
  // The resolution key may carry a range prefix (`@npm:^0.1.0-rc.7`), while
  // the encoded spec URL and the patch file name use the bare version.
  const match = /^@deepseek-ai\/(dsh-[^@]+)@npm:(\^)?(.+)$/.exec(name)
  if (match === null) continue
  const [, pkg, caret, oldVersion] = match
  const newName = `@deepseek-ai/${pkg}@npm:${caret ?? ''}${runtime}`
  if (newName === name) continue
  const newSpec = spec.replace(`@npm%3A${oldVersion}`, `@npm%3A${runtime}`)
    .replace(`#./patches/${pkg}@${oldVersion}.patch`, `#./patches/${pkg}@${runtime}.patch`)
  delete resolutions[name]
  resolutions[newName] = newSpec
  resolutionsChanged = true
  const oldPatch = resolve(root, `patches/${pkg}@${oldVersion}.patch`)
  const newPatch = resolve(root, `patches/${pkg}@${runtime}.patch`)
  if (existsSync(oldPatch) && !existsSync(newPatch)) {
    renameSync(oldPatch, newPatch)
    console.log(`patches: renamed ${pkg}@${oldVersion}.patch -> ${pkg}@${runtime}.patch`)
  }
}
if (resolutionsChanged) writeJson('package.json', rootManifest)

// 5. Verify the layout; report what still needs manual work.
run('node', ['scripts/verify-layout.mjs'], root)
console.log(`sync-upstream: pinned ${target.slice(0, 10)} (source ${source}, runtime ${runtime}) — layout verified`)
console.log('sync-upstream: run `yarn install` next; patches that no longer apply must be re-recorded manually')
