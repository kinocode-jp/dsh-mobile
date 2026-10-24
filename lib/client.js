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
    const SESSION_ROW = "[data-row-key^='session:']";
    const ROW_ACTIONS = "[class*='_rowActions']";
    const SIDEBAR_SCROLL_KEY = "dsh-mobile-bridge:sidebar-scroll";
    // Older history starts loading this far from the top (or 1.5 screens, whichever is more), once
    // scrolling has been still for OLDER_SETTLE_MS, up to OLDER_ARM_MS after the reader's last touch or
    // wheel (covers momentum scrolling).
    const OLDER_NEAR_TOP_PX = 800;
    const OLDER_ARM_MS = 4000;
    const OLDER_SETTLE_MS = 250;
    const OLDER_WHEEL_GAP_MS = 400;
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
      "body[data-ds-dark-theme] .dmb-fab { background: rgba(40, 40, 40, 0.9); color: #eee; border-color: rgba(255, 255, 255, 0.15); }",
      ".dmb-backdrop { position: fixed; inset: 0; z-index: 999; background: rgba(0, 0, 0, 0.25); }",
      // The backdrop follows DSH's collapsed mark in the same frame the sidebar hides; a JS-only toggle
      // lagged behind, and the app's swipe-close (which fades the backdrop out and then clears its
      // opacity) flashed it dark again until that toggle ran.
      "html.dmb-phone:has([class*='_sidebarCol'] [class*='_collapsed']) .dmb-backdrop, html.dmb-phone:not(:has([class*='_sidebarCol'])) .dmb-backdrop, .dmb-backdrop[hidden] { display: none; }",
      // A closed project shows its most urgent session state (see projectStatus) where DSH shows a
      // session's: amber dot = waiting for you, spinner = running, green dot = finished, not yet viewed.
      "html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status]::after { content: ''; flex: none; box-sizing: border-box; margin-left: 6px; border-radius: 50%; }",
      "html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status='warning']::after { width: 6px; height: 6px; margin-right: 4px; background: var(--dsw-alias-state-warn-primary, #d29922); }",
      "html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status='done']::after { width: 6px; height: 6px; margin-right: 4px; background: var(--dsw-alias-state-success-primary, #3fb950); }",
      "html.dmb-phone [data-row-key^='workspace:'][aria-expanded='false'][data-dmb-status='ongoing']::after { width: 12px; height: 12px; margin-right: 1px; border: 2px solid color-mix(in srgb, var(--dsw-alias-label-tertiary, #999) 30%, transparent); border-top-color: var(--dsw-alias-label-tertiary, #999); animation: dmb-project-spin 0.9s linear infinite; }",
      "@keyframes dmb-project-spin { to { transform: rotate(360deg); } }",
      "@media (prefers-reduced-motion: reduce) { html.dmb-phone [data-row-key^='workspace:'][data-dmb-status='ongoing']::after { animation: none; } }",
      // Hide the "深掘り中…" running label while the AI is answering.
      "html.dmb-phone [data-chat-running] { display: none !important; }",
      // Thread title: drop the fixed 220px cap and let the current crumb fill the
      // header's remaining width with its own ellipsis.
      "html.dmb-phone header:has([class*='_crumbCurrent']) [class*='_crumbs'] { flex: 1 1 0; min-width: 0; }",
      "html.dmb-phone header:has([class*='_crumbCurrent']) [class*='_crumbSeg']:has([class*='_crumbCurrent']) { flex: 1 1 0; min-width: 0; }",
      "html.dmb-phone header:has([class*='_crumbCurrent']) [class*='_crumbCurrent'] { flex: 1 1 0; min-width: 0; max-width: none !important; box-sizing: border-box; }",
      ".dmb-title-tip { position: fixed; z-index: 1002; max-width: min(90vw, 360px); padding: 8px 12px; border-radius: 10px; background: rgba(30,30,30,0.95); color: #eee; font-size: 13px; line-height: 1.5; box-shadow: 0 4px 16px rgba(0,0,0,0.3); overflow-wrap: anywhere; }",
      "body[data-ds-dark-theme] .dmb-title-tip { background: rgba(52,52,52,0.98); }",
      // Settings: the desktop 800px panel squeezes the nav rail + content on a
      // phone. Make it a full-viewport sheet with a horizontal section tab strip.
      "html.dmb-phone [data-shortcut-modal='settings'] { width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; border-radius: 0 !important; flex-direction: column !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] > [class*='_nav'] { flex: none !important; width: 100% !important; gap: 8px !important; padding: 10px 12px !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] [class*='_navList'] { flex-direction: row !important; flex-wrap: nowrap !important; overflow-x: auto !important; overflow-y: hidden !important; gap: 6px !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] [class*='_navCell'] { flex: none !important; height: 36px !important; min-height: 36px !important; padding: 0 12px !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] [class*='_navLabel'] { flex: none !important; overflow: visible !important; text-overflow: clip !important; white-space: nowrap !important; }",
      "html.dmb-phone [data-shortcut-modal='settings'] > [class*='_content'] { flex: 1 1 auto !important; min-width: 0 !important; min-height: 0 !important; }",
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
     * finished run not yet viewed. Archived and blank sessions do not count.
     * @param {{workspaces: any, uiSession: any, sessions: any}} services
     * @returns {Map<string, "warning"|"ongoing"|"done">}
     */
    function projectStatus(services) {
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

      // The session list opens where it was left. DSH unmounts the list while the sidebar is
      // collapsed, which drops its scroll offset and how far each workspace was paged with
      // "さらに…件のセッションを表示" (each press shows a few more). Both are kept here — the
      // offset and the number of sessions shown per workspace — and put back on every opening.
      // Stored per phone; a blocked storage keeps them for this page only.
      const sessionList = () => {
        const s = sidebar();
        return s ? s.querySelector("[role='tree']") : null;
      };
      const groupOf = (list, workspaceId) => {
        const row = list.querySelector("[data-row-key=\"workspace:" + CSS.escape(workspaceId) + "\"]");
        return row ? row.closest("[class*='_groupSection']") : null;
      };
      const shownIn = (group) => group.querySelectorAll(SESSION_ROW).length;
      let saved = { top: 0, shown: {} };
      try {
        const stored = JSON.parse(localStorage.getItem(SIDEBAR_SCROLL_KEY) || "null");
        if (stored && typeof stored.top === "number" && stored.shown && typeof stored.shown === "object") saved = { top: stored.top, shown: stored.shown };
      } catch (e) { /* storage unavailable or unreadable: start at the top */ }
      let restoring = false;
      const remember = () => {
        const list = sessionList();
        if (restoring || !list || !isOpen()) return;
        const shown = {};
        for (const row of list.querySelectorAll("[data-row-key^='workspace:'][aria-expanded='true']")) {
          const id = row.getAttribute("data-row-key").slice("workspace:".length);
          const group = row.closest("[class*='_groupSection']");
          if (group) shown[id] = shownIn(group);
        }
        const next = { top: Math.round(list.scrollTop), shown };
        if (JSON.stringify(next) === JSON.stringify(saved)) return;
        saved = next;
        try { localStorage.setItem(SIDEBAR_SCROLL_KEY, JSON.stringify(saved)); } catch (e) { /* storage unavailable: kept for this page */ }
      };
      const onListScroll = (event) => {
        if (event.target === sessionList()) remember();
      };
      document.addEventListener("scroll", onListScroll, true);
      let restoreFrame = 0;
      // The list renders over a few frames after the sidebar opens, and each "さらに…" press adds
      // rows on the next render: page one step per frame, then set the offset once it can stick.
      const restoreScroll = () => {
        cancelAnimationFrame(restoreFrame);
        restoring = true;
        let frames = 0;
        const step = () => {
          markProjects();
          const list = sessionList();
          let done = false;
          if (list && isOpen()) {
            let paging = false;
            for (const [id, count] of Object.entries(saved.shown)) {
              const group = groupOf(list, id);
              const more = group && group.querySelector("[data-row-key=\"overflow:" + CSS.escape(id) + "\"]");
              if (more && shownIn(group) < count) { more.click(); paging = true; }
            }
            list.scrollTop = saved.top;
            done = !paging && Math.abs(list.scrollTop - saved.top) <= 1;
          }
          if (done || ++frames > 60) {
            restoreFrame = requestAnimationFrame(() => { restoring = false; });
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
      // Only the reader's own touch or wheel arms it, so the opening scroll to the latest message or a
      // turn jump never pages history in by itself; a chat too short to scroll loads on a swipe. One
      // gesture loads at most one page: folded turns are short, so a page may leave the reader at the top,
      // and a single swipe must not pull in the whole history.
      let readerInputAt = 0;
      let lastChatScrollAt = 0;
      let touching = false;
      let gesture = 0;
      let loadedGesture = -1;
      let lastWheelAt = 0;
      let settleTimer = 0;
      const chatScroller = () => {
        // The chat column itself does not scroll; the conversation body around it does.
        const flow = document.querySelector("[data-chat-flow]");
        return flow ? flow.closest("[data-conversation-scroll]") : null;
      };
      const loadOlderNearTop = () => {
        const now = Date.now();
        if (touching || now - readerInputAt > OLDER_ARM_MS || loadedGesture === gesture) return;
        if (now - lastChatScrollAt < OLDER_SETTLE_MS) { scheduleOlderCheck(); return; }
        const scroller = chatScroller();
        const button = scroller && scroller.querySelector("[data-chat-flow] > [class*='_older'] button");
        if (!button || button.disabled) return;
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
        if (event.type === "touchend" || event.type === "touchcancel") {
          if (!touching) return;
          touching = false;
          scheduleOlderCheck();
          return;
        }
        if (!inChat(event)) return;
        const now = Date.now();
        if (event.type === "touchstart") { touching = true; gesture++; }
        if (event.type === "wheel") {
          if (now - lastWheelAt > OLDER_WHEEL_GAP_MS) gesture++;
          lastWheelAt = now;
          scheduleOlderCheck();
        }
        readerInputAt = now;
      };
      const onChatScroll = (event) => {
        if (event.target !== chatScroller()) return;
        lastChatScrollAt = Date.now();
        scheduleOlderCheck();
      };
      document.addEventListener("touchstart", onReaderInput, { capture: true, passive: true });
      document.addEventListener("touchend", onReaderInput, { capture: true, passive: true });
      document.addEventListener("touchcancel", onReaderInput, { capture: true, passive: true });
      document.addEventListener("wheel", onReaderInput, { capture: true, passive: true });
      document.addEventListener("scroll", onChatScroll, true);

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
      // Dropped where it started (or nowhere): that was a long press, not a move.
      const onRowDragEnd = () => {
        const press = rowPress;
        if (!press || !press.dragging) return;
        if (!press.moved && press.row.isConnected) setTimeout(() => openRowMenu(press), 0);
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
      const markProjects = () => {
        const s = sidebar();
        if (!s || !services) return;
        let states;
        try {
          states = projectStatus({ workspaces: services.workspaces(), uiSession: services.uiSession(), sessions: services.sessions() });
        } catch (e) {
          return; // A service missing or still loading: leave the rows as they are.
        }
        for (const row of s.querySelectorAll("[data-row-key^='workspace:']")) {
          const state = states.get(row.getAttribute("data-row-key").slice("workspace:".length));
          if ((row.getAttribute("data-dmb-status") || undefined) === state) continue;
          if (state) {
            row.setAttribute("data-dmb-status", state);
            row.setAttribute("aria-description", STATUS_LABEL[state]);
          } else {
            row.removeAttribute("data-dmb-status");
            row.removeAttribute("aria-description");
          }
        }
      };

      const backdrop = document.createElement("div");
      backdrop.className = "dmb-backdrop";
      backdrop.addEventListener("click", close);
      document.body.append(backdrop);

      // Picking a session or starting a new one closes the overlay.
      const onPick = (event) => {
        const s = sidebar();
        const target = event.target;
        if (!s || !isOpen() || !(target instanceof Element) || !s.contains(target)) return;
        // The row's own buttons (the "..." menu, pin, archive) act on the row without opening it.
        if (target.closest(ROW_ACTIONS)) return;
        const button = target.closest("button[aria-label]");
        if (target.closest("[data-row-key^='session:']") || (button && NEW_SESSION_LABEL.test(button.getAttribute("aria-label") || ""))) {
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
      let wasOpen = false;
      const sync = () => {
        const open = isOpen();
        if (open && !wasOpen && !restoring) restoreScroll();
        else if (open) remember();
        wasOpen = open;
        markProjects();
        leftFab.button.hidden = open || rightOpen();
        rightFab.button.hidden = open || rightOpen() || !rightExpand();
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
        document.removeEventListener("scroll", onListScroll, true);
        document.removeEventListener("touchstart", onReaderInput, true);
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
        backdrop.remove();
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
        ctx.effect(() => phoneLayout({ workspaces: service("workspaces"), uiSession: service("uiSession"), sessions: service("sessions") }), "mobile-bridge: phone layout");
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
