# DSH Mobile — host plugin for DeepSeek Harness

English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

`@kinocode/dsh-mobile` is a DeepSeek Harness (DSH) plugin for the DSH Mobile Android app. It lets you:

- Pair your phone by scanning a QR code in the DSH sidebar.
- Use the regular DSH web UI on your phone through an HTTPS gateway running on your computer.
- On phones, let the session title use the available header width and tap it to see the full title. Only the session header reserves space for the floating navigation buttons.
- Answer approval requests and agent questions from notifications in the live desktop session (the first answer from any device wins).
- Receive a notification when a watched session finishes its turn.

The Android app is distributed separately and is not part of this repository. This is an unofficial project, not affiliated with DeepSeek.

## Requirements

- DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`. The range is pinned because the plugin relies on internal DSH Gateway APIs that are not yet stable.
- The DSH web server (`webserver` service), included with DSH Desktop.
- Node.js 22.4 or later (the runtime bundled with DSH Desktop works).
- Phone and computer on the same network, or both on [Tailscale](https://tailscale.com/).
- For notifications: a relay server (see [Notifications and the relay](#notifications-and-the-relay)).

## Install

Add `@kinocode/dsh-mobile` on the DSH Plugins page, or run:

```bash
dsh plugin --profile desktop add @kinocode/dsh-mobile
```

Restart DSH. The log should show `[mobile-bridge] gateway listening {"origins":[...]}`.

## Pair a phone

1. Click **スマホを接続** ("Connect phone") at the bottom of the DSH sidebar.
2. In the app, tap **QR を読み取る** ("Scan QR") and scan the code. If you do not have a camera, use **リンクをコピー** ("Copy link") and paste the link into the app.
3. The code is single-use and expires after 5 minutes. Click **新しい QR** ("New QR") to generate another.

The panel also lists paired phones and lets you remove them. Removing a phone revokes its access immediately. The panel is currently available only in Japanese.

On the phone, the DSH sidebar is hidden so the conversation gets the full width. The round button at the top left opens it over the conversation; picking a session or tapping outside closes it. It reopens where you left the list, including the sessions shown with "さらに…件のセッションを表示" ("Show … more sessions"). Long-press a session and lift your finger to open its menu (pin, rename, fork, archive, copy session ID); this works even when a long title hides the row's buttons. Long-press and drag still reorders sessions as before. A closed project shows the most urgent state among its sessions with the same marks the sessions use (amber dot = waiting for an approval, review or answer, then spinner = running, then green dot = finished and not yet viewed). Desktop-only buttons are hidden.

When you add a workspace on the phone, the computer's folders are listed on the phone instead of opening a folder dialog on the computer. Browse to a folder or type its path, then tap **このフォルダを使う** ("Use this folder").

The right sidebar (files, preview, changes review, browser, terminal) opens full screen on the phone. Buttons that open an app or Finder on the computer are hidden on the phone; the file preview offers **スマホに保存** ("Save to phone") instead, which saves to the phone's Downloads. If the page stays blank after DSH restarts, it reloads by itself.

The round buttons at the top left (sidebar) and top right (right sidebar) can be moved anywhere: long-press one, then drag it.

In DSH's built-in browser (the right sidebar's Browser), words that are not an address are searched: Google on the desktop, Bing on the phone. The phone can only show pages that allow being framed (Google and others refuse), so ↗ (Open in system browser) opens the page in Chrome.

## Configuration

All fields are optional. Add them to your profile's `cordis.patch.yml`. A profile patch replaces the plugin's entire configuration, so include every field you want to keep.

```yaml
- id: mobile-bridge
  config:
    relayUrl: https://relay.example.com
    relayEnrollToken: '...'
