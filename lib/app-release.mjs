// The DSH Mobile Android build released together with this plugin version. Paired phones get it as
// `app` in the pair and status answers and offer the user to install it; the app checks the size,
// SHA-256, package name, version and signing key before handing it to Android's installer.
// When releasing the plugin, copy app-release.json from the matching `android-v…` release of this
// repository (the app's release workflow attaches it).

/**
 * @typedef {object} AppRelease
 * @property {number} versionCode
 * @property {string} versionName
 * @property {string} url - https://github.com/kinocode-jp/dsh-mobile/releases/download/…
 * @property {string} sha256 - 64 lowercase hex
 * @property {number} size - bytes
 */

/** @type {AppRelease | null} */
export const APP_RELEASE = null
