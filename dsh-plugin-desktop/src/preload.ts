/** Minimal context-isolated bridge for resolving operating-system drag payloads. */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_FILE_PATH_BRIDGE } from './file-path-bridge-contract.ts'
import { DESKTOP_TITLEBAR_BRIDGE } from './titlebar-bridge-contract.ts'

contextBridge.exposeInMainWorld(DESKTOP_FILE_PATH_BRIDGE, {
  /** Resolve only genuine disk-backed Web File objects selected by the operator. */
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
})

// Only the in-app caption page defines handlers for these channels; the web
// client never sees them (no listeners installed on its side).
contextBridge.exposeInMainWorld(DESKTOP_TITLEBAR_BRIDGE, {
  minimize(): void {
    ipcRenderer.send(`${DESKTOP_TITLEBAR_BRIDGE}:minimize`)
  },
  toggleMaximize(): void {
    ipcRenderer.send(`${DESKTOP_TITLEBAR_BRIDGE}:toggle`)
  },
  close(): void {
    ipcRenderer.send(`${DESKTOP_TITLEBAR_BRIDGE}:close`)
  },
})

// The better-sidebar toggle cluster is pinned to the top of the window; line
// it up with the session-log row in the web client (below the caption strip).
const params = new URLSearchParams(window.location.search)
if (window.location.protocol === 'http:'
  && params.get('dsh-desktop-platform') === 'win32'
  && params.get('dsh-desktop-mode') === 'compatibility') {
  const align = (): void => {
    const style = document.createElement('style')
    style.id = 'dsh-desktop-better-sidebar-align'
    style.textContent = 'body [class$="_toggleCluster"] { top: 23px !important }'
    document.documentElement.append(style)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', align, { once: true })
  } else {
    align()
  }
}
