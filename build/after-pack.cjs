/**
 * Ad-hoc sign the packaged app.
 *
 * electron-builder renames the Electron executable and rewrites Info.plist,
 * which invalidates the signature the binary shipped with. On Apple silicon a
 * bundle whose Info.plist is not bound to its signature is unreliable, so
 * re-sign it. This is an ad-hoc signature: enough for the app to run on the
 * machine that built it, not a substitute for a Developer ID for distribution.
 */
const { execFileSync } = require('node:child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  })
  console.log(`  • ad-hoc signed  ${appPath}`)
}
