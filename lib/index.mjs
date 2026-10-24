// dsh-mobile-bridge — DeepSeek Harness host plugin.
//
// Lets the DSH Mobile Android app answer approvals and ask_user_question prompts for the same
// live session the desktop shows, and pushes "approval needed" / "turn finished" to the phone.
// It also serves its own HTTPS gateway for the phone (pairing QR, WebView proxy of the stock DSH
// Web UI, direct control), so no other plugin is needed. Overview: README.md.

import { isIP } from 'node:net'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { NonceCache, RegistrationCodes } from './auth.mjs'
import { APP_RELEASE, usableAppRelease } from './app-release.mjs'
import { createControlHandler } from './control.mjs'
import { desktopRoutes } from './desktop-api.mjs'
import { Gateway } from './gateway.mjs'
import { GatewayClient } from './gateway-client.mjs'
import { Notifier } from './push.mjs'
import { RelayTunnel, tunnelUrl } from './relay-tunnel.mjs'
import { SessionTracker, createTitleLookup } from './sessions.mjs'
import { StateStore } from './state.mjs'
import { TlsStore, privateRange } from './tls-store.mjs'
import { Upstream } from './upstream.mjs'
import { WebSessions } from './web-sessions.mjs'

export const name = 'dsh-mobile-bridge'
export const inject = ['connection', 'typertGateway']

export const VERSION = '0.3.15'

/**
 * @typedef {object} BridgeConfig
 * @property {string} stateDir - absolute directory for state.json (host identity, devices); default $DSH_HOME/mobile-bridge
 * @property {boolean} gatewayEnabled - serve the phone gateway (default true)
 * @property {number} gatewayPort - gateway TLS port on every private IPv4 address (default 3543)
 * @property {string[]|undefined} gatewayHosts - fixed IPv4 listen addresses instead of auto-detection
 * @property {string} relayUrl - https:// relay base, or '' to run without push / native control
 * @property {string} relayEnrollToken - optional token for a relay that restricts new hosts
 * @property {string} hostLabel - computer name shown on the phone
 * @property {number} previewMaxChars - max characters of command preview shown in the app
 * @property {boolean} historyEnabled - optimize phone-only history openings (default true)
 * @property {boolean} historyCacheEnabled - allow scoped device history caching (default true)
 * @property {number} historyMaxMessages - opening message cap, 1..500 (default 40)
 * @property {number} historyMinMessages - desired recent messages before turn alignment (default 10)
 * @property {number} historyOlderMinMessages - messages each "load older history" page brings at least, 1..500 (default 150)
 * @property {number} historyOlderMinTurns - Turn starts each "load older history" page brings at least, 1..50 (default 6)
 */

/** DSH home as the `dsh` launcher resolves it (`DSH_HOME`, else ~/.dsh). */
function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Validate the profile configuration; misconfiguration fails loudly at load.
 * Every field is optional because a profile patch replaces the whole bundle config:
 * a user who only writes `relayUrl` still gets working defaults.
 * @param {Record<string, unknown>} [raw]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {BridgeConfig}
 */
