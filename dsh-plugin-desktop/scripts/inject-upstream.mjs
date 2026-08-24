/**
 * Build the pinned upstream fork and inject its packages into the desktop
 * install tree before electron-builder assembles the installer.
 *
 * The packaged runtime resolves every @deepseek-ai/dsh-* module from
 * node_modules, so replacing those lib/ outputs with upstream-built artifacts
 * is what makes fork-only features (e.g. the aqua glass client) reach the
 * installer. Desktop-owned patches (patches/dsh-*@*.patch) are replayed on top
 * of the injected outputs so the Electron adaptions they carry survive.
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(SCRIPT_DIR, '..')
const WORKSPACE_ROOT = resolve(DESKTOP_ROOT, '..')
const SUBMODULE_DIR = join(WORKSPACE_ROOT, 'deepseek-harness')
const SCOPE_DIR = join(DESKTOP_ROOT, 'node_modules', '@deepseek-ai')
const PATCHES_DIR = join(WORKSPACE_ROOT, 'patches')
const STATE_FILE = join(DESKTOP_ROOT, 'node_modules', '.upstream-inject-state.json')

/**
 * @typedef {object} InjectOptions
 * @property {string} [workspaceRoot] Repository root containing the Yarn workspace.
 * @property {string} [desktopRoot] Desktop package root containing node_modules.
 * @property {string} [submoduleDir] Pinned upstream submodule root.
 * @property {string} [patchesDir] Directory of desktop-owned yarn patches.
 * @property {(message: string) => void} [log] Report non-secret injection progress.
 * @property {(command: string, args: readonly string[], cwd: string) => void} [run]
 *   Execute one child command; throws on non-zero exit.
 */

function defaultRun(command, args, cwd) {
  const resolvedCommand = process.platform === 'win32' && command === 'corepack'
    ? 'corepack.cmd'
    : command
  const result = spawnSync(resolvedCommand, args, { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultLog(message) {
  console.log(message)
}

/** List the upstream workspace package directories worth injecting. */
export function upstreamPackageDirs(submoduleDir) {
  const dirs = []
  for (const area of ['packages', 'apps']) {
    const areaDir = join(submoduleDir, area)
    if (!existsSync(areaDir)) continue
    for (const group of readdirSync(areaDir)) {
      const groupDir = join(areaDir, group)
      if (!statSync(groupDir).isDirectory()) continue
      if (area === 'apps') {
        if (existsSync(join(groupDir, 'package.json'))) dirs.push(groupDir)
        continue
      }
      for (const name of readdirSync(groupDir)) {
        const pkgDir = join(groupDir, name)
        if (!statSync(pkgDir).isDirectory()) continue
        if (existsSync(join(pkgDir, 'package.json'))) dirs.push(pkgDir)
      }
    }
  }
  return dirs
}

/** Resolve the publish slice (package.json `files`) of an upstream package. */
export function upstreamPackageFiles(pkgDir, pkgJson) {
  const files = Array.isArray(pkgJson.files) ? pkgJson.files : []
  return files.filter((pattern) => !pattern.startsWith('!') && pattern !== 'package.json')
}

/** Turn a package.json `files` glob into a regex over relative paths. */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const wildcard = escaped
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')
  return new RegExp(`^${wildcard}$`)
}

/** Recursively list files under a directory matching a `files` glob. */
export function collectGlobFiles(rootDir, pattern) {
  const matcher = globToRegExp(pattern)
  const matches = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relPath)
      } else if (matcher.test(relPath)) {
        matches.push(relPath)
      }
    }
  }
  if (existsSync(rootDir)) walk(rootDir, '')
  return matches
}

/** Copy one upstream package's publish slice into the desktop install tree. */
export function injectPackageFiles(pkgDir, targetDir, pkgJson, includeManifest) {
  mkdirSync(targetDir, { recursive: true })
  if (includeManifest) {
    cpSync(join(pkgDir, 'package.json'), join(targetDir, 'package.json'))
  }
  for (const pattern of upstreamPackageFiles(pkgDir, pkgJson)) {
    const hasGlob = /[*?[\]]/u.test(pattern)
    const relFiles = hasGlob
      ? collectGlobFiles(pkgDir, pattern)
      : existsSync(join(pkgDir, pattern)) ? [pattern] : []
    for (const rel of relFiles) {
      const target = join(targetDir, rel)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(pkgDir, rel), target, { recursive: true })
    }
  }
}

