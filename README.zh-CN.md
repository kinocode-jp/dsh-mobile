# DSH Mobile — DeepSeek Harness 主机插件

[English](README.md) | 简体中文 | [日本語](README.ja.md)

`@kinocode/dsh-mobile` 是适用于 DSH Mobile Android 应用的 DeepSeek Harness (DSH) 插件。支持以下功能：

- 扫描 DSH 侧边栏中的二维码与手机配对。
- 通过电脑上运行的 HTTPS 网关，在手机上使用原版 DSH Web UI。
- 在桌面端实时会话中，直接通过通知处理审批请求和 Agent 提问（任一设备先提交的回答生效）。
- 当关注的会话结束一轮操作时接收通知。

Android 应用单独分发，不包含在本仓库中。这是一个非官方项目，与 DeepSeek 无关。

## 环境要求

- DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`。锁定此版本区间是因为插件依赖尚未稳定的 DSH Gateway 内部 API。
- DSH Web 服务器（`webserver` 服务），DSH Desktop 内置。
- Node.js 22.4 或更高版本（DSH Desktop 自带的运行环境即可）。
- 手机和电脑处于同一网络，或均加入 [Tailscale](https://tailscale.com/)。
- 通知功能：需要中继服务器（见[通知与中继](#通知与中继)）。

## 安装

在 DSH 插件页面添加 `@kinocode/dsh-mobile`，或运行：

```bash
dsh plugin --profile desktop add @kinocode/dsh-mobile
```

重启 DSH。日志中应显示 `[mobile-bridge] gateway listening {"origins":[...]}`。

## 配对手机

1. 点击 DSH 侧边栏底部的 **スマホを接続**（连接手机）。
2. 在应用中点击 **QR を読み取る**（扫码）并扫描该二维码。如果没有摄像头，可以使用 **リンクをコピー**（复制链接）并将链接粘贴到应用中。
3. 二维码为一次性使用，5 分钟后过期。点击 **新しい QR**（生成新二维码）可重新生成。

该面板还会列出已配对的手机并支持将其移除。移除手机会立即撤销其访问权限。该面板目前仅提供日语界面。

在手机上，DSH 的侧边栏默认隐藏，让对话占满屏幕宽度。点击左上角的圆形按钮可以把侧边栏叠加在对话上方打开；选择会话或点击外部区域即可关闭。仅用于桌面端的按钮也会隐藏。

## 配置

所有字段均为可选。将它们添加到 profile 的 `cordis.patch.yml` 中。Profile patch 会替换插件的完整配置，因此请包含所有需要保留的字段。

```yaml
- id: mobile-bridge
  config:
    relayUrl: https://relay.example.com
    relayEnrollToken: '...'
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `relayUrl` | `''`（关闭） | 用于接收通知并在通知中进行回复的中继服务器。 |
| `relayEnrollToken` | `''` | 仅允许已知电脑接入的中继服务器 Token。 |
| `gatewayEnabled` | `true` | 为手机运行 HTTPS 网关。 |
| `gatewayPort` | `3543` | 网关端口（1024–65535）。 |
| `gatewayHosts` | 自动检测 | 监听的 IPv4 地址。仅接受私网地址（见下文）。 |
| `hostLabel` | 电脑名称 | 显示在手机上的名称。 |
| `previewMaxChars` | `400` | 应用中显示的最长命令预览字符数（50–4000）。 |
| `stateDir` | `$DSH_HOME/mobile-bridge` | 存放主机身份标识、已配对设备和证书的绝对路径。`$DSH_HOME` 默认为 `~/.dsh`。 |

配置 ID `mobile-bridge` 和日志名称 `dsh-mobile-bridge` 保持不变，以兼容旧版本。

## 工作原理

- **网关。** HTTPS 服务器仅监听私网 IPv4 地址：`10/8`、`172.16/12`、`192.168/16` 以及 Tailscale 的 `100.64/10`。证书由插件创建的 CA 签发。二维码包含该 CA 的指纹，因此应用仅对该电脑信任该 CA。
- **配对。** 应用在 Android Keystore 中生成 ECDSA P-256 密钥，并使用一次性代码注册公钥。
- **控制请求。** 获取待处理列表、提交回答和修改设置的请求均使用设备密钥签名。插件会验证签名、时间戳（±5 分钟）以及 nonce 以防止重放攻击。
- **DSH 界面。** 配对后，应用会获得一个有效期为 12 小时的网关会话，该会话使用仅保存在电脑本地的密钥签名。移除设备会立即撤销该会话。网关直接登录本地 DSH Web 服务器；手机端永远不会收到 DSH 本身的登录凭据。
- **实时会话。** 插件作为所有者客户端（owner client）在进程内连接至 DSH Gateway 事件流，相当于一个额外的 GUI 窗口。由于它未注册审批监听器，因此不会抢占桌面端的请求，也不会绕过桌面端。Gateway 接收最先提交的回答，并在其他所有端关闭对应提示。
- **桌面端面板。** 侧边栏面板使用仅限所有者访问的 DSH API 路由（`/api/dsh-mobile-bridge/*`）。

## 通知与中继

使用移动数据的手机无法直接连通网关，因此通知需经由中继服务器转发。插件会与中继维持一条出站 WebSocket 连接。中继通过 Firebase Cloud Messaging 推送通知，并将手机签名的请求转发给电脑。中继无法伪造这些签名，且永远不会接触 DSH 界面或 DSH 的登录凭据。

本项目不提供公共中继。如果不使用中继，只要手机可以直接连通电脑，除通知以外的所有功能均可正常使用。

中继可以读取的内容：

- **推送消息。** 默认包含：会话标题、工具名称或问题标题、最多三个选项、状态以及内部 ID。如果在应用中开启 **ロック画面にコマンド全文を表示**（在锁屏显示完整命令），中继还会看到命令预览或完整问题（最多 400 字符），以及轮次结束时 Agent 最后回复的前 200 个字符。
- **通过中继发送的请求。** 各端点与中继之间的通信经过加密，但并非端到端加密。当手机通过中继路由请求时，中继可以读取待处理列表（完整命令预览、原因、问题）、会话列表（标题和工作目录）以及你的回答（包含自由文本输入）。

请仅使用你自己运行或信任的中继。

在锁屏界面上，除非手机设置为显示敏感内容，否则 Android 仅显示简短的公开摘要。DSH 正常退出时，插件会尝试撤回未关闭的通知（最多等待 3 秒）。如果 DSH 崩溃，应用会在下次加载待处理列表时清理过期的残留通知。

## 故障排查

| 现象 | 排查 |
|---|---|
| 手机无法连接 | 两台设备是否处于同一网络或均连接至 Tailscale？防火墙是否拦截了 3543 端口？如果电脑的 IP 地址发生改变，请生成新的二维码。 |
| "The certificate does not match the QR code" | 该二维码来自其他电脑，或网关 CA 已被重新创建。请生成新的二维码。 |
| 收不到通知 | 手机是否已允许通知？是否设置了 `relayUrl`，且 DSH 日志中是否显示 `relay connected`？会话的权限预设是否会触发审批请求？（“Full access” 从不触发。） |
| 重启 DSH 后 DSH 界面显示空白 | 待 DSH 启动完成后，关闭并重新打开应用。 |

## 安全

报告安全漏洞请参阅 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm test
```

测试使用 Node 内置的测试运行器，无需网络连接或外部依赖。

## 许可证

[MIT](LICENSE)。`lib/vendor/qrcode.mjs` 为 Kazuhiko Arase 开发的 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4（MIT 许可证）。
