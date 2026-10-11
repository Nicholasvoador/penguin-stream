/**
 * Desktop shell: the local UI in a real app window instead of a browser tab.
 *
 * The control panel is the same token-protected loopback UI the CLI serves;
 * video is NOT drawn here. The stream opens in the native ps-media (SDL)
 * window, which decodes and presents without a browser compositor in the way
 * - that is where the latency budget goes.
 *
 * Remote access (unattended) needs the app to keep running: while it is on,
 * closing the window leaves Penguin Stream in the system tray, `--hidden`
 * starts it without a window (used for "start when I log in"), and the PC is
 * kept from sleeping if the owner wants that.
 */

import { app, BrowserWindow, shell, Menu, nativeTheme, powerSaveBlocker, Tray, Notification, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === 'win32' ? 'ps-media.exe' : 'ps-media';
const ICON = path.join(HERE, 'icon.png');
const startHidden = process.argv.includes('--hidden');

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

// Dev-only offscreen snapshots run beside a real instance without touching it.
if (process.env.PS_UI_SNAPSHOT) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'ps-snapshot-')));
}

/* ----------------------------- start at login ----------------------------- */

// Linux: an XDG autostart entry. Windows: the Run key via Electron. The app
// starts hidden, and quits again at once if remote access is off.
const AUTOSTART_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'autostart', 'penguin-stream.desktop');
const launcherPath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;

function getStartAtLogin() {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try { return app.getLoginItemSettings({ path: launcherPath(), args: ['--hidden'] }).openAtLogin === true; } catch { return false; }
  }
  return fs.existsSync(AUTOSTART_FILE);
}

function setStartAtLogin(on) {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: on, path: launcherPath(), args: ['--hidden'] });
      return true;
    }
    if (!on) { fs.rmSync(AUTOSTART_FILE, { force: true }); return true; }
    if (!app.isPackaged) return false;   // a dev checkout has no stable launcher to point at
    const quoted = `"${launcherPath().replace(/(["\\`$])/g, '\\$1')}"`;
    fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
    fs.writeFileSync(AUTOSTART_FILE, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Penguin Stream',
      'Comment=Keeps remote access to this PC available',
      `Exec=${quoted} --hidden`,
      'Icon=penguin-stream',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      'X-KDE-autostart-after=panel',
      '',
    ].join('\n'), { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

if (!process.env.PS_UI_SNAPSHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let ui = null;
  let tray = null;
  let remoteState = { enabled: false };
  let awakeBlocker = null;   // remote access on: the PC does not suspend by itself
  let liveBlocker = null;    // a session is live: the display stays on too
  let toldAboutTray = false;
  let quitting = false;

  let started = false;

  const notify = (title, body) => {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, icon: ICON, silent: false });
      n.on('click', () => { void showWindow(); });
      n.show();
    } catch { /* no notification service: the UI and the log still show it */ }
  };

  const showWindow = async () => {
    if (!ui) return;
    if (!win) { await createWindow(); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  };

  app.on('second-instance', () => { void showWindow(); });

  const updateTray = () => {
    if (!remoteState.enabled) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (!tray) {
      try {
        const img = nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 });
        tray = new Tray(img);
        tray.on('click', () => { void showWindow(); });
      } catch {
        tray = null;   // no tray on this desktop: relaunching the app opens the window
        return;
      }
    }
    const live = remoteState.live;
    tray.setToolTip(live ? 'Penguin Stream: someone is using this PC remotely' : 'Penguin Stream: remote access is on');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: live ? `Remote session in progress (device ${live.fingerprint})` : 'Remote access is on', enabled: false },
      { type: 'separator' },
      { label: 'Open Penguin Stream', click: () => { void showWindow(); } },
      ...(live ? [{ label: 'End the remote session', click: () => ui?.remoteAccess.endSession() }] : []),
      { label: 'Turn off remote access', click: () => ui?.remoteAccess.disable() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  };

  const onRemoteAccess = (st) => {
    remoteState = st ?? { enabled: false };
    try {
      const wantAwake = remoteState.enabled && remoteState.keepAwake !== false;
      if (wantAwake && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
      else if (!wantAwake && awakeBlocker !== null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
    } catch { /* not supported on this desktop: harmless */ }
    updateTray();
    // Switched off from the tray with no window open: nothing left to do.
    if (started && !remoteState.enabled && !win && !quitting) app.quit();
  };

  // While a stream is live, keep the machine and its display awake: an idle
  // timer that sleeps the PC, blanks the screen or throttles the network
  // adapter ends the session (the viewer "goes idle" from the host's point
  // of view). Released as soon as the session ends.
  const onSessionChange = (live) => {
    try {
      if (live && liveBlocker === null) liveBlocker = powerSaveBlocker.start('prevent-display-sleep');
      else if (!live && liveBlocker !== null) { powerSaveBlocker.stop(liveBlocker); liveBlocker = null; }
    } catch { /* not supported on this desktop: harmless */ }
  };

  const createWindow = async () => {
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
      icon: ICON,
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

    if (!snapshot) {
      // 'ready-to-show' alone is not reliable on Wayland with hardware
      // acceleration off: it sometimes never fires, leaving an invisible
      // instance that holds the single-instance lock. Reveal on whichever
      // comes first, with a timeout as the last resort.
      let shown = false;
      const reveal = () => {
        if (shown || !win || win.isDestroyed()) return;
        shown = true;
        win.show();
      };
      win.once('ready-to-show', reveal);
      win.webContents.once('did-finish-load', reveal);
      setTimeout(reveal, 3000);
    }
    // Remote access on: closing the window keeps the app (and the listener)
    // running in the tray. The window itself is released to save memory.
    win.on('close', () => {
      if (!quitting && remoteState.enabled && !toldAboutTray) {
        toldAboutTray = true;
        notify('Penguin Stream is still running',
          'Remote access is on, so Penguin Stream keeps running in the background. Quit it from the tray icon.');
      }
    });
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

  const start = async () => {
    const { startUi } = await import('../node/src/ui/server.mjs');
    ui = await startUi({
      port: 0, open: false, quiet: true, onSessionChange,
      desktop: { notify, setStartAtLogin, getStartAtLogin, onRemoteAccess },
    });
    onRemoteAccess(ui.remoteAccess.state());
    if (startHidden && !process.env.PS_UI_SNAPSHOT) {
      // Started at login for remote access. If it has been switched off since,
      // there is nothing to do in the background.
      if (!ui.remoteAccess.state().enabled) { app.quit(); return; }
      started = true;
      return;
    }
    await createWindow();
    started = true;
  };

  app.whenReady().then(start).catch((err) => {
    console.error(err);
    app.exit(1);
  });

  app.on('before-quit', (e) => {
    if (quitting || !ui) { quitting = true; return; }
    e.preventDefault();
    quitting = true;
    // Stop any share cleanly (releases held keys, closes the capture) first.
    Promise.race([ui.close(), new Promise((r) => setTimeout(r, 1500))])
      .finally(() => app.exit(0));
  });
  // With remote access on, Penguin Stream lives on in the tray.
  app.on('window-all-closed', () => {
    if (!remoteState.enabled || quitting) app.quit();
  });
}
