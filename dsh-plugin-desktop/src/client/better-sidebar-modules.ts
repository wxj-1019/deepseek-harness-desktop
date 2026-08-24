/**
 * The community better-sidebar plugin lazily loads its editor/terminal chunks
 * through `globalThis.__DSH_MODULES__` — a shell-installed module system its
 * own distribution ships. The upstream web shell does not install that global,
 * so the packaged desktop client bridges it onto the bootstrap module loader
 * facade the shell does provide (`window.__ModuleLoader__`).
 */

interface ModuleLoaderEntry {
  readonly id: string
  readonly factory: (require: (spec: string) => unknown) => void
}

interface ModuleLoaderFacade {
  load(entry: ModuleLoaderEntry): void
}

interface DshModulesBridge {
  import(spec: string): Promise<unknown>
}

type BetterSidebarGlobals = {
  __DSH_MODULES__?: DshModulesBridge | undefined
  __ModuleLoader__?: ModuleLoaderFacade | undefined
}

/**
 * Install the `__DSH_MODULES__` bridge when the shell has not provided one.
 * The bridge resolves chunk externals (react, cordis, client UI packages)
 * through a registered shim whose factory captures the loader's require.
 */
export function installBetterSidebarModulesBridge(): void {
  const globals = globalThis as BetterSidebarGlobals
  if (globals.__DSH_MODULES__ !== undefined) return
  const loader = globals.__ModuleLoader__
  if (loader === undefined) return
  let requireModule: ((spec: string) => unknown) | undefined
  loader.load({
    id: 'dsh-plugin-desktop/better-sidebar-modules-bridge',
    factory: require => {
      requireModule = require
    },
  })
  const resolved = requireModule
  if (resolved === undefined) return
  globals.__DSH_MODULES__ = {
    import: spec => Promise.resolve().then(() => resolved(spec)),
  }
}
