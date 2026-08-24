import { afterEach, describe, expect, it } from 'vitest'
import { installBetterSidebarModulesBridge } from '../src/client/better-sidebar-modules.ts'

interface LoaderGlobal {
  load(entry: { id: string, factory: (require: (spec: string) => unknown) => void }): void
}

const globals = globalThis as {
  __DSH_MODULES__?: { import(spec: string): Promise<unknown> }
  __ModuleLoader__?: LoaderGlobal
}

afterEach(() => {
  delete globals.__DSH_MODULES__
  delete globals.__ModuleLoader__
})

describe('installBetterSidebarModulesBridge', () => {
  it('bridges the shell module loader into __DSH_MODULES__', async () => {
    const loaded: string[] = []
    globals.__ModuleLoader__ = {
      load: entry => {
        loaded.push(entry.id)
        entry.factory(spec => ({ spec }))
      },
    }
    installBetterSidebarModulesBridge()
    expect(loaded).toEqual(['dsh-plugin-desktop/better-sidebar-modules-bridge'])
    expect(globals.__DSH_MODULES__).toBeDefined()
    await expect(globals.__DSH_MODULES__!.import('react')).resolves.toEqual({ spec: 'react' })
  })

  it('keeps an existing shell-provided module system', () => {
    const existing = { import: async () => ({ shipped: true }) }
    globals.__DSH_MODULES__ = existing
    globals.__ModuleLoader__ = { load: () => { throw new Error('must not register') } }
    installBetterSidebarModulesBridge()
    expect(globals.__DSH_MODULES__).toBe(existing)
  })

  it('does nothing without the bootstrap loader facade', () => {
    installBetterSidebarModulesBridge()
    expect(globals.__DSH_MODULES__).toBeUndefined()
  })

  it('does nothing when the shim factory never captures a require', () => {
    globals.__ModuleLoader__ = { load: () => undefined }
    installBetterSidebarModulesBridge()
    expect(globals.__DSH_MODULES__).toBeUndefined()
  })
})