export function parseConfig(raw = {}, env = process.env) {
  raw = raw ?? {}
  const stateDir = raw.stateDir === undefined || raw.stateDir === '' ? join(dshHome(env), 'mobile-bridge') : raw.stateDir
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('dsh-mobile-bridge: config.stateDir must be an absolute path')
  const gatewayEnabled = raw.gatewayEnabled !== false
  const gatewayPort = raw.gatewayPort === undefined ? 3543 : Number(raw.gatewayPort)
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) throw new Error('dsh-mobile-bridge: config.gatewayPort must be an integer 1024..65535')
  let gatewayHosts
  if (raw.gatewayHosts !== undefined && raw.gatewayHosts !== null) {
    if (!Array.isArray(raw.gatewayHosts) || !raw.gatewayHosts.every(h => typeof h === 'string' && isIP(h) === 4 && privateRange(h) !== undefined)) {
      throw new Error('dsh-mobile-bridge: config.gatewayHosts must list private IPv4 addresses (10/8, 172.16/12, 192.168/16 or 100.64/10)')
    }
    gatewayHosts = [...raw.gatewayHosts]
  }
  const relayUrl = raw.relayUrl === undefined || raw.relayUrl === null ? '' : String(raw.relayUrl).trim()
  if (relayUrl !== '') tunnelUrl(relayUrl, '00000000-0000-4000-8000-000000000000')
  const relayEnrollToken = raw.relayEnrollToken === undefined || raw.relayEnrollToken === null ? '' : String(raw.relayEnrollToken)
  const hostLabel = typeof raw.hostLabel === 'string' && raw.hostLabel.trim() !== '' ? raw.hostLabel.trim().slice(0, 80) : hostname().replace(/\.(local|lan|home)$/, '')
  const previewMaxChars = raw.previewMaxChars === undefined ? 400 : Number(raw.previewMaxChars)
  if (!Number.isInteger(previewMaxChars) || previewMaxChars < 50 || previewMaxChars > 4000) throw new Error('dsh-mobile-bridge: config.previewMaxChars must be an integer 50..4000')
  const historyEnabled = raw.historyEnabled !== false
  const historyCacheEnabled = raw.historyCacheEnabled !== false
  const historyMaxMessages = raw.historyMaxMessages === undefined ? 40 : Number(raw.historyMaxMessages)
  const historyMinMessages = raw.historyMinMessages === undefined ? Math.min(10, historyMaxMessages) : Number(raw.historyMinMessages)
  if (!Number.isSafeInteger(historyMaxMessages) || historyMaxMessages < 1 || historyMaxMessages > 500) throw new Error('dsh-mobile-bridge: config.historyMaxMessages must be an integer 1..500')
  if (!Number.isSafeInteger(historyMinMessages) || historyMinMessages < 1 || historyMinMessages > historyMaxMessages) throw new Error('dsh-mobile-bridge: config.historyMinMessages must be an integer 1..historyMaxMessages')
  const historyOlderMinMessages = raw.historyOlderMinMessages === undefined ? 150 : Number(raw.historyOlderMinMessages)
  const historyOlderMinTurns = raw.historyOlderMinTurns === undefined ? 6 : Number(raw.historyOlderMinTurns)
  if (!Number.isSafeInteger(historyOlderMinMessages) || historyOlderMinMessages < 1 || historyOlderMinMessages > 500) throw new Error('dsh-mobile-bridge: config.historyOlderMinMessages must be an integer 1..500')
  if (!Number.isSafeInteger(historyOlderMinTurns) || historyOlderMinTurns < 1 || historyOlderMinTurns > 50) throw new Error('dsh-mobile-bridge: config.historyOlderMinTurns must be an integer 1..50')
  return { stateDir, gatewayEnabled, gatewayPort, gatewayHosts, relayUrl, relayEnrollToken, hostLabel, previewMaxChars, historyEnabled, historyCacheEnabled, historyMaxMessages, historyMinMessages, historyOlderMinMessages, historyOlderMinTurns }
}

