/**
 * Desktop shell: the local UI in a real app window instead of a browser tab.
 *
 * The control panel is the same token-protected loopback UI the CLI serves;
 * video is NOT drawn here. The stream opens in the native ps-media (SDL)
 * window, which decodes and presents without a browser compositor in the way
 * - that is where the latency budget goes.
 */

import { app, BrowserWindow, shell, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === 'win32' ? 'ps-media.exe' : 'ps-media';

// Packaged builds ship the media engine in resources/bin.
if (app.isPackaged && !process.env.PS_MEDIA_BIN) {
  process.env.PS_MEDIA_BIN = path.join(process.resourcesPath, 'bin', exe);
}

// Media engine and Wayland portals care about the app id; also keeps
// notifications and the taskbar grouping tidy.
app.setName('Penguin Stream');
if (process.platform === 'win32') app.setAppUserModelId('io.github.nicholasvoador.penguinstream');
// The control panel is light work; never let it compete with the stream.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.disableHardwareAcceleration?.();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let ui = null;

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  const createWindow = async () => {
    const { startUi } = await import('../node/src/ui/server.mjs');
    ui = await startUi({ port: 0, open: false, quiet: true });
    const origin = new URL(ui.url).origin;

    // PS_UI_SNAPSHOT=out.png renders the UI offscreen to a PNG and exits
    // (used for visual checks in CI/dev; never set in normal use).
    const snapshot = process.env.PS_UI_SNAPSHOT;
    win = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 760,
      minHeight: 560,
      show: false,
      title: 'Penguin Stream',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0f1c' : '#f3f6fb',
      icon: path.join(HERE, 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        offscreen: Boolean(snapshot),
      },
    });
    Menu.setApplicationMenu(null);

    // Only the local UI may load in this window; links open in the browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (new URL(url).origin !== origin) e.preventDefault();
    });
    win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'clipboard-sanitized-write');
    });

    if (!snapshot) win.once('ready-to-show', () => win.show());
    win.on('closed', () => { win = null; });
    await win.loadURL(ui.url);
    if (snapshot) {
      const { writeFileSync } = await import('node:fs');
      await new Promise((r) => setTimeout(r, 2500));
      if (process.env.PS_UI_SNAPSHOT_JS) await win.webContents.executeJavaScript(process.env.PS_UI_SNAPSHOT_JS);
      await new Promise((r) => setTimeout(r, 1200));
      writeFileSync(snapshot, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }
  };

  app.whenReady().then(createWindow).catch((err) => {
    console.error(err);
    app.exit(1);
  });

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !ui) return;
    e.preventDefault();
    quitting = true;
    // Stop any share cleanly (releases held keys, closes the capture) first.
    Promise.race([ui.close(), new Promise((r) => setTimeout(r, 1500))])
      .finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
}
