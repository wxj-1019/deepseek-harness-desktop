/** Shared names for the in-app caption bridge (preload ↔ main process). */

export const DESKTOP_TITLEBAR_BRIDGE = 'DSH_DESKTOP_TITLEBAR'

/** Channel names used by the drawn window controls. */
export const DESKTOP_TITLEBAR_MINIMIZE_CHANNEL = `${DESKTOP_TITLEBAR_BRIDGE}:minimize`
export const DESKTOP_TITLEBAR_TOGGLE_CHANNEL = `${DESKTOP_TITLEBAR_BRIDGE}:toggle`
export const DESKTOP_TITLEBAR_CLOSE_CHANNEL = `${DESKTOP_TITLEBAR_BRIDGE}:close`