/** Split a unified diff into per-file mini patches, one per hunk. */
export function splitPatchHunks(patchText) {
  const segments = []
  let segment = null
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const rel = /^diff --git a\/(.+?) b\//u.exec(line)?.[1] ?? ''
      segment = { rel, prefix: [line], hunks: [] }
      segments.push(segment)
      continue
    }
    if (segment === null) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('@@ ')) {
      segment.hunks.push({ text: line })
    } else if (segment.hunks.length > 0) {
      segment.hunks[segment.hunks.length - 1].text += `\n${line}`
    } else {
      segment.prefix.push(line)
    }
  }
  return segments
}

/** Parse one hunk into a search sequence of ` `/`-` rows plus `+` rows. */
function parseHunk(hunkText) {
  const lines = hunkText.split(/\r?\n/)
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(lines[0])
  if (match === null) throw new Error('inject-upstream: malformed hunk header')
  const ops = []
  for (const line of lines.slice(1)) {
    if (line.startsWith('\\') || line.length === 0) continue
    ops.push({ type: line[0], text: line.slice(1) })
  }
  return { oldStart: Number(match[1]), ops }
}

/** Apply a hunk at a matched position in a line array. */
function applyHunkAt(content, hunk, start) {
  const result = content.slice(0, start)
  let consumed = 0
  for (const op of hunk.ops) {
    if (op.type === '+') {
      result.push(op.text)
    } else {
      if (op.type === ' ') result.push(op.text)
      consumed += 1
    }
  }
  return [...result, ...content.slice(start + consumed)]
}

/**
 * Extract old→new edits of one replaced line as anchor+insert pairs.
 * `consume` is the number of old characters an edit replaces (0 = insertion).
 */
export function diffInsertions(oldLine, newLine) {
  const insertions = []
  let o = 0
  let n = 0
  while (n < newLine.length) {
    if (o < oldLine.length && oldLine[o] === newLine[n]) {
      o += 1
      n += 1
      continue
    }
    const start = n
    while (n < newLine.length) {
      let run = 0
      while (
        o + run < oldLine.length
        && n + run < newLine.length
        && oldLine[o + run] === newLine[n + run]
      ) run += 1
      if (run >= 4) break
      n += 1
    }
    const consume = n >= newLine.length ? oldLine.length - o : 0
    insertions.push({
      anchor: oldLine.slice(Math.max(0, o - 20), o),
      insert: newLine.slice(start, n),
      consume,
    })
  }
  return insertions
}

/** Locate an anchor, shrinking it until it matches the target. */
function locateAnchor(target, anchor) {
  for (let length = anchor.length; length >= 1; length -= 1) {
    const index = target.indexOf(anchor.slice(0, length))
    if (index >= 0) return { index, length }
  }
  return null
}

/**
 * Locate an anchor line exactly, falling back to its leading `"key":` marker
 * (upstream CSS class-name hashes may differ from the patched npm build).
 */
function locateAnchorLine(content, anchorLine) {
  const exact = content.findIndex((line) => line === anchorLine)
  if (exact >= 0) return exact
  const keyMatch = /^\s*("[^"]+")\s*:/u.exec(anchorLine)
  if (keyMatch !== null) {
    const key = keyMatch[1]
    return content.findIndex((line) => line.includes(key))
  }
  return -1
}

/** Apply anchor+insert pairs to a line; null when an anchor is missing. */
export function applyInsertions(target, insertions) {
  let result = target
  for (const insertion of insertions) {
    const located = locateAnchor(result, insertion.anchor)
    if (located === null) return null
    const replace = insertion.consume ?? 0
    result = result.slice(0, located.index + located.length)
      + insertion.insert
      + result.slice(located.index + located.length + replace)
  }
  return result
}

/** Best-effort whole-line similarity used to locate replaced rows. */
function lineSimilarity(left, right) {
  if (left === right) return 1
  const longer = Math.max(left.length, right.length)
  if (longer === 0) return 0
  let common = 0
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] === right[i]) common += 1
  }
  return common / longer
}

/**
 * Apply one hunk to a staged file with exact matching first, then tolerant
 * fallbacks (pure insertion, single-line char-level diff).
 */
