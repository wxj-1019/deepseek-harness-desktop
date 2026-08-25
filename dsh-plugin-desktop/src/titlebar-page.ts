/**
 * In-app title-bar page for the Windows compatibility shell.
 *
 * The native window-control overlay would cover the acrylic material, so the
 * caption strip is a transparent page drawn over the system blur: a full-width
 * drag region plus three window-control buttons that reach the main process
 * through the preload bridge.
 */

import { WINDOWS_TITLEBAR_HEIGHT } from './window-chrome.ts'

const TITLE_BAR_HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; height: ${WINDOWS_TITLEBAR_HEIGHT}px; overflow: hidden; background: transparent; }
  #bar { position: fixed; inset: 0 0 auto 0; height: ${WINDOWS_TITLEBAR_HEIGHT}px; display: flex; justify-content: flex-end; -webkit-app-region: drag; background: rgba(13, 21, 35, 0.72); backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4); border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
  #controls { display: flex; -webkit-app-region: no-drag; }
  button { width: 46px; height: ${WINDOWS_TITLEBAR_HEIGHT}px; border: none; outline: none; background: transparent; color: #eaf2fc; display: flex; align-items: center; justify-content: center; cursor: default; padding: 0; margin: 0; }
  button:hover { background: rgba(255, 255, 255, 0.09); }
  button:active { background: rgba(255, 255, 255, 0.16); }
  #close:hover { background: #e81123; color: #fff; }
  svg { width: 10px; height: 10px; shape-rendering: crispEdges; }
</style>
<div id="bar">
  <div id="controls">
    <button id="minimize" aria-label="Minimize"><svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg></button>
    <button id="maximize" aria-label="Maximize"><svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg></button>
    <button id="close" aria-label="Close"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1"/></svg></button>
  </div>
</div>
<script>
  const bridge = window.DSH_DESKTOP_TITLEBAR
  if (bridge !== undefined) {
    document.getElementById('minimize').addEventListener('click', () => bridge.minimize())
    document.getElementById('maximize').addEventListener('click', () => bridge.toggleMaximize())
    document.getElementById('close').addEventListener('click', () => bridge.close())
  }
</script>
`

/** @returns the data URL of the transparent acrylic caption page. */
export function titleBarPageUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(TITLE_BAR_HTML)}`
}
