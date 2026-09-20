/**
 * Submit the signed app to Apple for notarization.
 *
 * Credentials come from a notarytool keychain profile rather than anything in
 * the repo, so no secret is ever committed. Create it once with:
 *
 *   xcrun notarytool store-credentials "relay" \
 *     --apple-id <your-apple-id> --team-id 3FJ5SR5745 --password <app-specific-password>
 *
 * When the profile is absent this is skipped with a warning rather than
 * failing the build, so a local build still works without credentials.
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')

const PROFILE = 'relay'

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('  • notarization skipped  reason=SKIP_NOTARIZE=1')
    return
  }

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  if (!existsSync(appPath)) return

  try {
    execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE], {
      stdio: 'ignore',
    })
  } catch {
    console.warn(
      `  • notarization skipped  reason=no notarytool profile "${PROFILE}" ` +
        '(see build/notarize.cjs for how to create one)',
    )
    return
  }

  console.log(`  • notarizing  ${appPath} — this usually takes a few minutes`)
  execFileSync(
    'xcrun',
    ['notarytool', 'submit', appPath, '--keychain-profile', PROFILE, '--wait'],
    { stdio: 'inherit' },
  )
  // Staple the ticket so the app opens even on a machine that is offline.
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
  console.log('  • notarized and stapled')
}