export function applyHunkTolerant(rootDir, rel, hunkText) {
  const filePath = join(rootDir, rel)
  if (!existsSync(filePath)) return false
  const hunk = parseHunk(hunkText)
  const content = readFileSync(filePath, 'utf8').split(/\r?\n/)
  const search = hunk.ops.filter((op) => op.type !== '+').map((op) => op.text)
  const base = hunk.oldStart - 1
  for (let start = Math.max(0, base - 2); start <= Math.min(content.length - search.length, base + 2); start += 1) {
    if (search.every((text, i) => content[start + i] === text)) {
      writeFileSync(filePath, applyHunkAt(content, hunk, start).join('\n'))
      return true
    }
  }
  const insertRows = hunk.ops.filter((op) => op.type === '+').map((op) => op.text)
  if (hunk.ops.every((op) => op.type !== '-') && insertRows.length > 0) {
    const firstAdd = hunk.ops.findIndex((op) => op.type === '+')
    const lastAdd = hunk.ops.findLastIndex((op) => op.type === '+')
    const pre = hunk.ops[firstAdd - 1]
    const post = hunk.ops[lastAdd + 1]
    const preIndex = pre?.type === ' ' ? locateAnchorLine(content, pre.text) : -1
    if (preIndex >= 0) {
      const result = [...content.slice(0, preIndex + 1), ...insertRows, ...content.slice(preIndex + 1)]
      writeFileSync(filePath, result.join('\n'))
      return true
    }
    if (post?.type === ' ') {
      const postIndex = locateAnchorLine(content, post.text)
      if (postIndex >= 0) {
        const result = [...content.slice(0, postIndex), ...insertRows, ...content.slice(postIndex)]
        writeFileSync(filePath, result.join('\n'))
        return true
      }
    }
  }
  const deleted = hunk.ops.filter((op) => op.type === '-')
  const added = hunk.ops.filter((op) => op.type === '+')
  if (deleted.length > 0 && added.length >= deleted.length) {
    const working = [...content]
    const used = new Set()
    let ok = true
    for (let i = 0; i < deleted.length; i += 1) {
      const insertions = diffInsertions(deleted[i].text, added[i].text)
      const index = working.findIndex((line, j) => {
        if (used.has(j)) return false
        return lineSimilarity(line, deleted[i].text) > 0.8
      })
      if (index < 0 || insertions.length === 0) {
        ok = false
        break
      }
      const patched = applyInsertions(working[index], insertions)
      if (patched === null) {
        ok = false
        break
      }
      working[index] = patched
      used.add(index)
      if (i === deleted.length - 1 && added.length > deleted.length) {
        working.splice(index + 1, 0, ...added.slice(deleted.length).map((op) => op.text))
      }
    }
    if (ok) {
      writeFileSync(filePath, working.join('\n'))
      return true
    }
  }
  return false
}

/**
 * Replay one desktop-owned patch inside an injected package directory.
 * `git apply` skips paths the desktop repository ignores (node_modules), so
 * the patch is applied in a temporary directory outside the repository and
 * the touched files are copied back. Hunks are applied one by one; a hunk
 * whose removed rows no longer match (upstream drift) falls back to tolerant
 * insertion or char-level diffing.
 */
export function replayPatch(packageDir, patchFile, run) {
  const patchText = readFileSync(patchFile, 'utf8')
  const segments = splitPatchHunks(patchText)
  const staging = mkdtempSync(join(tmpdir(), 'dsh-inject-'))
  try {
    for (const segment of segments) {
      const source = join(packageDir, segment.rel)
      if (!existsSync(source)) continue
      mkdirSync(dirname(join(staging, segment.rel)), { recursive: true })
      cpSync(source, join(staging, segment.rel))
    }
    for (const segment of segments) {
      for (const hunk of segment.hunks) {
        const miniPatch = join(staging, '.mini.patch')
        writeFileSync(miniPatch, `${[...segment.prefix, hunk.text].join('\n')}\n`)
        try {
          run('git', ['apply', miniPatch], staging)
        } catch {
          if (!applyHunkTolerant(staging, segment.rel, hunk.text)) {
            throw new Error(`inject-upstream: patch hunk did not apply to ${segment.rel}`)
          }
        }
      }
    }
    for (const segment of segments) {
      const patched = join(staging, segment.rel)
      if (!existsSync(patched)) continue
      const target = join(packageDir, segment.rel)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(patched, target)
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Map the desktop's patch resolutions to absolute patch files. */
export function desktopPatchFiles(workspaceRoot, patchesDir) {
  const rootPkg = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8'))
  const resolutions = rootPkg.resolutions ?? {}
  const files = new Set()
  for (const value of Object.values(resolutions)) {
    const match = /^patch:.*#(\.\/patches\/[^#]+)$/u.exec(String(value))
    if (match === null) continue
    const resolved = resolve(workspaceRoot, match[1])
    if (existsSync(resolved)) files.add(resolved)
  }
  void patchesDir
  return [...files]
}

/**
 * Derive the @deepseek-ai package name from a patch file name, or null when
 * the patch targets a non-dsh package (e.g. electron-builder).
 */
export function patchPackageName(patchFile) {
  const base = patchFile.split(/[\\/]/u).at(-1) ?? ''
  const match = /^(dsh-.+)@.+\..*$/u.exec(base)
  return match === null ? null : `@deepseek-ai/${match[1]}`
}

/** Whether a fresh fork build is needed for the currently pinned commit. */
export function needsUpstreamBuild(submoduleDir, state) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: submoduleDir, encoding: 'utf8' })
  const commit = head.status === 0 ? head.stdout.trim() : ''
  const probe = join(submoduleDir, 'packages', 'bundle', 'web-app', 'lib', 'index.js')
  const built = existsSync(probe)
  return !built || state.commit !== commit
}

