import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray,
  WebContentsView,
} from 'electron'
import { formatDesktopExitCode } from './desktop-logger.ts'
import { applicationNeedsReveal, revealApplication } from './electron-reveal.ts'
import type { ElectronPlatformStrategy } from './electron-platform.ts'
import type { DesktopNotification, DesktopShellSpec } from './runtime.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import {
  DESKTOP_TITLEBAR_CLOSE_CHANNEL,
  DESKTOP_TITLEBAR_MINIMIZE_CHANNEL,
  DESKTOP_TITLEBAR_TOGGLE_CHANNEL,
} from './titlebar-bridge-contract.ts'
import { titleBarPageUrl } from './titlebar-page.ts'
import { desktopWindowOptions } from './window-options.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from './window-chrome.ts'

const MIN_ZOOM_LEVEL = -4
const MAX_ZOOM_LEVEL = 4

function clampedZoomLevel(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level))
}

function isZoomShortcut(input: Electron.Input): 'in' | 'out' | 'reset' | undefined {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return undefined
  if (input.key === '+' || input.key === '=') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return undefined
}

export interface ElectronShellGenerationOptions {
  readonly platform: ElectronPlatformStrategy
  readonly spec: DesktopShellSpec
  readonly preloadPath: string
  readonly buildApplicationMenuItems: () => readonly Electron.MenuItemConstructorOptions[]
  readonly isQuitting: () => boolean
  readonly buildTrayTemplate: () => Electron.MenuItemConstructorOptions[]
  readonly stopRendererBootMonitoring: () => void
  readonly abortRendererBootMonitoring: (cause: unknown) => void
  readonly failRendererBoot: (error: string) => void
  readonly logError: (message: string) => void
}

/** Own one BrowserWindow and Tray generation, including every native listener. */
export class ElectronShellGeneration {
  private window: BrowserWindow | undefined
  private tray: Tray | undefined
  private mounted = false
  private released = false
  private attentionCount = 0
  private cleanupListeners: (() => void) | undefined

  constructor(private readonly options: ElectronShellGenerationOptions) {}

