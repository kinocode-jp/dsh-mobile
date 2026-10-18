// dsh-mobile-bridge — browser half, loaded into the DSH Web UI.
// 1. Adds a sidebar footer button 「スマホを接続」 that shows the pairing QR and the paired phones
//    (data from the owner-only /api/dsh-mobile-bridge/* routes registered by desktop-api.mjs).
// 2. Lets the DSH Mobile app open a session: the app's page script dispatches
//    `dsh-mobile-bridge:open-session` and this calls the Client Workspace service.
window.__ModuleLoader__.load({
  id: "@kinocode/dsh-mobile",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
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
