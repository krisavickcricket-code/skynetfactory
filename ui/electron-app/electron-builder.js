/**
 * SkyNetFactory Electron Builder Config
 * Build configuration for Windows EXE.
 */

module.exports = {
  appId: 'com.skynetfactory.app',
  productName: 'SkyNetFactory',
  win: {
    target: 'nsis',
    icon: 'assets/icon.png',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  directories: {
    output: 'dist/electron',
  },
  files: [
    'dist/renderer/**/*',
    'main.js',
    'package.json',
  ],
};