```

| Field | Default | Meaning |
|---|---|---|
| `relayUrl` | `''` (off) | Relay used for notifications and answering from them. |
| `relayEnrollToken` | `''` | Token for a relay that only accepts known computers. |
| `gatewayEnabled` | `true` | Run the HTTPS gateway for phones. |
| `gatewayPort` | `3543` | Gateway port (1024–65535). |
| `gatewayHosts` | detected | IPv4 addresses to listen on. Only private addresses are accepted (see below). |
| `hostLabel` | computer name | Name shown on the phone. |
| `previewMaxChars` | `400` | Longest command preview shown in the app (50–4000). |
| `stateDir` | `$DSH_HOME/mobile-bridge` | Absolute path for host identity, paired devices, and certificates. `$DSH_HOME` defaults to `~/.dsh`. |

The configuration ID `mobile-bridge` and log name `dsh-mobile-bridge` are kept for compatibility with earlier versions.

## Phone history loading

Only the phone gateway limits opening history to 40 messages, targeting the latest 10 messages and one turn. Older history loads by itself when you scroll up to the top (once the scroll comes to rest, one page per swipe, keeping your place); the "さらに前の履歴を読み込む" ("Load earlier history") button stays as the loading indicator. Each older page brings at least 150 messages and 6 turns instead of stock DSH's 50 and 2. These budgets count user/assistant messages, not tool events or bytes. No DSH core or desktop changes are required.

An authenticated app-shell script saves opening snapshots in IndexedDB. Reopening the same host/device/session advertises verified SHA-256 record hashes; the gateway sends references for matching records and full data for misses. The browser reconstructs the authoritative snapshot before the stock client sees it. Cursor, projections, header, and assistant-stream baseline always come from the current server snapshot, never an optimistic cached replay. Reading the host's log still uses stock DSH; this optimization reduces phone transfer and initial history size, not host disk work.

Only records of at least 256 serialized UTF-8 bytes are advertised, with the hash property limited to 8KiB. If none qualify, no manifest is uploaded. Delta selection accounts for manifest upload as well as download savings. A complete cache miss can still incur the already-uploaded manifest overhead; total traffic is not guaranteed to shrink in every case.

Relay writes are serialized with source pause/resume while the destination drains. Buffered data exceeding 64MiB no longer causes termination. Stock WebSocket's 100MiB per-frame limit still applies; the message-count budget is not a byte limit.

The cache retains opening snapshots only, bounded globally to 12 sessions and 8MiB with a seven-day reuse expiry. Expired entries are removed during a later save/trim; physical deletion while the app is inactive is not guaranteed. It contains conversation text and tool results. On shared devices set `historyCacheEnabled: false` to stop persistence/reuse; this does not erase existing records. Clear the app/WebView's stored data in Android settings to erase them (pairing may need repeating). Revoking a device blocks connections and cache reuse, but does not remotely erase stored data. Storage denial falls back to online loading; a missing reference invalidates that cache entry and reconnects for a full snapshot. Storage is origin-specific, so changing LAN addresses causes a cold load; a stable Tailscale origin improves reuse.

| Field | Default | Meaning |
|---|---|---|
| `historyEnabled` | `true` | Optimize phone history; false restores stock transport. |
| `historyCacheEnabled` | `true` | Save/reuse device history independently of opening-page sizing. |
| `historyMaxMessages` | `40` | Opening cap, integer 1–500. |
| `historyMinMessages` | `10` | Recent messages before turn alignment, integer 1–cap; defaults to the smaller cap when below 10. |
| `historyOlderMinMessages` | `150` | Messages each "load older history" page brings at least (1–500); stock DSH asks for 50. |
| `historyOlderMinTurns` | `6` | Turns each "load older history" page brings at least (1–50); stock DSH asks for 2. DSH's 500-message page cap still applies. |

Restart the DSH process loading this plugin, then reload the phone screen. Run `node --test test/*.test.mjs` for unit/TLS lifecycle tests. For a real Chromium persistence/reload/delta smoke, supply Playwright with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/history-browser.smoke.mjs`; optionally set `CHROME_PATH` to the Chrome executable.

## How it works

- **Gateway.** The HTTPS server listens only on private IPv4 addresses: `10/8`, `172.16/12`, `192.168/16`, and Tailscale's `100.64/10`. Certificates come from a CA created by the plugin. The QR code contains the CA fingerprint, so the app trusts only that CA for this computer.
- **Pairing.** The app generates an ECDSA P-256 key in the Android Keystore and registers the public key using the one-time code.
- **Control requests.** Requests for the pending list, answers, and settings are signed with the device key. The plugin verifies the signature, a timestamp (±5 minutes), and a nonce to prevent replay attacks.
- **DSH screen.** After pairing, the app receives a 12-hour gateway session signed with a secret that never leaves the computer. Removing the device revokes it immediately. The gateway logs in to the local DSH web server directly; the phone never receives DSH's own login.
- **Live session.** The plugin connects to the DSH Gateway event stream in-process as an owner client, like an additional GUI window. Because it registers no approval listener, it cannot take requests away from the desktop or bypass it. The Gateway accepts the first answer submitted and closes the prompt everywhere else.
- **Desktop panel.** The sidebar panel uses owner-only DSH API routes (`/api/dsh-mobile-bridge/*`).

## Notifications and the relay

A phone on mobile data cannot reach the gateway directly, so notifications go through a relay. The plugin maintains an outbound WebSocket to it. The relay delivers push notifications through Firebase Cloud Messaging and forwards the phone's signed requests to your computer. It cannot create those signatures, and it never handles the DSH screen or DSH's login.

No public relay is provided. Without one, all features except notifications work as long as the phone can reach the computer directly.

What the relay can read:

- **Push messages.** By default: the session title, the tool name or question heading, up to three answer options, status, and internal IDs. If you turn on **ロック画面にコマンド全文を表示** ("Show full command on the lock screen") in the app, the relay also sees the command preview or full question (up to 400 characters) and the first 200 characters of the agent's last reply when a turn ends.
- **Requests sent through the relay.** Traffic is encrypted between each endpoint and the relay, but not end-to-end. When the phone routes requests through the relay, the relay can read the pending list (full command preview, reason, questions), the session list (titles and working directories), and your answers, including free-text replies.

Only use a relay you run yourself or trust.

On the lock screen, Android displays a short public summary unless the phone is set to show sensitive content. When DSH quits normally, the plugin tries to withdraw open notifications (waiting up to 3 seconds). If DSH crashes, the app removes stale notifications the next time it loads the pending list.

## Troubleshooting

| Symptom | Check |
|---|---|
| The phone cannot connect | Are both devices on the same network or on Tailscale? Is a firewall blocking port 3543? If the computer's IP address changed, generate a new QR code. |
| "The certificate does not match the QR code" | The code is from another computer, or the gateway CA was recreated. Generate a new QR code. |
| No notifications | Are notifications enabled on the phone? Is `relayUrl` set, and does the DSH log show `relay connected`? Does the session's permission preset ask for approval? ("Full access" never does.) |
| The DSH screen is blank after a DSH restart | Close and reopen the app once DSH has finished starting. |

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```bash
npm test
```

The tests use Node's built-in test runner and require no network access or external dependencies.

## License

[MIT](LICENSE). `lib/vendor/qrcode.mjs` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase (MIT).
