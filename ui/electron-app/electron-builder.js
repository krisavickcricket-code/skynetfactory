/**
 * SkyNetFactory Electron Builder Config
 * Build configuration for Windows EXE.
 */

export default {
  appId: 'com.skynetfactory.app',
  productName: 'SkyNetFactory',
  win: {
    target: 'nsis',
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
    'preload.js',
    'package.json',
  ],
};