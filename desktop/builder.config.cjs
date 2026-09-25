// electron-builder configuration. Driven by scripts/build-desktop.sh, which
// stages a per-platform app directory (with the right node-datachannel
// prebuild) and the media engine before calling electron-builder.
const path = require('node:path');

const platform = process.env.PS_TARGET;            // 'linux' | 'win'
if (!platform) throw new Error('run through scripts/build-desktop.sh');
const root = path.join(__dirname, '..');
const stage = path.join(root, 'build', `stage-${platform}`);

module.exports = {
  appId: 'io.github.nicholasvoador.penguinstream',
  productName: 'Penguin Stream',
  copyright: 'Copyright © 2026 Penguin Stream contributors',
  directories: { app: path.join(stage, 'app'), output: path.join(root, 'dist'), buildResources: path.join(__dirname, 'build') },
  npmRebuild: false,                                // node-datachannel is N-API: prebuilt works in Electron
  asar: true,
  asarUnpack: ['**/*.node'],
  extraResources: [{ from: path.join(stage, 'bin'), to: 'bin' }],
  artifactName: 'PenguinStream-${version}-${os}-${arch}.${ext}',
  electronLanguages: ['en-US', 'pt-BR'],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    icon: path.join(__dirname, 'build', 'icon.ico'),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: 'Penguin Stream',
    artifactName: 'PenguinStream-${version}-Setup.${ext}',
  },
  portable: { artifactName: 'PenguinStream-${version}-Portable.${ext}' },

  linux: {
    // Unpacked app only; scripts/build-desktop.sh wraps it in a native RPM
    // (packaging/fedora/penguin-stream.spec) with automatic library Requires.
    target: [{ target: 'dir', arch: ['x64'] }],
    icon: path.join(__dirname, 'build', 'icon.png'),
    category: 'Network;RemoteAccess;',
    synopsis: 'Low-latency remote desktop that works behind CGNAT',
    executableName: 'penguin-stream',
    desktop: { entry: { StartupWMClass: 'Penguin Stream', Keywords: 'remote;desktop;stream;screen;share;' } },
  },
};
