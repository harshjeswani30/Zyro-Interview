const fs = require('fs')
const path = require('path')

/**
 * Stealth process naming for macOS — mirrors the Windows build's behaviour:
 * user-facing surfaces (Finder, Spotlight, Launchpad, Dock) say "Zyro-Ai",
 * while every process-list surface (Activity Monitor, ps, top) says
 * "AppService".
 *
 * electron-builder names the macOS bundle, the main binary and the Electron
 * helper binaries after `productName` ("Zyro-Ai"). The bundle keeps the
 * brand; this hook renames the binaries (and every "Zyro-Ai Helper" bundle
 * in Contents/Frameworks) to "AppService…" and repoints CFBundleExecutable
 * at the new names.
 *
 * Runs per temp arch build during universal builds and again on the merged
 * app — every step is idempotent. Windows has its own hook (after-sign.js)
 * because its FileDescription gets (re)stamped after afterPack.
 */
const PROCESS_NAME = 'AppService'

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const brand = context.packager.appInfo.productFilename
  if (brand === PROCESS_NAME) return

  const appBundle = path.join(context.appOutDir, `${brand}.app`)
  if (!fs.existsSync(appBundle)) return

  renameBundleExecutable(path.join(appBundle, 'Contents'), brand, PROCESS_NAME)

  const frameworksDir = path.join(appBundle, 'Contents', 'Frameworks')
  for (const entry of fs.readdirSync(frameworksDir)) {
    // "Zyro-Ai Helper.app", "Zyro-Ai Helper (GPU).app", "(Renderer)", "(Plugin)"…
    if (!entry.endsWith('.app') || !entry.startsWith(`${brand} Helper`)) continue
    const helperFrom = entry.slice(0, -'.app'.length)
    const helperTo = helperFrom.replace(brand, PROCESS_NAME)
    renameBundleExecutable(path.join(frameworksDir, entry, 'Contents'), helperFrom, helperTo)
    fs.renameSync(path.join(frameworksDir, entry), path.join(frameworksDir, `${helperTo}.app`))
  }
  console.log(`[after-pack] macOS: bundle "${brand}.app" keeps the brand; process names renamed to "${PROCESS_NAME}"`)
}

function renameBundleExecutable(contentsDir, from, to) {
  const binaryFrom = path.join(contentsDir, 'MacOS', from)
  const binaryTo = path.join(contentsDir, 'MacOS', to)
  if (fs.existsSync(binaryFrom)) fs.renameSync(binaryFrom, binaryTo)

  const plistPath = path.join(contentsDir, 'Info.plist')
  const plist = fs.readFileSync(plistPath, 'utf8')
  fs.writeFileSync(
    plistPath,
    plist.replace(
      /(<key>CFBundleExecutable<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${to}$2`
    )
  )
}
