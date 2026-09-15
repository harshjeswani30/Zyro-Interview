const fs = require('fs')
const path = require('path')

/**
 * Stealth process naming for Windows: Task Manager's friendly-name column
 * shows the executable's FileDescription, which electron-builder stamps from
 * `productName` ("Zyro-Ai") during signAndEditResources — and that pass runs
 * after the afterPack hook, so it would overwrite a stamp made there. This
 * afterSign hook is the last word before targets (NSIS) pack the exe, and
 * re-stamps FileDescription/ProductName as "AppService" using the exact
 * rcedit invocation electron-builder itself uses.
 *
 * macOS needs no equivalent here — its binaries are renamed in after-pack.js.
 */
const PROCESS_NAME = 'AppService'

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return

  const exePath = path.join(context.appOutDir, `${PROCESS_NAME}.exe`)
  if (!fs.existsSync(exePath)) return

  const { executeAppBuilder } = require('builder-util')
  const args = [
    exePath,
    '--set-version-string', 'FileDescription', PROCESS_NAME,
    '--set-version-string', 'ProductName', PROCESS_NAME
  ]
  await executeAppBuilder(['rcedit', '--args', JSON.stringify(args)])
  console.log(`[after-sign] Windows: FileDescription/ProductName stamped as "${PROCESS_NAME}"`)
}