  async mount(beforeInteractive?: () => void): Promise<void> {
    if (this.mounted || this.window !== undefined) {
      throw new Error('dsh-plugin-desktop: native shell generation is already mounted')
    }

    const { platform, spec } = this.options
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`dsh-plugin-desktop: failed to load application icon ${spec.iconPath}`)
    }
    platform.configureApplication(icon, spec.productName, this.options.buildApplicationMenuItems())
    const origin = new URL(spec.url).origin
    if (spec.mode === 'advanced') {
      nativeTheme.themeSource = spec.readThemeSource()
    } else if (platform.platform === 'win32') {
      // The compatibility shell keeps the OS frame, whose title bar follows
      // the system theme; pin it dark so the native bar matches the dark web
      // surface instead of showing a light strip on light-themed systems.
      nativeTheme.themeSource = 'dark'
    }
    const window = new BrowserWindow(desktopWindowOptions(spec, icon, platform.platform, this.options.preloadPath))
    window.accessibleTitle = spec.windowTitle
    platform.configureWindow(window)
    this.window = window

    // On Windows compatibility mode the caption strip is a transparent
    // WebContentsView floating over the full-height web client; its
    // backdrop-filter blurs the content below into a frosted bar (the system
    // acrylic material does not render on every Windows build, so the blur is
    // done in-page). The web client keeps the full window viewport, so every
    // 100vh layout assumption stays correct.
    let contentView: Electron.WebContentsView | undefined
    let captionView: Electron.WebContentsView | undefined
    const applyContentBounds = (): void => {
      if (contentView === undefined) return
      const size = window.getContentSize()
      const width = size[0] ?? 0
      const height = size[1] ?? 0
      // The web client lives below the caption strip so its viewport (100vh)
      // matches the visible content area and nothing is covered or clipped.
      contentView.setBounds({
        x: 0,
        y: WINDOWS_TITLEBAR_HEIGHT,
        width,
        height: Math.max(0, height - WINDOWS_TITLEBAR_HEIGHT),
      })
      captionView?.setBounds({ x: 0, y: 0, width, height: WINDOWS_TITLEBAR_HEIGHT })
    }
    let detachTitleBar: (() => void) | undefined
    if (spec.mode === 'compatibility' && platform.platform === 'win32') {
      const webPreferences = {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      }
      contentView = new WebContentsView({ webPreferences })
      captionView = new WebContentsView({ webPreferences })
      // addChildView stacks in order: content first, caption on top.
      window.contentView.addChildView(contentView)
      window.contentView.addChildView(captionView)
      applyContentBounds()
      window.on('resize', applyContentBounds)
      // The caption page hosts the drawn window controls over IPC; ignore any
      // message whose sender is not this window's caption webContents.
      const accepts = (sender: Electron.WebContents): boolean =>
        sender.id === captionView?.webContents.id && !window.isDestroyed()
      const onMinimize = (event: Electron.IpcMainEvent): void => {
        if (accepts(event.sender)) window.minimize()
      }
      const onToggle = (event: Electron.IpcMainEvent): void => {
        if (!accepts(event.sender)) return
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
      }
      const onClose = (event: Electron.IpcMainEvent): void => {
        if (accepts(event.sender)) window.close()
      }
      ipcMain.on(DESKTOP_TITLEBAR_MINIMIZE_CHANNEL, onMinimize)
      ipcMain.on(DESKTOP_TITLEBAR_TOGGLE_CHANNEL, onToggle)
      ipcMain.on(DESKTOP_TITLEBAR_CLOSE_CHANNEL, onClose)
      detachTitleBar = () => {
        ipcMain.off(DESKTOP_TITLEBAR_MINIMIZE_CHANNEL, onMinimize)
        ipcMain.off(DESKTOP_TITLEBAR_TOGGLE_CHANNEL, onToggle)
        ipcMain.off(DESKTOP_TITLEBAR_CLOSE_CHANNEL, onClose)
      }
      void captionView.webContents.loadURL(titleBarPageUrl())
    }
    const contents = contentView?.webContents ?? window.webContents

    const show = (): void => { this.show() }
    const activate = (): void => {
      if (applicationNeedsReveal(window, platform.platform)) this.show()
    }
    const clearAttention = (): void => { this.clearAttention() }
    const close = (event: Electron.Event): void => {
      if (this.options.isQuitting()) return
      event.preventDefault()
      window.hide()
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const handleZoomShortcut = (event: Electron.Event, input: Electron.Input): void => {
      const action = isZoomShortcut(input)
      if (action === undefined) return
      event.preventDefault()
      if (action === 'reset') {
        contents.setZoomLevel(0)
        return
      }
      const step = action === 'in' ? 1 : -1
      contents.setZoomLevel(clampedZoomLevel(contents.getZoomLevel() + step))
    }
    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
      if (!event.isMainFrame) return
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(event.url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }
    const redirect = (
      event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }
    const rendererGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      const detail = `renderer process gone (reason: ${details.reason}, exitCode: ${formatDesktopExitCode(details.exitCode)})`
      this.options.logError(`dsh-plugin-desktop: ${detail}`)
      this.options.failRendererBoot(detail)
    }
    const loadFailed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      this.options.logError(`dsh-plugin-desktop: renderer failed to load (${errorCode}: ${errorDescription})`)
      if (isMainFrame === true && errorCode !== -3) {
        this.options.failRendererBoot(
          `renderer main frame failed to load (${String(errorCode)}: ${errorDescription})`,
        )
      }
    }

    app.on('activate', activate)
    if (platform.platform === 'darwin') app.on('did-become-active', activate)
    window.on('close', close)
    window.on('focus', clearAttention)
    window.on('page-title-updated', preserveBlankTitle)
    contents.on('before-input-event', handleZoomShortcut)
    contents.on('will-frame-navigate', navigate)
    contents.on('will-redirect', redirect)
    contents.on('render-process-gone', rendererGone)
    contents.on('did-fail-load', loadFailed)
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((cause: unknown) => {
            this.options.logError(`dsh-plugin-desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}`)
          })
        }
      } catch {
        // A malformed target is rejected with the same deny result.
      }
      return { action: 'deny' }
    })
    contents.once('did-finish-load', show)
    let tray: Tray | undefined
    this.cleanupListeners = () => {
      app.off('activate', activate)
      if (platform.platform === 'darwin') app.off('did-become-active', activate)
      window.off('close', close)
      window.off('focus', clearAttention)
      window.off('page-title-updated', preserveBlankTitle)
      window.off('ready-to-show', show)
      window.off('resize', applyContentBounds)
      contents.off('did-finish-load', show)
      contents.off('before-input-event', handleZoomShortcut)
      contents.off('will-frame-navigate', navigate)
      contents.off('will-redirect', redirect)
      contents.off('render-process-gone', rendererGone)
      contents.off('did-fail-load', loadFailed)
      tray?.off('click', show)
      detachTitleBar?.()
      if (captionView !== undefined) window.contentView.removeChildView(captionView)
      if (contentView !== undefined) window.contentView.removeChildView(contentView)
    }

    try {
      await contents.loadURL(spec.url)
      tray = new Tray(prepareTrayIcon(spec.trayIcons, platform.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.refreshTrayMenu()
      tray.on('click', show)
      beforeInteractive?.()
      this.mounted = true
    } catch (cause) {
      this.options.abortRendererBootMonitoring(cause)
      await this.release()
      throw cause
    }
  }

  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    this.clearAttention()
    revealApplication(window, this.options.platform.platform)
  }

  notifyAttention(notification: DesktopNotification): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || window.isFocused()) return

    this.attentionCount += 1
    if (this.options.platform.platform === 'win32') window.flashFrame(true)
    else app.setBadgeCount(this.attentionCount)

    if (!Notification.isSupported()) return
    const nativeNotification = new Notification(notification)
    nativeNotification.once('click', () => { this.show() })
    nativeNotification.show()
  }

  async showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
    const window = this.window
    return window === undefined || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)
  }

  refreshTrayMenu(): void {
    if (this.tray === undefined) return
    this.tray.setContextMenu(Menu.buildFromTemplate(this.options.buildTrayTemplate()))
  }

  refreshThemeMaterial(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) this.options.platform.refreshThemeMaterial(this.window)
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.options.stopRendererBootMonitoring()

    const window = this.window
    const tray = this.tray
    this.clearAttention()
    this.window = undefined
    this.tray = undefined
    if (window === undefined) return

    this.cleanupListeners?.()
    this.cleanupListeners = undefined
    tray?.destroy()
    if (!window.isDestroyed()) window.destroy()
  }

  private clearAttention(): void {
    if (this.attentionCount === 0) return
    this.attentionCount = 0
    if (this.options.platform.platform === 'win32') {
      const window = this.window
      if (window !== undefined && !window.isDestroyed()) window.flashFrame(false)
    } else {
      app.setBadgeCount(0)
    }
  }
}
