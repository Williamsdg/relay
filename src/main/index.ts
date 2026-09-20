import { app, BrowserWindow, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpc, teardown } from './ipc.js'
import { log } from './logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0f0c',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload is an ES module; Electron only loads those unsandboxed.
      // Context isolation still keeps the renderer off Node's globals.
      sandbox: false,
      // Xbox streams come in as H.264/HEVC over WebRTC; without hardware
      // decoding a 1080p60 stream pegs the CPU and drops frames.
      backgroundThrottling: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// A stream is useless if the display sleeps mid-game.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.whenReady().then(() => {
  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  // Tear the session down on the service side so the console is immediately
  // available again rather than holding a slot until it times out.
  event.preventDefault()
  try {
    await teardown()
  } catch (err) {
    log.warn('app', `Teardown failed: ${String(err)}`)
  }
  app.exit(0)
})
