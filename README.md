# DSH Mobile — host plugin for DeepSeek Harness

English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

`@kinocode/dsh-mobile` is a DeepSeek Harness (DSH) plugin for the DSH Mobile Android app. It lets you:

- Pair your phone by scanning a QR code in the DSH sidebar.
- Use the regular DSH web UI on your phone through an HTTPS gateway running on your computer.
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

On the phone, the DSH sidebar is hidden so the conversation gets the full width. The round button at the top left opens it over the conversation; picking a session or tapping outside closes it. Desktop-only buttons are hidden.

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