/** Build the pinned upstream fork in place. */
export function buildUpstream(submoduleDir, run) {
  run('corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], submoduleDir)
  run('corepack', ['pnpm', 'run', 'build'], submoduleDir)
}

/** Current pinned upstream commit. */
export function upstreamCommit(submoduleDir) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: submoduleDir, encoding: 'utf8' })
  if (head.status !== 0) throw new Error('inject-upstream: cannot read submodule HEAD')
  return head.stdout.trim()
}

/**
 * Build the pinned upstream (when stale) and inject its packages plus the
 * desktop patches into the desktop install tree.
 */
export function injectUpstream(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? WORKSPACE_ROOT
  const desktopRoot = options.desktopRoot ?? DESKTOP_ROOT
  const submoduleDir = options.submoduleDir ?? SUBMODULE_DIR
  const patchesDir = options.patchesDir ?? PATCHES_DIR
  const run = options.run ?? defaultRun
  const log = options.log ?? defaultLog

  if (!existsSync(join(submoduleDir, 'package.json'))) {
    throw new Error('inject-upstream: pinned upstream submodule is not initialized')
  }
  if (!existsSync(join(desktopRoot, 'node_modules', '@deepseek-ai'))) {
    throw new Error('inject-upstream: desktop install tree is missing @deepseek-ai packages')
  }

  const state = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    : {}
  if (needsUpstreamBuild(submoduleDir, state)) {
    log('inject-upstream: building the pinned upstream fork')
    buildUpstream(submoduleDir, run)
  } else {
    log('inject-upstream: reusing the upstream build for the current pin')
  }

  const commit = upstreamCommit(submoduleDir)
  const scope = join(desktopRoot, 'node_modules', '@deepseek-ai')
  const injected = []
  const added = []
  const patchFiles = desktopPatchFiles(workspaceRoot, patchesDir)

  for (const pkgDir of upstreamPackageDirs(submoduleDir)) {
    const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const name = pkgJson.name
    if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
    const shortName = name.slice('@deepseek-ai/'.length)
    const targetDir = join(scope, shortName)
    const isOrphan = !existsSync(join(targetDir, 'package.json'))
    injectPackageFiles(pkgDir, targetDir, pkgJson, isOrphan)
    if (isOrphan) {
      added.push(name)
    } else {
      injected.push(name)
    }
  }

  const patched = []
  for (const patchFile of patchFiles) {
    const packageName = patchPackageName(patchFile)
    if (packageName === null) continue
    const shortName = packageName.slice('@deepseek-ai/'.length)
    const packageDir = join(scope, shortName)
    if (!existsSync(join(packageDir, 'package.json'))) continue
    replayPatch(packageDir, patchFile, run)
    patched.push(packageName)
  }

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ commit, injectedAt: new Date().toISOString() }, null, 2),
  )
  log(
    `inject-upstream: ${injected.length} packages refreshed, ${added.length} fork-only packages added, ${patched.length} desktop patches replayed @ ${commit.slice(0, 10)}`,
  )
  return { injected, added, patched, commit }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  if (process.env.DSH_SKIP_UPSTREAM_INJECT === '1') {
    console.log('inject-upstream: skipped (DSH_SKIP_UPSTREAM_INJECT=1)')
    process.exit(0)
  }
  try {
    injectUpstream()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
