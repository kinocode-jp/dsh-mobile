// The Android build this plugin offers to paired phones (PROTOCOL.md §2.3 in dsh-mobile-relay).
//
// Update this together with an app release: the phone checks versionCode, the download URL, the
// size and the SHA-256, then verifies the APK's package name, version code and signing certificate
// against the running app before it hands the file to the system installer.

const DOWNLOAD_PREFIX = 'https://github.com/kinocode-jp/dsh-mobile/releases/download/'
const SHA256 = /^[0-9a-f]{64}$/
const VERSION_NAME = /^[0-9A-Za-z.+-]{1,32}$/
const DOWNLOAD_PATH = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\.apk$/
const MAX_SIZE = 200 * 1024 * 1024

/** @typedef {{versionCode: number, versionName: string, url: string, sha256: string, size: number}} AppRelease */

/** @type {AppRelease} */
export const APP_RELEASE = Object.freeze({
  versionCode: 17,
  versionName: '0.3.8',
  url: 'https://github.com/kinocode-jp/dsh-mobile/releases/download/android-v0.3.8-17/dsh-mobile-v0.3.8-17.apk',
  sha256: 'ea5f7519289a9a2871c1a57795e4e142bc8903f03c0fff875bc69f94de1995ee',
  size: 36470571,
})

/**
 * The offer to attach to the pair and status answers, or null when this build has no usable entry.
 * A malformed entry is dropped rather than sent: the phone rejects it anyway.
 * @param {AppRelease} release
 * @returns {AppRelease|null}
 */
export function usableAppRelease(release) {
  if (release === null || typeof release !== 'object') return null
  const { versionCode, versionName, url, sha256, size } = release
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) return null
  if (typeof versionName !== 'string' || !VERSION_NAME.test(versionName)) return null
  if (typeof url !== 'string' || url.length > 512 || !url.startsWith(DOWNLOAD_PREFIX)) return null
  if (!DOWNLOAD_PATH.test(url.slice(DOWNLOAD_PREFIX.length))) return null
  if (typeof sha256 !== 'string' || !SHA256.test(sha256.toLowerCase())) return null
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SIZE) return null
  return { versionCode, versionName, url, sha256: sha256.toLowerCase(), size }
}
