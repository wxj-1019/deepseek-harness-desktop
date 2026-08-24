/**
 * Focused tests for the upstream injection pipeline. These exercise the
 * patch-splitting, tolerant application, and package-copy helpers with small
 * fixtures; they never run a real upstream build.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM helper without a declaration file
import * as inject from '../scripts/inject-upstream.mjs'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inject-spec-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('splitPatchHunks', () => {
  it('splits a multi-file multi-hunk patch into per-hunk mini patches', () => {
    const patch = [
      'diff --git a/lib/a.js b/lib/a.js',
      'index 111..222 100644',
      '--- a/lib/a.js',
      '+++ b/lib/a.js',
      '@@ -1,2 +1,3 @@',
      ' a',
      '+b',
      ' c',
      '@@ -10,1 +11,1 @@',
      '-old',
      '+new',
      'diff --git a/lib/b.js b/lib/b.js',
      'index 333..444 100644',
      '--- a/lib/b.js',
      '+++ b/lib/b.js',
      '@@ -5,1 +5,1 @@',
      '-x',
      '+y',
    ].join('\n')
    const segments = inject.splitPatchHunks(patch)
    expect(segments).toHaveLength(2)
    expect(segments[0].rel).toBe('lib/a.js')
    expect(segments[0].hunks).toHaveLength(2)
    expect(segments[0].hunks[0].text).toContain('@@ -1,2 +1,3 @@')
    expect(segments[1].rel).toBe('lib/b.js')
    expect(segments[1].hunks).toHaveLength(1)
  })

  it('drops the no-newline marker so git apply never sees a stray line', () => {
    const patch = [
      'diff --git a/lib/x.d.ts b/lib/x.d.ts',
      'index 111..222 100644',
      '--- a/lib/x.d.ts',
      '+++ b/lib/x.d.ts',
      '@@ -1,1 +1,2 @@',
      '-a',
      '+a',
      '+b',
      '\\ No newline at end of file',
    ].join('\n')
    const segments = inject.splitPatchHunks(patch)
    expect(segments[0].hunks[0].text).not.toContain('No newline')
  })
})

describe('patchPackageName', () => {
  it('derives the @deepseek-ai package from a patch file name', () => {
    expect(inject.patchPackageName('dsh-app-boot@0.1.1-rc.2.patch')).toBe('@deepseek-ai/dsh-app-boot')
    expect(inject.patchPackageName('dsh-client-ui-workspace@0.1.1-rc.2.patch')).toBe(
      '@deepseek-ai/dsh-client-ui-workspace',
    )
  })

  it('returns null for non-dsh patches', () => {
    expect(inject.patchPackageName('app-builder-lib@26.15.7.patch')).toBeNull()
  })
})

describe('desktopPatchFiles', () => {
  it('collects only patch files referenced by the root resolutions', () => {
    const root = tempDir()
    const patches = join(root, 'patches')
    mkdirSync(patches)
    writeFileSync(join(patches, 'dsh-app-boot@0.1.1-rc.2.patch'), 'x')
    writeFileSync(join(patches, 'dsh-unused@0.1.1-rc.2.patch'), 'x')
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        resolutions: {
          '@deepseek-ai/dsh-app-boot@npm:0.1.1-rc.2':
            'patch:@deepseek-ai/dsh-app-boot@npm%3A0.1.1-rc.2#./patches/dsh-app-boot@0.1.1-rc.2.patch',
        },
      }),
    )
    const files = inject.desktopPatchFiles(root, patches)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('dsh-app-boot@0.1.1-rc.2.patch')
  })
})

describe('diffInsertions / applyInsertions', () => {
  it('extracts and applies a css-style insertion to a drifted line', () => {
    const oldLine = 'const css = "abc.showHidden{color:red}def";'
    const newLine = 'const css = "abc.showHidden{color:red}.nativeButton{color:blue}def";'
    const target = 'const css = "abc.showHidden{color:red}xyz";'
    const insertions = inject.diffInsertions(oldLine, newLine)
    expect(insertions.length).toBeGreaterThan(0)
    const patched = inject.applyInsertions(target, insertions)
    expect(patched).toContain('.nativeButton{color:blue}')
    expect(patched).toContain('xyz')
  })

  it('replaces a token when the old and new lines share a long prefix', () => {
    const oldLine = 'if (targetPath !== null) onOpen(targetPath);'
    const newLine = 'if (targetPath !== null) openDirectory(targetPath);'
    const insertions = inject.diffInsertions(oldLine, newLine)
    const patched = inject.applyInsertions(oldLine, insertions)
    expect(patched).toBe('if (targetPath !== null) openDirectory(targetPath);')
  })

  it('returns null when an anchor is entirely missing', () => {
    expect(inject.applyInsertions('nothing here', [{ anchor: 'zzz', insert: 'qqq' }])).toBeNull()
  })
})

describe('applyHunkTolerant', () => {
  it('applies a context-mismatched single-line replacement via char diff', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'f.js'), 'a\nconst css = "abc.showHidden{color:red}def";\nb\n')
    const hunk = [
      '@@ -2,1 +2,1 @@',
      '-const css = "abc.showHidden{color:red}def";',
      '+const css = "abc.showHidden{color:red}.nativeButton{color:blue}def";',
    ].join('\n')
    expect(inject.applyHunkTolerant(dir, 'f.js', hunk)).toBe(true)
    expect(readFileSync(join(dir, 'f.js'), 'utf8')).toContain('.nativeButton{color:blue}')
  })

  it('inserts added rows after an anchor located by key when hashes drifted', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'f.js'), '"divider": "SpeJUa_divider",\n"editorScope": "SpeJUa_editorScope",\n')
    const hunk = [
      '@@ -1,3 +1,4 @@',
      ' "divider": "ZuhsRW_divider",',
      '+"nativePickerButton": "ZuhsRW_nativePickerButton",',
      ' "editorScope": "ZuhsRW_editorScope",',
    ].join('\n')
    expect(inject.applyHunkTolerant(dir, 'f.js', hunk)).toBe(true)
    expect(readFileSync(join(dir, 'f.js'), 'utf8')).toContain('"nativePickerButton"')
  })

  it('appends extra added rows after a replaced row (1:2 hunk)', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'f.js'), '"browser.showHidden": "显示隐藏文件"\n')
    const hunk = [
      '@@ -1,1 +1,2 @@',
      '-"browser.showHidden": "显示隐藏文件"',
      '+"browser.showHidden": "显示隐藏文件",',
      '+"browser.nativePicker": "使用 Windows 选择文件夹"',
    ].join('\n')
    expect(inject.applyHunkTolerant(dir, 'f.js', hunk)).toBe(true)
    const content = readFileSync(join(dir, 'f.js'), 'utf8')
    expect(content).toContain('"browser.nativePicker": "使用 Windows 选择文件夹"')
  })

  it('returns false when no fallback can locate the rows', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'f.js'), 'unrelated\n')
    const hunk = ['@@ -1,1 +1,1 @@', '-missing', '+replacement'].join('\n')
    expect(inject.applyHunkTolerant(dir, 'f.js', hunk)).toBe(false)
  })
})

describe('injectPackageFiles', () => {
  it('copies the publish slice including glob patterns', () => {
    const source = tempDir()
    const target = tempDir()
    mkdirSync(join(source, 'lib', 'types'), { recursive: true })
    writeFileSync(join(source, 'package.json'), '{"name":"@deepseek-ai/dsh-x","files":["lib/index.js","lib/types/**/*.d.ts","cordis.patch.yml"]}')
    writeFileSync(join(source, 'lib', 'index.js'), 'export {}')
    writeFileSync(join(source, 'lib', 'types', 'index.d.ts'), 'export {}')
    writeFileSync(join(source, 'cordis.patch.yml'), 'x')
    writeFileSync(join(source, 'unlisted.txt'), 'x')
    inject.injectPackageFiles(
      source,
      join(target, 'dsh-x'),
      JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')),
      true,
    )
    const targetRoot = join(target, 'dsh-x')
    expect(readFileSync(join(targetRoot, 'lib', 'index.js'), 'utf8')).toBe('export {}')
    expect(readFileSync(join(targetRoot, 'lib', 'types', 'index.d.ts'), 'utf8')).toBe('export {}')
    expect(readFileSync(join(targetRoot, 'cordis.patch.yml'), 'utf8')).toBe('x')
    expect(readFileSync(join(targetRoot, 'package.json'), 'utf8')).toContain('dsh-x')
    expect(() => readFileSync(join(targetRoot, 'unlisted.txt'))).toThrow()
  })
})
