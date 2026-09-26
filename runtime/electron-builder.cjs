const upstream = require('./electron-builder.config.cjs')

module.exports = {
  ...upstream,
  appId: 'dev.phillipleblanc.orc.runtime',
  productName: 'Orc Runtime',
  executableName: 'Orca',
  extraMetadata: { ...upstream.extraMetadata, productName: 'Orc Runtime' },
  protocols: [],
  forceCodeSigning: true,
  mac: {
    ...upstream.mac,
    type: 'development',
    identity: process.env.CSC_NAME,
    hardenedRuntime: true,
    notarize: false,
    // Data assets are sealed by their enclosing bundle's resource signature.
    signIgnore: '\\.(?:pak|png|jpe?g|webp|gif|icns|ttf|woff2?|otf|mp4|webm|bcmap|wasm)$',
    fileAssociations: [],
    extendInfo: {
      ...upstream.mac.extendInfo,
      CFBundleName: 'Orc Runtime',
      CFBundleDisplayName: 'Orc Runtime',
      LSUIElement: true
    },
    extraResources: [
      ...upstream.mac.extraResources,
      { from: 'orc-build.json', to: 'orc-build.json' },
      { from: 'orc-notices', to: 'licenses/orc-runtime' }
    ]
  }
}
