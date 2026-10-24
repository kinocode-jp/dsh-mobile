// dsh-mobile-bridge — browser half, loaded into the DSH Web UI.
// 1. Adds a sidebar footer button 「スマホを接続」 that shows the pairing QR and the paired phones
//    (data from the owner-only /api/dsh-mobile-bridge/* routes registered by desktop-api.mjs).
// 2. Lets the DSH Mobile app open a session: the app's page script dispatches
//    `dsh-mobile-bridge:open-session` and this calls the Client Workspace service.
// 3. Inside the app's WebView only, switches to a phone layout (see phoneLayout below) and replaces
//    the workspace folder chooser, which would otherwise open on the computer (PhoneDirectoryFlow).
window.__ModuleLoader__.load({
  id: "@kinocode/dsh-mobile",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const reactDom = require("react-dom");
    const inject = ["slots"];
    const SESSION_ID = /^[A-Za-z0-9_:.-]{1,200}$/;
    const API = "/api/dsh-mobile-bridge";
    const PANEL_ID = "dsh-mobile-bridge-panel";

    const STYLE = `
#${PANEL_ID}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);font:14px/1.6 system-ui,-apple-system,"Hiragino Sans",sans-serif}
#${PANEL_ID} .dmb-card{background:#fff;color:#1a1a1a;border-radius:16px;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
#${PANEL_ID} h2{font-size:17px;margin:0 0 4px}
#${PANEL_ID} .dmb-sub{color:#666;font-size:12.5px;margin:0 0 14px}
#${PANEL_ID} .dmb-qr{display:flex;justify-content:center;background:#fff;border-radius:12px;padding:8px;margin:6px 0 8px}
#${PANEL_ID} .dmb-qr svg{width:260px;height:260px}
#${PANEL_ID} .dmb-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid #eee}
#${PANEL_ID} .dmb-muted{color:#777;font-size:12px}
#${PANEL_ID} button{font:inherit;border-radius:8px;border:1px solid #ccc;background:#f6f6f6;padding:5px 12px;cursor:pointer}
#${PANEL_ID} button.dmb-primary{background:#0e6e62;border-color:#0e6e62;color:#fff}
#${PANEL_ID} .dmb-err{color:#b00020;margin:8px 0}
#${PANEL_ID} .dmb-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
@media (prefers-color-scheme: dark){#${PANEL_ID} .dmb-card{background:#1f1f1f;color:#eee}#${PANEL_ID} .dmb-row{border-color:#333}#${PANEL_ID} button{background:#2b2b2b;border-color:#444;color:#eee}#${PANEL_ID} .dmb-sub,#${PANEL_ID} .dmb-muted{color:#aaa}}
.dmb-trigger{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:inherit;font:inherit;padding:6px 10px;border-radius:8px;cursor:pointer}
.dmb-trigger:hover{background:rgba(127,127,127,.12)}
.dmb-trigger.is-rail{justify-content:center;padding:8px 0}`;

    function el(tag, attrs, children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (k === "text") node.textContent = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
      for (const child of children || []) if (child) node.append(child);
      return node;
    }

    async function api(path, init) {
      // Same shape as DSH's own connection RPC (no `cache` option: the desktop app forwards
      // `/api` through its dsh-app:// protocol handler; the routes already send no-store).
      let response;
      try {
        response = await fetch(API + path, Object.assign({ headers: { "content-type": "application/json" } }, init || {}));
      } catch (e) {
        console.error("[dsh-mobile-bridge] fetch failed", API + path, e);
        throw new Error("通信できませんでした（" + (e && e.message ? e.message : String(e)) + "）");
      }
      let body = {};
      try { body = await response.json(); } catch (e) { /* empty body */ }
      if (!response.ok) throw new Error(body && typeof body.error === "string" ? body.error : "HTTP " + response.status);
      return body;
    }

    function formatTime(ms) {
      if (!ms) return "—";
      try { return new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return "—"; }
    }

    const ERRORS = {
      gateway_not_listening: "接続口が起動していません。Wi-Fi か Tailscale に接続しているか確認してください。",
    };

    function openPanel() {
      if (document.getElementById(PANEL_ID)) return;
      let timer = 0;
      const qrBox = el("div", { class: "dmb-qr" }, [el("span", { class: "dmb-muted", text: "QR を準備しています…" })]);
      let currentLink = "";
      const copyButton = el("button", { type: "button", text: "リンクをコピー", title: "カメラが使えないときは、このリンクをアプリの「リンクを貼り付け」に入れてください", onclick: async () => {
        if (!currentLink) return;
        try {
          await navigator.clipboard.writeText(currentLink);
          copyButton.textContent = "コピーしました";
          setTimeout(() => { copyButton.textContent = "リンクをコピー"; }, 2000);
        } catch (e) {
          window.prompt("このリンクをコピーしてください", currentLink);
        }
      } });
      const expiry = el("p", { class: "dmb-muted" });
      const error = el("p", { class: "dmb-err" });
      const devices = el("div");
      const status = el("p", { class: "dmb-muted" });
      const close = () => { clearInterval(timer); overlay.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      const card = el("div", { class: "dmb-card", role: "dialog", "aria-modal": "true", "aria-label": "スマホを接続" }, [
        el("h2", { text: "スマホを接続" }),
        el("p", { class: "dmb-sub", text: "DSH Mobile アプリの「QR を読み取る」でこの QR を読み取ってください。QR は 5 分間・1 回だけ使えます。" }),
        qrBox, expiry, error, status,
        el("h2", { text: "接続中の端末", style: "margin-top:16px;font-size:15px" }),
        devices,
        el("div", { class: "dmb-actions" }, [
          copyButton,
          el("button", { type: "button", text: "新しい QR", onclick: () => refreshQr() }),
          el("button", { type: "button", class: "dmb-primary", text: "閉じる", onclick: close }),
        ]),
      ]);
      const overlay = el("div", { id: PANEL_ID, onclick: (e) => { if (e.target === overlay) close(); } }, [card]);
      document.body.append(overlay);
      document.addEventListener("keydown", onKey);

      async function refreshQr() {
        error.textContent = "";
        try {
          const pairing = await api("/pairing", { method: "POST", body: "{}" });
          qrBox.innerHTML = pairing.qrSvg;
          currentLink = pairing.qr;
          const until = pairing.expiresAt;
          clearInterval(timer);
          const tick = () => {
            const left = Math.max(0, Math.round((until - Date.now()) / 1000));
            expiry.textContent = left > 0 ? "有効期限まで " + Math.floor(left / 60) + " 分 " + (left % 60) + " 秒（接続先: " + pairing.origins.join(", ") + "）" : "期限切れです。「新しい QR」を押してください。";
            if (left === 0) clearInterval(timer);
          };
          tick();
          timer = setInterval(tick, 1000);
        } catch (e) {
          qrBox.textContent = "";
          error.textContent = ERRORS[e.message] || ("QR を作れませんでした: " + e.message);
        }
      }

      async function refreshDevices() {
        try {
          const [list, st] = await Promise.all([api("/devices"), api("/status")]);
          status.textContent = "PC 名: " + st.hostLabel + " ／ 通知: " + (st.relay.configured ? (st.relay.connected ? "リレー接続中" : "リレー未接続") : "リレー未設定（アプリ内の承認のみ）");
          devices.replaceChildren();
          if (list.devices.length === 0) devices.append(el("p", { class: "dmb-muted", text: "まだ端末はありません。" }));
          for (const d of list.devices) {
            devices.append(el("div", { class: "dmb-row" }, [
              el("div", {}, [
                el("div", { text: d.label || "Android" }),
                el("div", { class: "dmb-muted", text: "最終接続 " + formatTime(d.lastSeenAt) + (d.hasPush ? " ・ 通知あり" : " ・ 通知なし") }),
              ]),
              el("button", { type: "button", text: "削除", onclick: async () => {
                if (!window.confirm((d.label || "この端末") + " の接続を削除しますか？")) return;
                try { await api("/devices/revoke", { method: "POST", body: JSON.stringify({ deviceId: d.deviceId }) }); } catch (e) { error.textContent = "削除できませんでした: " + e.message; }
                refreshDevices();
              } }),
            ]));
          }
        } catch (e) {
          error.textContent = "状態を取得できませんでした: " + e.message;
        }
      }

      refreshQr();
      refreshDevices();
    }

    function PhoneIcon(size) {
      return react.createElement("svg", { "aria-hidden": true, width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" },
        react.createElement("rect", { x: 4, y: 1.5, width: 8, height: 13, rx: 1.6 }),
        react.createElement("path", { d: "M7 12.2h2" }));
    }

    function Trigger(props) {
      const wide = props && props.wide;
      return react.createElement("button", {
        type: "button",
        className: "dmb-trigger" + (wide ? "" : " is-rail"),
        title: "スマホを接続",
        "aria-label": "スマホを接続",
        onClick: openPanel,
      }, PhoneIcon(wide ? 16 : 18), wide ? react.createElement("span", null, "スマホを接続") : null);
    }

    // Phone layout, only inside the DSH Mobile WebView: the conversation gets the full width, the
    // left sidebar opens over it from a small floating button, and the right sidebar (file preview,
    // files, changes review, browser, terminal) uses DSH's own full-screen mode for narrow frames.
    // The goal is that everything the desktop can do also works here; only controls that act on
    // the computer's own screen are hidden or replaced. DSH's markup is not a public API, so
    // everything is matched loosely (data-* hooks first, then class name fragments, accessible
    // names) and the page still works if it misses.
    const PHONE_HIDDEN_LABELS = [
      "Finderで開く", "他の開き方", "分割",
      "Open in Finder", "More ways to open", "Split",
    ];
    const SIDEBAR_TOGGLE_LABEL = /サイドバーを(開く|折りたたむ)|^(Open|Collapse) sidebar$/;
    const NEW_SESSION_LABEL = /^(新規セッション|New session)$/;
    // "<workspace>で新規セッションを作成" on a workspace row, and the footer's account menu trigger.
    const WORKSPACE_NEW_SESSION_LABEL = /で新規セッションを作成$|^New session in |^在“.*”中新建会话$/;
    const ACCOUNT_MENU_LABEL = /^(アカウントメニュー|Account menu|账号菜单)$/;
    // Header count buttons, by their accessible names in DSH's languages.
    const HEADER_SUBAGENTS = /サブエージェント|subagent|子代理|子智能体/i;
    const HEADER_JOBS = /バックグラウンド|background job|后台/i;
    const HEADER_LIVE = /実行中|running|运行中/i;
    const SESSION_ROW = "[data-row-key^='session:']";
    const ROW_ACTIONS = "[class*='_rowActions']";
    const SIDEBAR_SCROLL_KEY = "dsh-mobile-bridge:sidebar-scroll";
    // How long an opening keeps trying to put the list back, and for how many frames a list that has
    // stopped short of the saved offset (nothing left to page in) is given before the restore stops.
    const SIDEBAR_RESTORE_MS = 2500;
    const SIDEBAR_RESTORE_SETTLE_FRAMES = 12;
    // How long a restore keeps going while the sidebar is not yet reported open (it opens on the next render).
    const SIDEBAR_OPEN_GRACE_MS = 300;
    // How long a restore waits for a saved workspace's sessions to be drawn before setting the offset anyway.
    const SIDEBAR_SESSIONS_WAIT_MS = 1000;
    // DSH's own workspace-browser view settings (read only, for its "workspace tree" grouping).
    const WORKSPACE_VIEW_KEY = "dsh.workspace.view.v5";
    // How long a save of the list position waits for more scrolling before writing.
    const SIDEBAR_PERSIST_MS = 250;
    // Older history starts loading this far from the top (or 1.5 screens, whichever is more), once
    // scrolling has been still for OLDER_SETTLE_MS, up to OLDER_ARM_MS after the reader's last touch or
    // wheel (covers momentum scrolling).
    const OLDER_NEAR_TOP_PX = 800;
    const OLDER_ARM_MS = 4000;
    const OLDER_SETTLE_MS = 250;
    const OLDER_WHEEL_GAP_MS = 400;
    // A finger pulled down this far in a chat too short to scroll counts as scrolling up; a finger that
    // moved less than the slop was a tap.
    const OLDER_PULL_PX = 24;
    const OLDER_SLOP_PX = 10;
    // How often a gesture that reached the top while a page was still loading looks again.
    const OLDER_BUSY_RETRY_MS = 300;
    // How long after the finger lifts a scroll still counts as the reader's (momentum).
    const OLDER_MOMENTUM_MS = 1500;
    // How long after a session is picked its automatic message-box focus is undone.
    const COMPOSER_FOCUS_QUIET_MS = 2000;
    // Settings swipe-to-close: movement before a swipe counts, and the slide-out / spring-back time.
    // The app's own sidebar swipe starts at 10px sideways; settings take a sideways touch before that.
    const SWIPE_HOLD_PX = 4;
    const SWIPE_START_PX = 8;
    const SWIPE_SETTLE_MS = 180;
    const PHONE_STYLE = [
      // The app frame is the grid that holds the right column ([class*='_frame'] would also match
      // frames inside images and the chat).
      "html.dmb-phone div:has(> [data-rightbar-col]) { grid-template-columns: 0 minmax(0, 1fr) 0 !important; }",
      "html.dmb-phone [class*='_centerCol'] { grid-column: 2 !important; grid-row: 1 !important; }",
      // The right panel is anchored to its column's right edge: keep that column at the far right.
      "html.dmb-phone [data-rightbar-col] { grid-column: 3 !important; grid-row: 1 !important; }",
      "html.dmb-phone [class*='_sidebarCol']:has([class*='_collapsed']) { display: none !important; }",
      "html.dmb-phone [class*='_sidebarCol']:not(:has([class*='_collapsed'])) { position: fixed !important; top: 0; bottom: 0; left: 0; width: min(86vw, 320px) !important; z-index: 1000; box-shadow: 0 0 24px rgba(0, 0, 0, 0.25); }",
      // Right sidebar: DSH already goes full screen below 768px; keep it full width in landscape too.
      "html.dmb-phone [data-sidebar-right-panel] { width: 100vw !important; --dsh-sidebar-width: 100vw !important; }",
      // Let a finger scroll the tab strip sideways (DSH reserves touches for drag-reordering).
      "html.dmb-phone [data-dockkit-strip-tabs], html.dmb-phone [data-dockkit-tab] { touch-action: pan-x !important; }",
      // Tabs keep their width and the strip scrolls sideways, so any number of tabs stays reachable;
      // the "+" (new tab) button stays right after them.
      "html.dmb-phone [data-dockkit-strip-tabs] { flex: 0 1 auto !important; min-width: 0 !important; overflow-x: auto !important; scrollbar-width: none; }",
      "html.dmb-phone [data-dockkit-strip-tabs]::-webkit-scrollbar { display: none; }",
      "html.dmb-phone [data-dockkit-tab] { flex: none !important; }",
      "html.dmb-phone [data-dockkit-add-tab] { flex: none !important; }",
      "html.dmb-phone [data-dockkit-strip] button:not([data-dockkit-tab-close]), html.dmb-phone [data-sidebar-right-toggle] { min-width: 40px; min-height: 40px; }",
      // Tab chips: wide enough for a name plus an always-visible close button that fits the chip.
      "html.dmb-phone [data-dockkit-tab] { min-width: 120px !important; height: 34px !important; }",
      "html.dmb-phone [data-dockkit-tab-close] { width: 28px !important; height: 28px !important; min-width: 28px !important; min-height: 28px !important; flex: none !important; opacity: 1 !important; visibility: visible !important; }",
      // DSH's full-screen toggle: in the phone's automatic full-screen mode it only closes the panel,
      // which the collapse button next to it already does.
      "html.dmb-phone [data-sidebar-right-mode] { display: none !important; }",
      // Reserve room for the floating buttons on the session header only.
      // A substring match on `_header` also pads utilities and tool headers.
      "html.dmb-phone [class*='_centerCol'] header:has([class*='_crumbCurrent']) { padding-left: 48px !important; padding-right: 48px !important; }",
      // The header corner (including DSH's "open right sidebar" button) gives way to the floating
      // right button, which clicks that hidden button.
      "html.dmb-phone [class*='_centerCol'] [class*='_headerCorner'] { display: none !important; }",
      "html.dmb-phone [class*='_centerCol'] [class*='_headerLeading']:not(:has(button)) { display: none !important; }",
      "html.dmb-phone [class*='_centerCol'] button[aria-label] { min-width: 40px; min-height: 40px; }",
      // Split buttons ("プラグインを追加" + its ⌄ menu): the named arrow grows to 40px above, so the
      // main half grows with it and the pair stays one 40px-tall control.
      "html.dmb-phone [class*='_centerCol'] [class*='_addGroup'] button { min-height: 40px; }",
      // Its menu is a fixed 320px wide and lands against the left edge on a phone, away from the button
      // and over the list: span the screen instead.
      "html.dmb-phone [role='menu'][class*='_addMenu'] { left: 12px !important; right: 12px !important; width: auto !important; max-width: none !important; }",
      PHONE_HIDDEN_LABELS.map((label) => "html.dmb-phone button[aria-label=\"" + label + "\"]").join(", ") + " { display: none !important; }",
      // DSH's "open in an app on the computer" controls (session header, file cards in the chat,
      // sidebar previews) all carry data-open-target; their labels name whatever app the computer
      // picked ("Xcodeで開く", "ファイルの場所を表示", …), so labels alone miss them. From the phone
      // they would open that app or Finder on the computer.
      "html.dmb-phone [data-open-target] { display: none !important; }",
      // Session rows open their menu on a long press: no text selection or callout under the finger.
      "html.dmb-phone [class*='_sidebarCol'] [data-row-key^='session:'] { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }",
      ".dmb-fab { position: fixed; z-index: 1001; width: 36px; height: 36px; padding: 0; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.12); background: rgba(255, 255, 255, 0.9); color: #333; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15); corner-shape: round; -webkit-tap-highlight-color: transparent; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; transition: transform 0.12s, box-shadow 0.12s; }",
      ".dmb-fab.dmb-dragging { transform: scale(1.15); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); }",
      ".dmb-fab[hidden] { display: none; }",
      // Header counts (subagents, background jobs): a dedicated icon and the number instead of the long
      // label that pushed the title off a phone's header. The full label stays the accessible name.
      "html.dmb-phone [data-dmb-compact] > span, html.dmb-phone [data-dmb-compact] > svg { display: none !important; }",
      "html.dmb-phone [data-dmb-compact] { display: inline-flex !important; align-items: center; gap: 3px; padding: 0 8px !important; min-width: 40px; width: auto !important; flex: none !important; font-variant-numeric: tabular-nums; }",
      "html.dmb-phone [data-dmb-compact]::before { content: ''; width: 16px; height: 16px; flex: none; background: currentColor; -webkit-mask: var(--dmb-icon) center / contain no-repeat; mask: var(--dmb-icon) center / contain no-repeat; }",
      "html.dmb-phone [data-dmb-compact][data-dmb-count]::after { content: attr(data-dmb-count); font-size: 12px; line-height: 1; }",
      "html.dmb-phone [data-dmb-compact][data-dmb-live] { color: var(--dsw-alias-state-business-primary, #4c8df6); }",
      "html.dmb-phone [data-dmb-compact='subagents'] { --dmb-icon: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='5' y='1.75' width='6' height='4.5' rx='1.2'/%3E%3Cpath d='M8 6.25v2.5M3.5 11v-1.25h9V11'/%3E%3Crect x='1.5' y='11' width='4' height='3.25' rx='1'/%3E%3Crect x='10.5' y='11' width='4' height='3.25' rx='1'/%3E%3C/svg%3E\"); }",
      "html.dmb-phone [data-dmb-compact='jobs'] { --dmb-icon: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Cpath d='M8 1.75 14.25 5 8 8.25 1.75 5Z'/%3E%3Cpath d='M1.75 8 8 11.25 14.25 8M1.75 11 8 14.25 14.25 11'/%3E%3C/svg%3E\"); }",
      "body[data-ds-dark-theme] .dmb-fab { background: rgba(40, 40, 40, 0.9); color: #eee; border-color: rgba(255, 255, 255, 0.15); }",
      ".dmb-backdrop { position: fixed; inset: 0; z-index: 999; background: rgba(0, 0, 0, 0.25); }",
      // The backdrop shows only while the sidebar is open. `dmb-sidebar-open` is set by a mutation
      // observer on the sidebar, which runs before the next frame is drawn, so the backdrop hides in
      // the same frame the sidebar does; a timer-driven toggle lagged, and the app's swipe-close (which
      // fades the backdrop out and then clears its opacity) flashed it dark again until it ran.
      "html.dmb-phone:not(.dmb-sidebar-open) .dmb-backdrop, .dmb-backdrop[hidden] { display: none; }",
      // A closed project shows its most urgent session state (see projectStatus) where DSH shows a
      // session's: amber dot = waiting for you, spinner = running, green dot = finished, not yet viewed.
      "html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status]::after { content: ''; flex: none; box-sizing: border-box; margin-left: 6px; border-radius: 50%; }",
      "html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status='warning']::after { width: 6px; height: 6px; margin-right: 4px; background: var(--dsw-alias-state-warn-primary, #d29922); }",
      "html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status='done']::after { width: 6px; height: 6px; margin-right: 4px; background: var(--dsw-alias-state-success-primary, #3fb950); }",
      "html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status='ongoing']::after { width: 12px; height: 12px; margin-right: 1px; border: 2px solid color-mix(in srgb, var(--dsw-alias-label-tertiary, #999) 30%, transparent); border-top-color: var(--dsw-alias-label-tertiary, #999); animation: dmb-project-spin 0.9s linear infinite; }",
      "@keyframes dmb-project-spin { to { transform: rotate(360deg); } }",
      "@media (prefers-reduced-motion: reduce) { html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status='ongoing']::after { animation: none; } }",
      // Hide the "深掘り中…" running label while the AI is answering.
      "html.dmb-phone [data-chat-running] { display: none !important; }",
      // Thread title: drop the fixed 220px cap and let the current crumb fill the
      // header's remaining width with its own ellipsis.
      "html.dmb-phone header:has([class*='_crumbCurrent']) [class*='_crumbs'] { flex: 1 1 0; min-width: 0; }",
      "html.dmb-phone header:has([class*='_crumbCurrent']) [class*='_crumbSeg']:has([class*='_crumbCurrent']) { flex: 1 1 0; min-width: 0; }",
      "html.dmb-phone header:has([class*='_crumbCurrent']) [class*='_crumbCurrent'] { flex: 1 1 0; min-width: 0; max-width: none !important; box-sizing: border-box; }",
      ".dmb-title-tip { position: fixed; z-index: 1002; max-width: min(90vw, 360px); padding: 8px 12px; border-radius: 10px; background: rgba(30,30,30,0.95); color: #eee; font-size: 13px; line-height: 1.5; box-shadow: 0 4px 16px rgba(0,0,0,0.3); overflow-wrap: anywhere; }",
      "body[data-ds-dark-theme] .dmb-title-tip { background: rgba(52,52,52,0.98); }",
      // Question card (ask-user): DSH caps the card at min(60vh, 520px) and keeps the question text
      // unshrinkable, so on a phone a long question fills the cap and squeezes the options to 0px. Here
      // the question text scrolls within about a quarter of the screen and the card may grow taller,
      // so the options and the skip/send buttons stay on screen.
      "html.dmb-phone [data-question-key] section[class*='_card'] { max-height: min(80dvh, 640px) !important; }",
      "html.dmb-phone [data-question-key] [class*='_headingBlock'] { max-height: 26dvh; overflow-y: auto; overscroll-behavior: contain; }",
      // Its footer (pager, skip, send) is wider than a narrow phone's card: the buttons wrap to a second
      // line, right-aligned, instead of running past the card's edge.
      "html.dmb-phone [data-question-key] footer[class*='_footer'] { flex-wrap: wrap; row-gap: 8px; }",
      "html.dmb-phone [data-question-key] footer[class*='_footer'] > [class*='_footerActions'] { margin-left: auto; }",
      // Settings: the desktop 800px panel squeezes the nav rail + content on a
      // phone. Make it a full-viewport sheet with a horizontal section tab strip.
      "html.dmb-phone [data-shortcut-modal='settings'] { width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; border-radius: 0 !important; flex-direction: column !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] > [class*='_nav'] { flex: none !important; width: 100% !important; gap: 8px !important; padding: 10px 12px !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] [class*='_navList'] { flex-direction: row !important; flex-wrap: nowrap !important; overflow-x: auto !important; overflow-y: hidden !important; gap: 6px !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] [class*='_navCell'] { flex: none !important; height: 36px !important; min-height: 36px !important; padding: 0 12px !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] [class*='_navLabel'] { flex: none !important; overflow: visible !important; text-overflow: clip !important; white-space: nowrap !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] > [class*='_content'] { flex: 1 1 auto !important; min-width: 0 !important; min-height: 0 !important; }",
      // Setting rows put the label and its control on one line; a wide text input (the font pickers
      // under "その他のフォント設定" need ~260px) left the label a few characters wide, one character
      // per line. Rows with such an input put it on its own full-width line under the label; rows with
      // a select or switch are left as they are.
      "html.dmb-phone [data-shortcut-modal='settings'] [class$='_row']:has(> :is([class$='_field'], [class*='_field '])) { flex-wrap: wrap !important; row-gap: 8px; }",
      "html.dmb-phone [data-shortcut-modal='settings'] [class$='_row']:has(> :is([class$='_field'], [class*='_field '])) > * { flex: 1 1 100% !important; }",
      // The close button had a whole row to itself: it floats at the top right, beside the "設定" title,
      // and its row goes away (only when the row holds nothing else).
      "html.dmb-phone [data-shortcut-modal='settings'] > [class*='_content'] > [class*='_header']:not(:has(> [class*='_actions'] :not([data-slot]:empty))) { display: contents !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] > [class*='_content'] > [class*='_header'] > [class*='_close'] { position: fixed !important; top: 6px; right: 6px; z-index: 5; width: 36px !important; height: 36px !important; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid rgba(0, 0, 0, 0.1); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15); }",
      "body[data-ds-dark-theme] [data-shortcut-modal='settings'] > [class*='_content'] > [class*='_header'] > [class*='_close'] { border-color: rgba(255, 255, 255, 0.15); }",
    ].join("\n");

    // Round floating buttons of the phone layout. A tap runs the action; a long press (0.45 s) picks
    // the button up so it can be dragged anywhere on screen. The position is kept per button as a
    // fraction of the viewport in localStorage (a per-phone convenience; a missing or blocked
    // storage just means the default corner).
    const FAB_SIZE = 36;
    const FAB_MARGIN = 6;
    const LONG_PRESS_MS = 450;
    function floatingButton(side, label, icon, onActivate) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dmb-fab";
      button.dataset.dmbFab = side;
      button.setAttribute("aria-label", label);
      button.innerHTML = icon;
      const key = "dsh-mobile-bridge:fab:" + side;
      const clamp = (x, y) => [
        Math.min(Math.max(x, 4), window.innerWidth - FAB_SIZE - 4),
        Math.min(Math.max(y, 4), window.innerHeight - FAB_SIZE - 4),
      ];
      const moveTo = (x, y) => {
        const [cx, cy] = clamp(x, y);
        button.style.left = cx + "px";
        button.style.top = cy + "px";
      };
      const place = () => {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { /* storage unavailable: default corner */ }
        if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
          moveTo(saved.x * window.innerWidth, saved.y * window.innerHeight);
        } else {
          moveTo(side === "left" ? FAB_MARGIN : window.innerWidth - FAB_SIZE - FAB_MARGIN, FAB_MARGIN);
        }
      };
      place();

      let pressTimer = 0;
      let dragging = false;
      let suppressClick = false;
      let startX = 0;
      let startY = 0;
      let offsetX = 0;
      let offsetY = 0;
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        startX = event.clientX;
        startY = event.clientY;
        const rect = button.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        try { button.setPointerCapture(event.pointerId); } catch (e) { /* capture is best effort */ }
        pressTimer = window.setTimeout(() => {
          pressTimer = 0;
          dragging = true;
          button.classList.add("dmb-dragging");
          if (navigator.vibrate) navigator.vibrate(15);
        }, LONG_PRESS_MS);
      });
      button.addEventListener("pointermove", (event) => {
        if (!dragging) {
          if (pressTimer && Math.hypot(event.clientX - startX, event.clientY - startY) > 10) {
            clearTimeout(pressTimer);
            pressTimer = 0;
          }
          return;
        }
        moveTo(event.clientX - offsetX, event.clientY - offsetY);
      });
      const end = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = 0;
        }
        if (!dragging) return;
        dragging = false;
        button.classList.remove("dmb-dragging");
        // The click that follows the drop must not run the action.
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 400);
        const rect = button.getBoundingClientRect();
        try {
          localStorage.setItem(key, JSON.stringify({ x: rect.left / window.innerWidth, y: rect.top / window.innerHeight }));
        } catch (e) { /* storage unavailable: the position lasts until the page reloads */ }
      };
      button.addEventListener("pointerup", end);
      button.addEventListener("pointercancel", end);
      // A long press must not open the WebView's context menu.
      button.addEventListener("contextmenu", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        if (suppressClick) {
          suppressClick = false;
          event.preventDefault();
          return;
        }
        onActivate();
      });
      window.addEventListener("resize", place);
      document.body.append(button);
      return {
        button,
        dispose: () => {
          clearTimeout(pressTimer);
          window.removeEventListener("resize", place);
          button.remove();
        },
      };
    }

    // How urgent each session state is; a closed project shows its most urgent session.
    const STATUS_RANK = { warning: 3, ongoing: 2, done: 1 };
    const STATUS_LABEL = {
      warning: "対応待ちのセッションがあります",
      ongoing: "実行中のセッションがあります",
      done: "完了して未確認のセッションがあります",
    };
    /**
     * The most urgent state per project row key ("" is DSH's "no workspace" group), from the same
     * facts DSH's session rows use: a pending approval, plan review or question, then running, then a
     * finished run not yet viewed. Archived and blank sessions do not count. With `nested` (DSH's
     * "workspace tree" grouping) a project also carries the states of the projects in folders under
     * it, which are drawn inside it and so hidden while it is closed.
     * @param {{workspaces: any, uiSession: any, sessions: any}} services
     * @param {boolean} [nested]
     * @returns {Map<string, "warning"|"ongoing"|"done">}
     */
    function projectStatus(services, nested = false) {
      const result = new Map();
      const workspaces = services.workspaces?.list?.getSnapshot?.();
      const statuses = services.uiSession?.sessionStatus?.getSnapshot?.();
      const list = services.sessions?.list?.getSnapshot?.();
      if (!workspaces || !statuses || !list) return result;
      const archived = new Set(workspaces.archivedSessionIds || []);
      const stateOf = (id) => {
        const summary = list.byId?.[id];
        if (archived.has(id) || summary?.blank) return undefined;
        const status = statuses.get(id);
        const kind = status?.pendingInteraction?.kind;
        if (kind === "approval" || kind === "plan-review" || kind === "question") return "warning";
        if (status?.running ?? summary?.running) return "ongoing";
        if (status?.completionUnread) return "done";
        return undefined;
      };
      const mark = (key, ids) => {
        let best;
        for (const id of ids) {
          const state = stateOf(id);
          if (state && (!best || STATUS_RANK[state] > STATUS_RANK[best])) best = state;
          if (best === "warning") break;
        }
        if (best) result.set(key, best);
      };
      const accounted = new Set();
      for (const workspace of workspaces.items || []) {
        for (const id of workspace.sessionIds || []) accounted.add(id);
        mark(String(workspace.workspaceId), workspace.sessionIds || []);
      }
      mark("", (list.ids || []).filter((id) => !accounted.has(id)));
      if (nested) {
        // Same comparison as DSH's tree grouping: Windows paths compare with "/" separators.
        const folder = (path) => {
          const text = String(path || "");
          const windows = /^[A-Za-z]:[\/\\]/.test(text) || text.startsWith("\\\\");
          const trimmed = (windows ? text.replace(/\\/g, "/") : text).replace(/\/+$/, "");
          return trimmed === "" && text.startsWith("/") ? "/" : trimmed; // the root folder stays "/"
        };
        const items = (workspaces.items || []).map((w) => ({ id: String(w.workspaceId), path: folder(w.path) }));
        const own = new Map(result);
        for (const parent of items) {
          let best = own.get(parent.id);
          for (const child of items) {
            const prefix = parent.path.endsWith("/") ? parent.path : parent.path + "/";
            if (child === parent || !parent.path || child.path === parent.path || !child.path.startsWith(prefix)) continue;
            const state = own.get(child.id);
            if (state && (!best || STATUS_RANK[state] > STATUS_RANK[best])) best = state;
          }
          if (best) result.set(parent.id, best);
        }
      }
      return result;
    }

    /**
     * @param {{workspaces: () => any, uiSession: () => any, sessions: () => any}} [services] - lazy Client services
     * @returns {() => void} undo
     */
    function phoneLayout(services) {
      const sidebar = () => document.querySelector("[class*='_sidebarCol']");
      const isOpen = () => {
        const s = sidebar();
        return !!s && !s.querySelector("[class*='_collapsed']");
      };
      // Reuse DSH's own sidebar button so its state stays the single source of truth.
      const toggle = () => {
        const s = sidebar();
        const buttons = s ? Array.from(s.querySelectorAll("button[aria-label]")) : [];
        const button = buttons.find((b) => SIDEBAR_TOGGLE_LABEL.test(b.getAttribute("aria-label") || ""));
        if (button) button.click();
      };
      const close = () => { if (isOpen()) toggle(); };

      document.documentElement.classList.add("dmb-phone");
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-mobile-bridge-phone";
      style.textContent = PHONE_STYLE;
      document.head.append(style);

      const leftFab = floatingButton("left", "サイドバー",
        '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>',
        () => {
          // Hide the keyboard first, or it covers the lower half of the sidebar.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          const opening = !isOpen();
          toggle();
          if (opening) restoreScroll();
        });
      // DSH's own "open right sidebar" button sits in the header corner, which the phone layout
      // hides; this one has the same look as the left one and clicks it.
      const rightExpand = () => document.querySelector("[data-sidebar-right-expand]");
      const rightFab = floatingButton("right", "右サイドバーを開く",
        '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M10 2.75v10.5"/></svg>',
        () => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          const button = rightExpand();
          if (button) button.click();
        });

      // A panel page (プラグイン, 自動化タスク, or a plugin's own) replaces the chat; DSH returns only from the
      // sidebar. A floating × in the top-right corner (where the right-sidebar button sits on the chat)
      // goes back to the chat.
      const layoutService = () => services && services.layout ? services.layout() : undefined;
      const panelOpen = () => {
        try { return layoutService()?.panelInfo?.getSnapshot?.()?.activePanelId != null; } catch (e) { return false; /* layout not ready */ }
      };
      const closeFab = floatingButton("close", "チャットに戻る",
        '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
        () => {
          try { layoutService()?.selectPanel?.(null); } catch (e) { /* the panel is already gone */ }
          placeFabs();
        });
      closeFab.button.hidden = true;

      // The session list opens where it was left. DSH unmounts the list while the sidebar is
      // collapsed, which drops its scroll offset and how far each workspace was paged with
      // "さらに…件のセッションを表示" (each press shows a few more). Both are kept here — the
      // offset and the number of sessions shown per workspace — and put back on every opening.
      // Stored per phone; a blocked storage keeps them for this page only.
      // Nothing is saved until this opening's restore has succeeded or the reader has touched the
      // list: a list opened before its sessions arrive must not overwrite the saved place with 0.
      const sessionList = () => {
        const s = sidebar();
        return s ? s.querySelector("[role='tree']") : null;
      };
      const GROUP = "[class*='_groupSection']";
      const groupOf = (list, workspaceId) => {
        const row = list.querySelector("[data-row-key=\"workspace:" + CSS.escape(workspaceId) + "\"]");
        return row ? row.closest(GROUP) : null;
      };
      // The workspace's own session rows: not those of a nested workspace drawn inside its section,
      // nor the provisional blank "新規セッション" row (it has no row actions).
      const shownIn = (group) => Array.from(group.querySelectorAll(SESSION_ROW))
        .filter((row) => row.closest(GROUP) === group && row.querySelector(ROW_ACTIONS)).length;
      let saved = { top: 0, shown: {} };
      try {
        const stored = JSON.parse(localStorage.getItem(SIDEBAR_SCROLL_KEY) || "null");
        if (stored && typeof stored.top === "number" && stored.shown && typeof stored.shown === "object") saved = { top: stored.top, shown: stored.shown };
      } catch (e) { /* storage unavailable or unreadable: start at the top */ }
      let restoring = false;
      let trusted = true;
      let persistTimer = 0;
      const persist = () => {
        clearTimeout(persistTimer);
        persistTimer = 0;
        try { localStorage.setItem(SIDEBAR_SCROLL_KEY, JSON.stringify(saved)); } catch (e) { /* storage unavailable: kept for this page */ }
      };
      const remember = () => {
        const list = sessionList();
        if (restoring || !trusted || !list || !isOpen()) return;
        const shown = {};
        for (const row of list.querySelectorAll("[data-row-key^='workspace:'][aria-expanded='true']")) {
          const id = row.getAttribute("data-row-key").slice("workspace:".length);
          const group = row.closest(GROUP);
          if (group) shown[id] = shownIn(group);
        }
        const next = { top: Math.round(list.scrollTop), shown };
        if (JSON.stringify(next) === JSON.stringify(saved)) return;
        saved = next;
        clearTimeout(persistTimer);
        persistTimer = setTimeout(persist, SIDEBAR_PERSIST_MS);
      };
      // At most one measurement per frame while the list scrolls; the storage write is batched.
      let rememberFrame = 0;
      const onListScroll = (event) => {
        if (event.target !== sessionList() || rememberFrame) return;
        rememberFrame = requestAnimationFrame(() => { rememberFrame = 0; remember(); });
      };
      // The reader's own touch or wheel on the list takes over from an unfinished restore: the restore
      // stops at once (it would otherwise keep pulling the list back under the finger) and the list is
      // the reader's to save again.
      const onListInput = (event) => {
        const list = sessionList();
        if (!list || !(event.target instanceof Node) || !list.contains(event.target)) return;
        trusted = true;
        if (restoring) {
          cancelAnimationFrame(restoreFrame);
          restoreFrame = 0;
          restoring = false;
        }
      };
      // A press in the list ("さらに…", a project row) changes what is shown without scrolling: measure
      // once DSH has re-rendered, so closing right after it does not lose that page.
      let listClickTimer = 0;
      const onListClick = (event) => {
        const list = sessionList();
        if (!list || !(event.target instanceof Node) || !list.contains(event.target)) return;
        clearTimeout(listClickTimer);
        listClickTimer = setTimeout(remember, 50);
      };
      document.addEventListener("scroll", onListScroll, true);
      document.addEventListener("touchstart", onListInput, { capture: true, passive: true });
      document.addEventListener("wheel", onListInput, { capture: true, passive: true });
      document.addEventListener("click", onListClick, true);
      // A pending save is written right away when the app goes to the background or the page unloads.
      const onLeave = () => { if (persistTimer && document.visibilityState !== "visible") persist(); };
      const onPageHide = () => { if (persistTimer) persist(); };
      document.addEventListener("visibilitychange", onLeave);
      window.addEventListener("pagehide", onPageHide);
      let restoreFrame = 0;
      // The list renders over a few frames after the sidebar opens (and its sessions may still be
      // arriving), and each "さらに…" press adds rows on the next render: page one step per frame,
      // then set the offset, for up to SIDEBAR_RESTORE_MS. A collapse/expand toggle is only ever
      // pressed while it is in its "show more" state.
      // One restore per opening: whichever notices the opening first (the button or the sync tick).
      let openingRestored = false;
      const restoreScroll = () => {
        openingRestored = true;
        cancelAnimationFrame(restoreFrame);
        restoring = true;
        trusted = false;
        readNestedView();
        markProjects();
        const started = performance.now();
        let bottomed = 0;
        const step = () => {
          const list = sessionList();
          let done = false;
          // Closed again: stop (the first frames may still be catching up with the opening).
          let over = !isOpen() && performance.now() - started > SIDEBAR_OPEN_GRACE_MS;
          // Ready once rows are drawn and every saved workspace that is open shows its sessions (or its
          // "show more"): workspace rows can arrive before their sessions. With every project closed
          // there are no session rows at all, and a saved workspace that is gone or closed is skipped.
          // Only workspaces that had sessions shown are waited for (an open but empty workspace draws no
          // session rows), and only for a while: past SIDEBAR_SESSIONS_WAIT_MS the offset is set anyway.
          const sessionsArrived = (l) => performance.now() - started > SIDEBAR_SESSIONS_WAIT_MS || Object.keys(saved.shown).every((id) => {
            if (!(saved.shown[id] > 0)) return true;
            const group = groupOf(l, id);
            const row = group && group.querySelector("[data-row-key=\"workspace:" + CSS.escape(id) + "\"]");
            if (!group || !row || row.getAttribute("aria-expanded") !== "true") return true;
            return shownIn(group) > 0 || !!group.querySelector("[data-row-key=\"overflow:" + CSS.escape(id) + "\"]");
          });
          if (list && !over && list.querySelector("[data-row-key]") && sessionsArrived(list)) {
            let paging = false;
            for (const [id, count] of Object.entries(saved.shown)) {
              const group = groupOf(list, id);
              const more = group && group.querySelector("[data-row-key=\"overflow:" + CSS.escape(id) + "\"]");
              if (more && more.getAttribute("aria-expanded") !== "true" && shownIn(group) < count) { more.click(); paging = true; }
            }
            list.scrollTop = saved.top;
            done = !paging && Math.abs(list.scrollTop - saved.top) <= 1;
            // Nothing left to page in and the list ends above the saved offset (sessions were archived
            // elsewhere): it will not get longer, so stop instead of holding the list for the full time.
            const atBottom = list.scrollTop >= list.scrollHeight - list.clientHeight - 1;
            bottomed = !done && !paging && atBottom ? bottomed + 1 : 0;
            if (bottomed >= SIDEBAR_RESTORE_SETTLE_FRAMES) over = true;
          }
          if (done || over || performance.now() - started > SIDEBAR_RESTORE_MS) {
            restoreFrame = requestAnimationFrame(() => {
              restoreFrame = 0;
              restoring = false;
              if (done) trusted = true;
            });
            return;
          }
          restoreFrame = requestAnimationFrame(step);
        };
        restoreFrame = requestAnimationFrame(step);
      };

      // Older history loads by itself when the reader scrolls up to the top: once the reader comes to
      // rest within ~1.5 screens of the top (finger lifted, scrolling settled), the chat presses DSH's own
      // "さらに前の履歴を読み込む" button. Pressing it at rest is what lets DSH keep the reading position
      // (reader movement during a load cancels that), and the button stays as the loading indicator.
      // Only a gesture of the reader's that actually scrolled the chat (or, in a chat too short to
      // scroll, pulled it down) arms it: a tap on a tool card or a copy button near the top does not,
      // and neither do the opening scroll to the latest message or a turn jump. One gesture loads at
      // most one page: folded turns are short, so a page may leave the reader at the top, and a single
      // swipe must not pull in the whole history.
      let readerInputAt = 0;
      let lastChatScrollAt = 0;
      let touching = false;
      let touchY = 0;
      let touchX = 0;
      let gesture = 0;
      let gestureScrolled = false;
      let gestureMoved = false;
      let loadedGesture = -1;
      let lastWheelAt = 0;
      let settleTimer = 0;
      const chatScroller = () => {
        // The chat column itself does not scroll; the conversation body around it does.
        const flow = document.querySelector("[data-chat-flow]");
        return flow ? flow.closest("[data-conversation-scroll]") : null;
      };
      const resetReaderGesture = () => {
        gesture++;
        gestureScrolled = false;
        gestureMoved = false;
        readerInputAt = 0;
        clearTimeout(settleTimer);
      };
      const loadOlderNearTop = () => {
        const now = Date.now();
        if (touching || !gestureScrolled || now - readerInputAt > OLDER_ARM_MS || loadedGesture === gesture) return;
        if (now - lastChatScrollAt < OLDER_SETTLE_MS) { scheduleOlderCheck(); return; }
        const scroller = chatScroller();
        const button = scroller && scroller.querySelector("[data-chat-flow] > [class*='_older'] button");
        if (!button) return;
        // A page is still loading (from an earlier gesture): look again once it has landed.
        if (button.disabled) { clearTimeout(settleTimer); settleTimer = setTimeout(loadOlderNearTop, OLDER_BUSY_RETRY_MS); return; }
        if (scroller.scrollTop > Math.max(OLDER_NEAR_TOP_PX, scroller.clientHeight * 1.5)) return;
        loadedGesture = gesture;
        button.click();
      };
      const scheduleOlderCheck = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(loadOlderNearTop, OLDER_SETTLE_MS);
      };
      const inChat = (event) => {
        const scroller = chatScroller();
        return !!scroller && event.target instanceof Node && scroller.contains(event.target);
      };
      const onReaderInput = (event) => {
        const now = Date.now();
        if (event.type === "touchend" || event.type === "touchcancel") {
          if (!touching || event.touches.length > 0) return;
          touching = false;
          readerInputAt = now;
          scheduleOlderCheck();
          return;
        }
        if (!inChat(event)) {
          // A touch elsewhere (the sidebar, the floating button) ends the chat gesture: what happened
          // in the chat before must not count for a session opened next.
          if (event.type === "touchstart") resetReaderGesture();
          return;
        }
        if (event.type === "touchstart") {
          if (!touching) { gesture++; gestureScrolled = false; gestureMoved = false; }
          touching = true;
          touchY = event.touches[0] ? event.touches[0].clientY : 0;
          touchX = event.touches[0] ? event.touches[0].clientX : 0;
        }
        if (event.type === "touchmove") {
          const dy = event.touches[0] ? event.touches[0].clientY - touchY : 0;
          const dx = event.touches[0] ? event.touches[0].clientX - touchX : 0;
          if (Math.abs(dy) > OLDER_SLOP_PX) gestureMoved = true;
          // Where the chat cannot scroll up any more (too short to scroll, or already at its top), no
          // scroll event comes: a finger pulled mostly down this far is trying to reach older messages.
          // A sideways swipe (opening a sidebar) is not. Measured only once the pull is long enough.
          if (!gestureScrolled && dy > OLDER_PULL_PX && Math.abs(dy) > Math.abs(dx)) {
            const scroller = chatScroller();
            if (scroller && (scroller.scrollTop <= 1 || scroller.scrollHeight <= scroller.clientHeight + 1)) gestureScrolled = true;
          }
        }
        if (event.type === "wheel") {
          if (now - lastWheelAt > OLDER_WHEEL_GAP_MS) { gesture++; gestureScrolled = false; }
          gestureMoved = true;
          lastWheelAt = now;
          if (event.deltaY < 0) gestureScrolled = true;
          scheduleOlderCheck();
        }
        readerInputAt = now;
      };
      // The last position of each chat scroller (a new session's scroller starts its own record).
      const lastChatTop = new WeakMap();
      const onChatScroll = (event) => {
        const scroller = chatScroller();
        if (event.target !== scroller) return;
        const now = Date.now();
        lastChatScrollAt = now;
        // Movement toward older messages while the reader's finger (or wheel) actually moved, or its
        // momentum right after, is the reader's. DSH's own scrolling after a tap (a turn jump, the
        // keyboard closing) and layout changes (a card expanding) are not.
        const previous = lastChatTop.has(scroller) ? lastChatTop.get(scroller) : scroller.scrollTop;
        if (scroller.scrollTop < previous && gestureMoved && (touching || now - readerInputAt < OLDER_MOMENTUM_MS)) gestureScrolled = true;
        lastChatTop.set(scroller, scroller.scrollTop);
        scheduleOlderCheck();
      };
      document.addEventListener("touchstart", onReaderInput, { capture: true, passive: true });
      document.addEventListener("touchmove", onReaderInput, { capture: true, passive: true });
      document.addEventListener("touchend", onReaderInput, { capture: true, passive: true });
      document.addEventListener("touchcancel", onReaderInput, { capture: true, passive: true });
      document.addEventListener("wheel", onReaderInput, { capture: true, passive: true });
      document.addEventListener("scroll", onChatScroll, true);

      // Settings close with a left-to-right swipe, like going back. The sheet follows the finger and
      // either slides out (then DSH's own close button is pressed) or springs back. Once a touch in
      // settings moves sideways it is kept from the app's own sidebar swipe (its listener is on
      // document; these run earlier, on window), which would otherwise open a sidebar behind the
      // sheet. Taps and vertical scrolls pass through untouched, and a touch on something that
      // scrolls sideways (the tab strip) is left to that scroll.
      const settingsSheet = () => document.querySelector("[data-shortcut-modal='settings']");
      const SHEET_CLOSE = ":scope > [class*='_content'] > [class*='_header'] > [class*='_close']";
      const scrollsSideways = (node, stop) => {
        for (let n = node; n && n !== stop.parentElement; n = n.parentElement) {
          if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
        }
        return false;
      };
      let sheetSwipe = null;
      const sheetTimers = new Set();
      const later = (fn, ms) => { const id = setTimeout(() => { sheetTimers.delete(id); fn(); }, ms); sheetTimers.add(id); };
      const springBack = (swipe) => {
        sheetSwipe = null;
        if (!swipe.active) return;
        swipe.sheet.style.transition = "transform " + SWIPE_SETTLE_MS + "ms ease-out";
        swipe.sheet.style.transform = "";
        later(() => { swipe.sheet.style.transition = ""; }, SWIPE_SETTLE_MS);
      };
      const onSheetTouchStart = (event) => {
        sheetSwipe = null;
        const sheet = settingsSheet();
        if (!sheet || event.touches.length !== 1 || !(event.target instanceof Element) || !sheet.contains(event.target)) return;
        if (scrollsSideways(event.target, sheet)) return;
        const t = event.touches[0];
        sheetSwipe = { sheet, x: t.clientX, y: t.clientY, dx: 0, active: false, held: false, vertical: false, lastX: t.clientX, lastT: Date.now(), v: 0 };
      };
      const onSheetTouchMove = (event) => {
        const swipe = sheetSwipe;
        if (!swipe) return;
        if (event.touches.length !== 1) { if (swipe.held) event.stopPropagation(); springBack(swipe); return; }
        const t = event.touches[0];
        const dx = t.clientX - swipe.x;
        const dy = t.clientY - swipe.y;
        // Sideways movement in the sheet is never the app's: hold it from here on.
        if (!swipe.held && Math.abs(dx) > SWIPE_HOLD_PX && Math.abs(dx) > Math.abs(dy)) swipe.held = true;
        if (swipe.held) event.stopPropagation();
        if (!swipe.active) {
          // A vertical scroll can no longer become a close-swipe, but the touch is still watched: if it
          // turns sideways (an L-shaped move) it is held from the app's sidebar swipe like any other.
          if (Math.abs(dy) > SWIPE_START_PX && Math.abs(dy) >= Math.abs(dx)) swipe.vertical = true;
          if (swipe.vertical) return;
          if (dx < SWIPE_START_PX || dx < Math.abs(dy) * 1.5) return;
          swipe.active = true;
          swipe.sheet.style.transition = "none";
        }
        const now = Date.now();
        swipe.v = (t.clientX - swipe.lastX) / Math.max(1, now - swipe.lastT);
        swipe.lastX = t.clientX;
        swipe.lastT = now;
        swipe.dx = Math.max(0, dx);
        swipe.sheet.style.transform = "translateX(" + swipe.dx + "px)";
      };
      const onSheetTouchEnd = (event) => {
        const swipe = sheetSwipe;
        if (!swipe) return;
        if (swipe.held) event.stopPropagation();
        if (!swipe.active) { sheetSwipe = null; return; }
        const width = swipe.sheet.getBoundingClientRect().width || window.innerWidth;
        if (swipe.dx < width * 0.3 && swipe.v < 0.5) { springBack(swipe); return; }
        sheetSwipe = null;
        swipe.sheet.style.transition = "transform " + SWIPE_SETTLE_MS + "ms ease-out";
        swipe.sheet.style.transform = "translateX(" + width + "px)";
        later(() => {
          const close = swipe.sheet.querySelector(SHEET_CLOSE);
          if (close && swipe.sheet.isConnected) close.click();
          // Still open (the close did not take): put it back.
          later(() => { if (swipe.sheet.isConnected) { swipe.sheet.style.transition = ""; swipe.sheet.style.transform = ""; } }, 300);
        }, SWIPE_SETTLE_MS);
      };
      const onSheetTouchCancel = (event) => {
        const swipe = sheetSwipe;
        if (!swipe) return;
        if (swipe.held) event.stopPropagation();
        springBack(swipe);
      };
      window.addEventListener("touchstart", onSheetTouchStart, { capture: true, passive: true });
      window.addEventListener("touchmove", onSheetTouchMove, { capture: true, passive: true });
      window.addEventListener("touchend", onSheetTouchEnd, { capture: true, passive: true });
      window.addEventListener("touchcancel", onSheetTouchCancel, { capture: true, passive: true });

      // Long-press a session row and lift the finger to open its "..." menu (rename, fork, pin, archive,
      // …): the menu button only shows on hover, which a finger never gives, and a tap opens the session.
      // A long press that goes on to drag the row still reorders it as before (DSH's own drag and drop);
      // the menu opens only when the finger is lifted without the row having been moved onto another
      // row. The button stays in the DOM, so pressing it opens DSH's own menu at the row.
      let rowPress = null;
      let suppressRowClickUntil = 0;
      const cancelRowPress = () => {
        if (rowPress) clearTimeout(rowPress.timer);
        rowPress = null;
      };
      const openRowMenu = (press) => {
        cancelRowPress();
        // The click that follows the release must not also open the session.
        suppressRowClickUntil = Date.now() + 800;
        press.menuButton.click();
      };
      const onRowPointerDown = (event) => {
        cancelRowPress();
        // A new touch: a long press whose release never produced a click must not swallow this one.
        suppressRowClickUntil = 0;
        if (event.pointerType === "mouse" || !(event.target instanceof Element)) return;
        const s = sidebar();
        const row = event.target.closest(SESSION_ROW);
        if (!s || !isOpen() || !row || !s.contains(row) || event.target.closest(ROW_ACTIONS)) return;
        const menuButton = row.querySelector(ROW_ACTIONS + " button");
        if (!menuButton) return;
        const press = { row, menuButton, x: event.clientX, y: event.clientY, held: false, dragging: false, moved: false, timer: 0 };
        press.timer = setTimeout(() => {
          press.held = true;
          if (navigator.vibrate) navigator.vibrate(15);
        }, LONG_PRESS_MS);
        rowPress = press;
      };
      const onRowPointerMove = (event) => {
        if (rowPress && !rowPress.held && Math.hypot(event.clientX - rowPress.x, event.clientY - rowPress.y) > 10) cancelRowPress();
      };
      const onRowPointerUp = () => {
        const press = rowPress;
        if (press && press.held && !press.dragging) openRowMenu(press);
        else cancelRowPress();
      };
      // A native drag takes the touch over: the browser cancels the pointer around dragstart, in either
      // order. A held press waits briefly for that drag; a press that never got held was a scroll.
      const onRowPointerCancel = () => {
        const press = rowPress;
        if (!press || press.dragging) return;
        if (!press.held) { cancelRowPress(); return; }
        press.timer = setTimeout(() => { if (rowPress === press && !press.dragging) cancelRowPress(); }, 500);
      };
      const onRowDragStart = (event) => {
        if (rowPress && event.target instanceof Node && rowPress.row.contains(event.target)) {
          rowPress.dragging = true;
          rowPress.held = true;
        }
      };
      const onRowDragOver = (event) => {
        if (!rowPress || !rowPress.dragging || !(event.target instanceof Element)) return;
        const over = event.target.closest(SESSION_ROW);
        const far = (event.clientX || event.clientY) && Math.hypot(event.clientX - rowPress.x, event.clientY - rowPress.y) > 12;
        if ((over && over !== rowPress.row) || far) rowPress.moved = true;
      };
      // Released without having moved onto another row (or far from where it started): that was a
      // long press, not a move.
      const onRowDragEnd = () => {
        const press = rowPress;
        if (!press || !press.dragging) return;
        if (!press.moved && press.row.isConnected) later(() => openRowMenu(press), 0);
        else cancelRowPress();
      };
      const swallowAfterPress = (event) => {
        if (Date.now() > suppressRowClickUntil || !(event.target instanceof Element)) return;
        if (!event.target.closest(SESSION_ROW) || event.target.closest(ROW_ACTIONS)) return;
        event.preventDefault();
        // Also keeps the "picked a session, close the sidebar" listener on document from running.
        event.stopImmediatePropagation();
        suppressRowClickUntil = 0;
      };
      const onRowContextMenu = (event) => {
        const s = sidebar();
        if (s && event.target instanceof Element && s.contains(event.target) && event.target.closest(SESSION_ROW)) event.preventDefault();
      };
      document.addEventListener("pointerdown", onRowPointerDown, true);
      document.addEventListener("pointermove", onRowPointerMove, true);
      document.addEventListener("pointerup", onRowPointerUp, true);
      document.addEventListener("pointercancel", onRowPointerCancel, true);
      document.addEventListener("dragstart", onRowDragStart, true);
      document.addEventListener("dragover", onRowDragOver, true);
      document.addEventListener("dragend", onRowDragEnd, true);
      document.addEventListener("click", swallowAfterPress, true);
      document.addEventListener("contextmenu", onRowContextMenu, true);

      // Closed projects carry their most urgent session state (drawn by PHONE_STYLE); open ones show
      // the sessions' own marks instead. Only attributes React does not own are touched.
      // DSH's grouping choice, read when the sidebar opens (the choice is made inside it) and kept.
      let nestedView = false;
      let nestedViewRaw;
      const readNestedView = () => {
        let raw = null;
        try { raw = localStorage.getItem(WORKSPACE_VIEW_KEY); } catch (e) { raw = null; /* storage unavailable: grouped by workspace */ }
        if (raw === nestedViewRaw) return; // parsed only when the settings changed
        nestedViewRaw = raw;
        try { nestedView = JSON.parse(raw || "{}").groupBy === "workspace-tree"; } catch (e) { nestedView = false; /* unreadable view settings: grouped by workspace */ }
      };
      const markProjects = () => {
        const s = sidebar();
        if (!s || !services || !isOpen()) return;
        readNestedView(); // the grouping can change while the sidebar is open
        let states;
        try {
          states = projectStatus({ workspaces: services.workspaces(), uiSession: services.uiSession(), sessions: services.sessions() }, nestedView);
        } catch (e) {
          return; // A service missing or still loading: leave the rows as they are.
        }
        for (const row of s.querySelectorAll("[data-row-key^='workspace:']")) {
          const state = states.get(row.getAttribute("data-row-key").slice("workspace:".length));
          // The mark (and its spoken description) is for closed projects; open ones show their sessions.
          const description = state && row.getAttribute("aria-expanded") === "false" ? STATUS_LABEL[state] : undefined;
          if ((row.getAttribute("data-dmb-status") || undefined) !== state) {
            if (state) row.setAttribute("data-dmb-status", state);
            else row.removeAttribute("data-dmb-status");
          }
          if ((row.getAttribute("aria-description") || undefined) !== description) {
            if (description) row.setAttribute("aria-description", description);
            else row.removeAttribute("aria-description");
          }
        }
      };
      const unmarkProjects = () => {
        for (const row of document.querySelectorAll("[data-row-key^='workspace:'][data-dmb-status]")) {
          row.removeAttribute("data-dmb-status");
          row.removeAttribute("aria-description");
        }
      };

      const backdrop = document.createElement("div");
      backdrop.className = "dmb-backdrop";
      backdrop.addEventListener("click", close);
      document.body.append(backdrop);
      const syncSidebarClass = () => document.documentElement.classList.toggle("dmb-sidebar-open", isOpen());
      // The rows render (and re-render) under this observer: mark them in the next frame instead of
      // waiting for the sync tick. The marks are attributes it does not watch, so this cannot loop.
      let markFrame = 0;
      const sidebarObserver = new MutationObserver(() => {
        syncSidebarClass();
        // An opening by any means (the button, the app's swipe) restores once; a closing re-arms it.
        if (!isOpen()) openingRestored = false;
        else if (!openingRestored) { readNestedView(); restoreScroll(); }
        if (!markFrame) markFrame = requestAnimationFrame(() => { markFrame = 0; markProjects(); });
      });
      let observedSidebar = null;
      // Re-attached when DSH replaces the sidebar column (checked on every sync tick).
      const watchSidebar = () => {
        const col = sidebar();
        if (col !== observedSidebar) {
          sidebarObserver.disconnect();
          observedSidebar = col;
          if (col) sidebarObserver.observe(col, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
        }
        syncSidebarClass();
      };
      watchSidebar();

      // Opening a session focuses its message box, which on the phone brings the keyboard up over the
      // chat. For a short while after a session is picked (sidebar or the app's open request) that
      // automatic focus is undone; the reader's own tap on the message box is left alone.
      let composerFocusQuietUntil = 0;
      // A session is being opened: no automatic keyboard, and nothing the reader did in the previous
      // chat counts toward loading this one's older history.
      const quietComposerFocus = () => { composerFocusQuietUntil = Date.now() + COMPOSER_FOCUS_QUIET_MS; resetReaderGesture(); };
      const onComposerFocus = (event) => {
        if (Date.now() > composerFocusQuietUntil || !(event.target instanceof HTMLElement)) return;
        const field = event.target;
        if (!field.closest("[data-composer-card]") || !(field.isContentEditable || field.tagName === "TEXTAREA" || field.tagName === "INPUT")) return;
        field.blur();
      };
      const onComposerTouch = (event) => {
        if (event.target instanceof Element && event.target.closest("[data-composer-card]")) composerFocusQuietUntil = 0;
      };
      document.addEventListener("focusin", onComposerFocus, true);
      document.addEventListener("pointerdown", onComposerTouch, true);
      // A session opened by the app (a notification tap) shows its chat: the sidebar overlay closes and
      // a panel page (プラグイン, 自動化タスク, …) gives way, like picking the session in the sidebar.
      const onAppOpenSession = () => {
        quietComposerFocus();
        if (isOpen()) close();
        if (panelOpen()) { try { layoutService()?.selectPanel?.(null); } catch (e) { /* the panel is already gone */ } }
        placeFabs();
      };
      window.addEventListener("dsh-mobile-bridge:open-session", onAppOpenSession);

      // Picking a session or starting a new one closes the overlay.
      // Picking something that opens in the main area closes the overlay: a session or a search result,
      // a new session (also per workspace), a panel (プラグイン, 自動化タスク, …), or an item of the
      // account menu (設定, フィードバック, …), whose menu opens outside the sidebar. Controls that work
      // inside the sidebar (search field, view options, a row's "..." menu, the usage card) keep it open.
      let accountMenuArmed = false;
      const onPick = (event) => {
        const s = sidebar();
        const target = event.target;
        if (!s || !isOpen() || !(target instanceof Element)) return;
        if (!s.contains(target)) {
          if (accountMenuArmed && target.closest("[role='menuitem']")) { accountMenuArmed = false; setTimeout(close, 150); }
          return;
        }
        accountMenuArmed = false;
        const button = target.closest("button");
        const label = (button && button.getAttribute("aria-label")) || "";
        // A workspace row's "new session here" button opens a session; the other row buttons (the "..."
        // menu, pin, archive) act on the row without opening anything.
        if (button && WORKSPACE_NEW_SESSION_LABEL.test(label)) { setTimeout(close, 150); return; }
        if (target.closest(ROW_ACTIONS)) return;
        if (button && ACCOUNT_MENU_LABEL.test(label)) { accountMenuArmed = true; return; }
        const session = target.closest("[data-row-key^='session:'], [class*='_searchResultRow']");
        if (session) quietComposerFocus();
        if (session || target.closest("[class*='_panelRow']") || (button && NEW_SESSION_LABEL.test(label))) {
          setTimeout(close, 150);
        }
      };
      document.addEventListener("click", onPick, true);

      // The right sidebar covers the screen while open (DSH's full-screen mode); its own strip has
      // the collapse button, so the floating left-sidebar button would only get in the way.
      const rightOpen = () => Array.from(document.querySelectorAll("[data-rightbar-col] [data-sidebar-right-open]"))
        .some((panel) => !panel.closest("[hidden]"));
      // The changes review opens side by side, two ~200px columns on a phone: switch each review
      // to the single-column view once (the user can switch back).
      const unified = new WeakSet();
      let lastActiveTab = null;
      // The left button stays; the top-right corner holds × on a panel page and the right-sidebar button
      // on the chat.
      const placeFabs = () => {
        const open = isOpen();
        const onPanel = panelOpen();
        leftFab.button.hidden = open || rightOpen();
        rightFab.button.hidden = open || rightOpen() || onPanel || !rightExpand();
        closeFab.button.hidden = open || rightOpen() || !onPanel;
      };
      // Mark the header's count buttons for the compact look (see PHONE_STYLE): which kind by its label,
      // and the number from it. Other header buttons keep their own look.
      const compactHeaderCounts = () => {
        for (const button of document.querySelectorAll("[data-slot='conversation.session.header.actions'] button[aria-label]")) {
          const label = button.getAttribute("aria-label") || "";
          const kind = HEADER_SUBAGENTS.test(label) ? "subagents" : HEADER_JOBS.test(label) ? "jobs" : "";
          if (!kind) { if (button.hasAttribute("data-dmb-compact")) { button.removeAttribute("data-dmb-compact"); button.removeAttribute("data-dmb-count"); button.removeAttribute("data-dmb-live"); } continue; }
          const count = (label.match(/\d+/) || [""])[0];
          if (button.getAttribute("data-dmb-compact") !== kind) button.setAttribute("data-dmb-compact", kind);
          if ((button.getAttribute("data-dmb-count") || "") !== count) { if (count) button.setAttribute("data-dmb-count", count); else button.removeAttribute("data-dmb-count"); }
          if (button.getAttribute("title") !== label) button.setAttribute("title", label);
          const live = HEADER_LIVE.test(label);
          if (live !== button.hasAttribute("data-dmb-live")) { if (live) button.setAttribute("data-dmb-live", ""); else button.removeAttribute("data-dmb-live"); }
        }
      };
      let unsubscribePanel = () => {};
      try {
        const source = layoutService()?.panelInfo;
        if (source?.subscribe) unsubscribePanel = source.subscribe(() => placeFabs()) || (() => {});
      } catch (e) { /* layout not ready: the sync tick keeps the buttons right */ }

      let wasOpen = false;
      const sync = () => {
        watchSidebar();
        const open = isOpen();
        if (open && !wasOpen) readNestedView();
        if (open && !wasOpen && !openingRestored) restoreScroll();
        else if (open) remember();
        if (!open) openingRestored = false;
        wasOpen = open;
        markProjects();
        placeFabs();
        compactHeaderCounts();
        // Bring a newly active tab into view in the scrolling strip.
        const active = document.querySelector("[data-dockkit-strip-tabs] [aria-selected='true'], [data-dockkit-strip-tabs] [class*='_tabActive']");
        if (active && active !== lastActiveTab) {
          lastActiveTab = active;
          active.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        for (const button of document.querySelectorAll("[data-review-tool='split'][aria-pressed='true']")) {
          if (unified.has(button)) continue;
          unified.add(button);
          button.click();
        }
      };
      const timer = setInterval(sync, 300);
      // Start on the conversation even if the sidebar was left open last time.
      const initial = setTimeout(close, 500);

      // Tap the truncated thread title to read the full text as a lightweight
      // tooltip; a tap anywhere else dismisses it.
      let titleTip = null;
      let titleTipTimer = 0;
      const dismissTitleTip = () => {
        if (titleTip) { titleTip.remove(); titleTip = null; }
        clearTimeout(titleTipTimer);
      };
      const onTitleTap = (event) => {
        const crumb = event.target instanceof Element ? event.target.closest("[class*='_crumbCurrent']") : null;
        if (!crumb) { dismissTitleTip(); return; }
        const full = (crumb.textContent || "").trim();
        if (!full) return;
        dismissTitleTip();
        const rect = crumb.getBoundingClientRect();
        const tip = document.createElement("div");
        tip.className = "dmb-title-tip";
        tip.textContent = full;
        tip.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + "px";
        tip.style.top = (rect.bottom + 6) + "px";
        document.body.append(tip);
        titleTip = tip;
        titleTipTimer = setTimeout(dismissTitleTip, 4000);
      };
      document.addEventListener("click", onTitleTap, true);

      // A new session renders the whole composer capsule as a "choose workspace"
      // trigger. On the phone the message field must not open the picker — the
      // explicit workspace chip above it already does — so swallow that click.
      const onComposerClick = (event) => {
        const card = event.target instanceof Element
          ? event.target.closest("[data-composer-card][class*='_cardWorkspaceTrigger']")
          : null;
        if (!card) return;
        event.stopPropagation();
      };
      document.addEventListener("click", onComposerClick, true);

      return () => {
        clearInterval(timer);
        clearTimeout(initial);
        document.removeEventListener("click", onPick, true);
        document.removeEventListener("click", onTitleTap, true);
        document.removeEventListener("click", onComposerClick, true);
        window.removeEventListener("touchstart", onSheetTouchStart, true);
        window.removeEventListener("touchmove", onSheetTouchMove, true);
        window.removeEventListener("touchend", onSheetTouchEnd, true);
        window.removeEventListener("touchcancel", onSheetTouchCancel, true);
        for (const id of sheetTimers) clearTimeout(id);
        sheetTimers.clear();
        const sheet = settingsSheet();
        if (sheet) { sheet.style.transition = ""; sheet.style.transform = ""; }
        document.removeEventListener("focusin", onComposerFocus, true);
        document.removeEventListener("pointerdown", onComposerTouch, true);
        window.removeEventListener("dsh-mobile-bridge:open-session", onAppOpenSession);
        document.removeEventListener("scroll", onListScroll, true);
        document.removeEventListener("touchstart", onListInput, true);
        document.removeEventListener("wheel", onListInput, true);
        document.removeEventListener("click", onListClick, true);
        document.removeEventListener("visibilitychange", onLeave);
        window.removeEventListener("pagehide", onPageHide);
        clearTimeout(listClickTimer);
        cancelAnimationFrame(rememberFrame);
        if (persistTimer) persist();
        document.removeEventListener("touchstart", onReaderInput, true);
        document.removeEventListener("touchmove", onReaderInput, true);
        document.removeEventListener("touchend", onReaderInput, true);
        document.removeEventListener("touchcancel", onReaderInput, true);
        document.removeEventListener("wheel", onReaderInput, true);
        clearTimeout(settleTimer);
        document.removeEventListener("scroll", onChatScroll, true);
        document.removeEventListener("pointerdown", onRowPointerDown, true);
        document.removeEventListener("pointermove", onRowPointerMove, true);
        document.removeEventListener("pointerup", onRowPointerUp, true);
        document.removeEventListener("pointercancel", onRowPointerCancel, true);
        document.removeEventListener("dragstart", onRowDragStart, true);
        document.removeEventListener("dragover", onRowDragOver, true);
        document.removeEventListener("dragend", onRowDragEnd, true);
        document.removeEventListener("click", swallowAfterPress, true);
        document.removeEventListener("contextmenu", onRowContextMenu, true);
        cancelRowPress();
        cancelAnimationFrame(restoreFrame);
        dismissTitleTip();
        document.documentElement.classList.remove("dmb-phone");
        style.remove();
        leftFab.dispose();
        rightFab.dispose();
        closeFab.dispose();
        unsubscribePanel();
        for (const button of document.querySelectorAll("[data-dmb-compact]")) { button.removeAttribute("data-dmb-compact"); button.removeAttribute("data-dmb-count"); button.removeAttribute("data-dmb-live"); }
        backdrop.remove();
        sidebarObserver.disconnect();
        cancelAnimationFrame(markFrame);
        document.documentElement.classList.remove("dmb-sidebar-open");
        unmarkProjects();
      };
    }

    // Workspace folder chooser for the phone. DSH's "Add workspace" runs the computer's OS folder
    // dialog (the native directory picker), which opens on the computer and leaves the phone
    // waiting. Inside the app's WebView this occupant shadows it (lower slot priority) with an
    // in-page chooser fed by the owner-only /directories route (desktop-api.mjs).
    const DIR_ID = "dsh-mobile-bridge-directories";
    const DIR_STYLE = `
#${DIR_ID}{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#fff;color:#1a1a1a;font:15px/1.5 system-ui,-apple-system,"Hiragino Sans",sans-serif}
#${DIR_ID} .dmd-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px;border-bottom:1px solid #eee}
#${DIR_ID} .dmd-title{flex:1;font-weight:600;font-size:16px}
#${DIR_ID} .dmd-path{display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid #eee}
#${DIR_ID} .dmd-path input{flex:1;min-width:0;font:13px/1.4 ui-monospace,Menlo,monospace;padding:8px;border:1px solid #ccc;border-radius:8px;background:transparent;color:inherit}
#${DIR_ID} .dmd-list{flex:1;overflow:auto;-webkit-overflow-scrolling:touch}
#${DIR_ID} .dmd-row{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:0 16px;border:0;border-bottom:1px solid #f0f0f0;background:transparent;color:inherit;font:inherit;text-align:left}
#${DIR_ID} .dmd-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${DIR_ID} .dmd-note{padding:16px;color:#777;font-size:13px}
#${DIR_ID} .dmd-err{padding:12px 16px;color:#b00020;font-size:13px}
#${DIR_ID} .dmd-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid #eee}
#${DIR_ID} button.dmd-btn{font:inherit;min-height:40px;border-radius:10px;border:1px solid #ccc;background:#f6f6f6;color:inherit;padding:0 14px}
#${DIR_ID} button.dmd-primary{background:#0e6e62;border-color:#0e6e62;color:#fff}
#${DIR_ID} button:disabled{opacity:.5}
body[data-ds-dark-theme] #${DIR_ID}{background:#1b1b1b;color:#eee}
body[data-ds-dark-theme] #${DIR_ID} .dmd-head,body[data-ds-dark-theme] #${DIR_ID} .dmd-path,body[data-ds-dark-theme] #${DIR_ID} .dmd-foot{border-color:#333}
body[data-ds-dark-theme] #${DIR_ID} .dmd-row{border-color:#2a2a2a}
body[data-ds-dark-theme] #${DIR_ID} button.dmd-btn{background:#2b2b2b;border-color:#444}
body[data-ds-dark-theme] #${DIR_ID} button.dmd-primary{background:#0e6e62;border-color:#0e6e62}
body[data-ds-dark-theme] #${DIR_ID} .dmd-path input{border-color:#444}`;
    const DIR_ERRORS = {
      invalid_path: "フォルダは / から始まるパスで入れてください。",
      not_found: "そのフォルダは見つかりません。",
      permission_denied: "そのフォルダは開けません（権限がありません）。",
    };
    // Where the chooser starts: the folder of the workspace on the conversation's workspace chip,
    // else the folder picked last time (per phone), else the computer's home.
    const LAST_DIR_KEY = "dsh-mobile-bridge:last-directory";
    let workspacesService = () => undefined;
    function startDirectory() {
      const label = (document.querySelector("[class*='_workspaceLabel']")?.textContent || "").trim();
      let items = [];
      try { items = workspacesService()?.list?.getSnapshot?.()?.items || []; } catch (e) { /* workspace list unavailable */ }
      const current = label ? items.find((w) => w && w.title === label && typeof w.path === "string") : undefined;
      if (current) return current.path;
      try { return localStorage.getItem(LAST_DIR_KEY) || ""; } catch (e) { return ""; }
    }
    const FOLDER_ICON = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.8 4.2c0-.6.4-1 1-1h3.4l1.4 1.5h5.6c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z"/></svg>';

    /**
     * Directory-flow occupant (DSH's DirectoryFlowOwnerProps: open, busy, onPicked, onCancel,
     * onError). Renders nothing while closed.
     */
    function PhoneDirectoryFlow(props) {
      const h = react.createElement;
      const open = props.open;
      const [listing, setListing] = react.useState(null);
      const [loading, setLoading] = react.useState(false);
      const [error, setError] = react.useState("");
      const [input, setInput] = react.useState("");
      const request = react.useRef(0);

      // fallbackHome: a start folder that no longer exists quietly falls back to the home folder.
      const load = react.useCallback(async (path, fallbackHome) => {
        const n = ++request.current;
        setLoading(true);
        setError("");
        try {
          const body = await api("/directories" + (path ? "?path=" + encodeURIComponent(path) : ""));
          if (n !== request.current) return;
          setListing(body);
          setInput(body.path);
        } catch (e) {
          if (n !== request.current) return;
          if (fallbackHome && path) {
            load("", false);
            return;
          }
          setError(DIR_ERRORS[e.message] || e.message);
        } finally {
          if (n === request.current) setLoading(false);
        }
      }, []);

      react.useEffect(() => {
        if (!open) return;
        setListing(null);
        load(startDirectory(), true);
      }, [open, load]);

      if (!open) return null;
      const busy = !!props.busy;
      const row = (key, label, onClick) => h("button", { key, type: "button", className: "dmd-row", onClick, disabled: busy },
        h("span", { dangerouslySetInnerHTML: { __html: FOLDER_ICON }, style: { display: "flex", flex: "none" } }),
        h("span", null, label));
      const rows = [];
      if (listing && listing.parent) rows.push(row("..", "↑ 上のフォルダ", () => load(listing.parent)));
      if (listing) for (const entry of listing.entries) rows.push(row(entry.path, entry.name, () => load(entry.path)));

      return reactDom.createPortal(h("div", { id: DIR_ID, role: "dialog", "aria-modal": "true", "aria-label": "ワークスペースのフォルダを選ぶ" },
        h("style", null, DIR_STYLE),
        h("div", { className: "dmd-head" },
          h("div", { className: "dmd-title" }, "ワークスペースのフォルダを選ぶ"),
          h("button", { type: "button", className: "dmd-btn", disabled: busy || !listing, onClick: () => load(listing.home) }, "ホーム")),
        h("form", { className: "dmd-path", onSubmit: (e) => { e.preventDefault(); load(input.trim()); } },
          h("input", { value: input, onChange: (e) => setInput(e.target.value), "aria-label": "フォルダのパス", autoCapitalize: "off", autoCorrect: "off", spellCheck: false, inputMode: "url" }),
          h("button", { type: "submit", className: "dmd-btn", disabled: busy || loading || !input.trim() }, "移動")),
        error ? h("div", { className: "dmd-err", role: "alert" }, error) : null,
        h("div", { className: "dmd-list" },
          loading && !listing ? h("div", { className: "dmd-note" }, "読み込んでいます…") : null,
          rows,
          listing && listing.entries.length === 0 ? h("div", { className: "dmd-note" }, "この中にフォルダはありません。") : null,
          listing && listing.truncated ? h("div", { className: "dmd-note" }, "多すぎるため、最初の 1000 件だけ表示しています。") : null),
        h("div", { className: "dmd-foot" },
          h("button", { type: "button", className: "dmd-btn", onClick: () => props.onCancel() }, "キャンセル"),
          h("button", { type: "button", className: "dmd-btn dmd-primary", disabled: busy || loading || !listing, onClick: () => {
            try { localStorage.setItem(LAST_DIR_KEY, listing.path); } catch (e) { /* storage unavailable */ }
            props.onPicked(listing.path);
          } },
            busy ? "追加しています…" : "このフォルダを使う"))), document.body);
    }

    // "Save to phone" in the file preview's toolbar and in its "can't preview" empty state, where
    // the desktop offers "Open in <app>" (hidden on the phone). The link goes to the owner-only
    // /file route, which answers as an attachment; the app's download handler saves it to
    // Downloads on the phone.
    const SAVE_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10"/></svg>';
    function saveToPhone(path) {
      const a = document.createElement("a");
      a.href = API + "/file?path=" + encodeURIComponent(path);
      a.rel = "noopener";
      document.body.append(a);
      a.click();
      a.remove();
    }
    function SaveToPhoneAction(props) {
      const h = react.createElement;
      if (!props.absolutePath) return null;
      // Icon only, like the toolbar's other buttons; the name is in aria-label and the tooltip.
      return h("button", {
        type: "button",
        "aria-label": "スマホに保存",
        title: "スマホに保存",
        "data-dmb-save": "",
        onClick: () => saveToPhone(props.absolutePath),
        style: { display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: "36px", height: "36px", padding: "0", border: "0", borderRadius: "8px", background: "transparent", color: "inherit" },
      }, h("span", { dangerouslySetInnerHTML: { __html: SAVE_ICON }, style: { display: "flex" } }));
    }

    // When DSH restarts while the phone stays connected, DSH's page can fail while reconnecting and
    // stay blank (nothing rendered, no error shown). Inside the app's WebView, reload a page that has
    // been blank for a while, at most once a minute. A plain timer, not a ctx.effect: it has to
    // outlive the DSH client that failed.
    function installBlankPageReload() {
      if (window.__dshMobileBlankReload) return;
      window.__dshMobileBlankReload = 1;
      // A page that rendered before and went blank is broken after 8 s; a first load on a slow phone
      // may legitimately stay blank longer.
      const BLANK_AFTER_RENDER_MS = 8000;
      const BLANK_FIRST_LOAD_MS = 30000;
      const MIN_INTERVAL_MS = 60000;
      const KEY = "dsh-mobile-bridge:blank-reload-at";
      let rendered = false;
      let blankSince = 0;
      setInterval(() => {
        if (document.querySelector("[data-rightbar-col]")) rendered = true;
        const blank = document.visibilityState === "visible" && !!document.body &&
          !document.querySelector("[data-rightbar-col]") && document.body.innerText.trim() === "";
        if (!blank) { blankSince = 0; return; }
        const now = Date.now();
        if (blankSince === 0) { blankSince = now; return; }
        if (now - blankSince < (rendered ? BLANK_AFTER_RENDER_MS : BLANK_FIRST_LOAD_MS)) return;
        let last = 0;
        try { last = Number(sessionStorage.getItem(KEY) || 0); } catch (e) { /* storage unavailable: still reload once */ }
        if (now - last < MIN_INTERVAL_MS) return;
        try { sessionStorage.setItem(KEY, String(now)); } catch (e) { /* storage unavailable */ }
        console.warn("[dsh-mobile-bridge] the page stayed blank; reloading");
        location.reload();
      }, 2000);
    }

    // Search from DSH's built-in browser (right sidebar). Its address bar only takes HTTP(S)
    // addresses; words that are not an address become a search: Google on the desktop, Bing on the
    // phone, whose WebView can only show pages that allow being framed (Google, Yahoo and
    // DuckDuckGo refuse). The address bar is found by its localized label.
    const BROWSER_ADDRESS_LABELS = {
      "HTTP(S)アドレスを入力": "URL または検索ワード",
      "Enter an HTTP(S) address": "URL or search words",
      "输入 HTTP(S) 地址": "网址或搜索内容",
    };
    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

    /** Whether address-bar text is meant as an address (DSH opens or refuses it) rather than a search. */
    function looksLikeAddress(text) {
      if (/\s/.test(text)) return false;
      if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^:/]+:\d+([/?#]|$)/.test(text)) return true;
      const host = text.split(/[/?#]/)[0];
      if (/^localhost(:\d+)?$/i.test(host)) return true;
      if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) || /^\[[0-9a-f:]+\](:\d+)?$/i.test(host)) return true;
      return /^[^.]+(\.[^.]+)*\.[a-z][a-z0-9-]{1,62}(:\d+)?$/i.test(host);
    }

    function searchUrl(text) {
      const phone = navigator.userAgent.indexOf("DSHMobile/") !== -1;
      return (phone ? "https://www.bing.com/search?q=" : "https://www.google.com/search?q=") + encodeURIComponent(text);
    }

    function browserAddressInput(form) {
      const input = form.querySelector("input");
      return input && Object.hasOwn(BROWSER_ADDRESS_LABELS, input.getAttribute("aria-label") || "") ? input : null;
    }

    /** @returns {() => void} undo */
    function browserSearch() {
      const onSubmit = (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const input = browserAddressInput(form);
        if (!input) return;
        const text = input.value.trim();
        if (text === "" || looksLikeAddress(text)) return;
        // Runs before React's own submit handler: replace the words with a search address, let
        // React take the new value, then submit again (an address passes straight through).
        event.preventDefault();
        event.stopImmediatePropagation();
        inputValueSetter.call(input, searchUrl(text));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        requestAnimationFrame(() => form.requestSubmit());
      };
      const hint = () => {
        for (const [label, placeholder] of Object.entries(BROWSER_ADDRESS_LABELS)) {
          for (const input of document.querySelectorAll(`input[aria-label="${label}"]`)) {
            if (input.placeholder !== placeholder) input.placeholder = placeholder;
          }
        }
      };
      document.addEventListener("submit", onSubmit, true);
      const observer = new MutationObserver(hint);
      observer.observe(document.body, { childList: true, subtree: true });
      hint();
      return () => {
        document.removeEventListener("submit", onSubmit, true);
        observer.disconnect();
      };
    }

    // The built-in browser's "Open in system browser" uses window.open, which the app's WebView
    // ignores. On the phone, open the address with a plain link instead: the app hands links that
    // leave the computer to Chrome. This is also the way out for pages that refuse to be framed.
    const EXTERNAL_LABELS = ["システムブラウザで開く", "Open in system browser", "在系统浏览器中打开"];

    /** @returns {() => void} undo */
    function phoneExternalOpen() {
      const onClick = (event) => {
        const target = event.target;
        const button = target instanceof Element ? target.closest("button[aria-label]") : null;
        if (!button || !EXTERNAL_LABELS.includes(button.getAttribute("aria-label") || "")) return;
        const form = button.closest("form");
        const input = form ? browserAddressInput(form) : null;
        const url = input ? input.value.trim() : "";
        if (!/^https?:\/\//i.test(url)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const a = document.createElement("a");
        a.href = url;
        a.rel = "noopener noreferrer";
        document.body.append(a);
        a.click();
        a.remove();
      };
      document.addEventListener("click", onClick, true);
      return () => document.removeEventListener("click", onClick, true);
    }

    /**
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-mobile-bridge";
        style.textContent = STYLE;
        document.head.append(style);
        const onOpen = (event) => {
          const sessionId = event && event.detail && event.detail.sessionId;
          if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return;
          const workspace = ctx.get("uiWorkspace");
          try {
            if (workspace) workspace.openSession(sessionId);
          } catch (error) {
            console.warn("[dsh-mobile-bridge] openSession failed", error && error.message);
          }
        };
        window.addEventListener("dsh-mobile-bridge:open-session", onOpen);
        window.__dshMobileBridgeClient = 1;
        return () => {
          window.removeEventListener("dsh-mobile-bridge:open-session", onOpen);
          if (window.__dshMobileBridgeClient === 1) delete window.__dshMobileBridgeClient;
          style.remove();
          const panel = document.getElementById(PANEL_ID);
          if (panel) panel.remove();
        };
      }, "mobile-bridge: page hooks");

      ctx.effect(() => browserSearch(), "mobile-bridge: browser search");

      if (navigator.userAgent.indexOf("DSHMobile/") !== -1) {
        installBlankPageReload();
        workspacesService = () => ctx.get("workspaces");
        ctx.effect(() => phoneExternalOpen(), "mobile-bridge: open in the phone's browser");
        const service = (name) => () => { try { return ctx.get(name); } catch (e) { return undefined; } };
        ctx.effect(() => phoneLayout({ workspaces: service("workspaces"), uiSession: service("uiSession"), sessions: service("sessions"), layout: service("layout") }), "mobile-bridge: phone layout");
        // Priority -1 shadows the stock chooser (priority 0) in both directory-flow slots.
        ctx.effect(() => ctx.slots.inject("conversation.hero.workspace.directoryFlow", () =>
          ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
            yield ctx.slots.register({ name: "conversation.hero.workspace.directoryFlow", priority: -1 }, PhoneDirectoryFlow);
            yield ctx.slots.register({ name: "sidebar.workspaces.directoryFlow", priority: -1 }, PhoneDirectoryFlow);
          })), "mobile-bridge: phone workspace chooser");
        ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document.actions", () =>
          ctx.slots.register({ name: "sidebar.right.tab.document.actions", id: "dsh-mobile-save" }, SaveToPhoneAction)), "mobile-bridge: save previewed file");
        ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document.unpreviewable", () =>
          ctx.slots.register({ name: "sidebar.right.tab.document.unpreviewable", id: "dsh-mobile-save" }, SaveToPhoneAction)), "mobile-bridge: save unpreviewable file");
      }

      // The pairing button only makes sense on the desktop, not inside the phone's WebView.
      if (navigator.userAgent.indexOf("DSHMobile/") === -1) {
        ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-mobile-bridge",
        }, Trigger)), "mobile-bridge: sidebar button");
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