/**
 * @param {any} ctx - Cordis context
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = parseConfig(rawConfig)
  const log = (...args) => console.log('[mobile-bridge]', ...args)
  const logError = (label) => (error) => log(label, error?.message ?? String(error))

  const state = new StateStore(config.stateDir, { log })
  const codes = new RegistrationCodes()
  const nonces = new NonceCache()
  const tls = new TlsStore(join(config.stateDir, 'tls'), { log })
  const webSessions = new WebSessions({ secret: () => state.webSessionSecret, isActive: id => state.device(id) !== undefined })
  /** @type {RelayTunnel | undefined} */
  let tunnel
  /** @type {Notifier | undefined} */
  let notifier

  const sessions = new SessionTracker({
    onTurnEnd: (sessionId, reason) => {
      ensureTitle(sessionId)
        .then(() => notifier?.turnEnded(sessionId, reason))
        .catch(logError('turn push failed:'))
    },
  })
  ctx.on('session/event', (session, event) => sessions.observe(session, event))

  const listSessions = async () => {
    const controller = ctx.get('sessionController')
    if (controller === undefined) return []
    const value = await controller.list({}, AbortSignal.timeout(5000))
    return Array.isArray(value?.items) ? value.items : []
  }
  const ensureTitle = createTitleLookup({ sessions, listSessions, log })

  const gateway = new GatewayClient({
    connection: () => ctx.connection,
    gateway: () => ctx.typertGateway,
    log,
    hooks: {
      onPending: (pending) => {
        ensureTitle(pending.sessionId)
          .then(() => notifier?.pending(pending))
          .catch(logError('push failed:'))
      },
      onResolved: (eventId, { by }) => {
        const deviceId = by.startsWith('device:') ? by.slice('device:'.length) : undefined
        notifier?.resolved(eventId, deviceId).catch(logError('resolve push failed:'))
      },
      onReadyChange: (ready) => log(ready ? 'joined DSH event stream' : 'left DSH event stream'),
    },
  })

  /** @type {Gateway | undefined} */
  let phoneGateway
  const control = createControlHandler({
    state,
    nonces,
    codes,
    gateway,
    sessions,
    webSessions,
    origins: () => phoneGateway?.origins() ?? [],
    relayUrl: config.relayUrl,
    hostLabel: config.hostLabel,
    version: VERSION,
    appRelease: usableAppRelease(APP_RELEASE),
    previewMaxChars: config.previewMaxChars,
    log,
    listSessions,
  })

  /** Resolves once state is loaded; the extension action waits on it. */
  let started
  ctx.effect(() => {
    const lifetime = new AbortController()
    started = (async () => {
      await state.load()
      notifier = new Notifier({ state, sessions, tunnel: () => tunnel, previewMaxChars: config.previewMaxChars, log })
      gateway.run(lifetime.signal).catch(logError('event stream stopped:'))
      if (config.relayUrl !== '') {
        tunnel = new RelayTunnel({
          relayUrl: config.relayUrl,
          hostId: state.hostId,
          hostSecret: state.hostSecret,
          enrollToken: config.relayEnrollToken,
          label: config.hostLabel,
          version: VERSION,
          handle: control.handle,
          log,
        })
        tunnel.run(lifetime.signal).catch(logError('relay tunnel stopped:'))
      } else {
        log('relayUrl is not set: phones can use the WebView, but push and notification actions are off')
      }
      if (config.gatewayEnabled) {
        const webServer = ctx.get('webServer')
        if (webServer === undefined) {
          log('gateway disabled: this DSH has no local web server (webServer service) to proxy')
        } else {
          phoneGateway = new Gateway({
            port: config.gatewayPort,
            hosts: config.gatewayHosts,
            history: { enabled: config.historyEnabled, cacheEnabled: config.historyCacheEnabled, maxMessages: config.historyMaxMessages, minMessages: config.historyMinMessages, olderMinMessages: config.historyOlderMinMessages, olderMinTurns: config.historyOlderMinTurns },
            tls,
            webSessions,
            handleControl: control.handle,
            pair: body => control.pair(body),
            upstream: new Upstream({ port: () => ctx.get('webServer')?.port, authenticatedUrl: url => ctx.connection.authenticatedUrl(url), log }),
            hostId: () => state.hostId,
            log,
          })
          phoneGateway.run(lifetime.signal).catch(logError('gateway stopped:'))
        }
      }
      log('started', JSON.stringify({ hostId: state.hostId, relay: config.relayUrl !== '', gateway: phoneGateway !== undefined }))
    })()
    started.catch(logError('start failed:'))
    return async () => {
      // Requests die with this process: take their notifications off the phones while the relay
      // tunnel is still up (bounded, so a dead relay cannot hold up DSH's shutdown).
      const withdrawn = await Promise.race([
        notifier?.withdrawAll().catch(() => 0) ?? 0,
        new Promise(resolve => setTimeout(resolve, 3000, -1)),
      ])
      if (withdrawn === -1) log('withdrawing open notifications timed out on shutdown')
      else if (withdrawn !== 0) log('withdrew open notifications on shutdown', JSON.stringify({ count: withdrawn }))
      lifetime.abort()
      await started.catch(() => {})
      await state.close()
    }
  }, 'mobile-bridge: runtime')

  // Desktop sidebar panel: QR, status and device list, reachable only by the DSH owner.
  ctx.effect(() => {
    const routes = desktopRoutes({
      state,
      codes,
      get gateway() { return phoneGateway ?? emptyGateway },
      tls,
      webSessions,
      relay: () => ({ configured: config.relayUrl !== '', connected: tunnel?.connected === true }),
      hostLabel: config.hostLabel,
      version: VERSION,
      log,
    })
    const disposers = routes.map(route => ctx.connection.fetch.register({
      ...route,
      fetch: async (request) => {
        await started
        return route.fetch(request)
      },
    }))
    return () => { for (const dispose of disposers) void dispose() }
  }, 'mobile-bridge: desktop api')
}

/** Stand-in while the gateway is disabled or not started. */
const emptyGateway = { origins: () => [], running: false, deps: { port: 0 } }
