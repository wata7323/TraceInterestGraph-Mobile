(() => {
  "use strict";

  const STORAGE_KEY = "trace-cloud-sync-v1";
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const els = {
    setup: document.querySelector("#cloudSetup"),
    ready: document.querySelector("#cloudReady"),
    create: document.querySelector("#createCloudSync"),
    join: document.querySelector("#joinCloudSync"),
    input: document.querySelector("#cloudSyncCode"),
    sync: document.querySelector("#cloudSyncNow"),
    showCode: document.querySelector("#showCloudCode"),
    reset: document.querySelector("#resetCloudSync"),
    role: document.querySelector("#cloudRole"),
    code: document.querySelector("#cloudCodeDisplay"),
    message: document.querySelector("#cloudSyncMessage")
  };

  const endpoint = () => String(window.TRACE_CLOUD_SYNC_URL || "").replace(/\/$/, "");
  const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fromBase64url = text => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)), char => char.charCodeAt(0));
  const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  const normalizeCode = value => String(value || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
  const displayCode = code => normalizeCode(code).match(/.{1,5}/g)?.join("-") || "";

  function readConfig() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return value && ["sender", "receiver"].includes(value.role) && normalizeCode(value.code).length === 20 ? value : null;
    } catch { return null; }
  }

  function saveConfig(config) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ role: config.role, code: normalizeCode(config.code) }));
  }

  function makeCode() {
    const random = crypto.getRandomValues(new Uint8Array(20));
    return [...random].map(value => ALPHABET[value % ALPHABET.length]).join("");
  }

  async function deriveKeys(code) {
    const normalized = normalizeCode(code);
    if (normalized.length !== 20 || [...normalized].some(char => !ALPHABET.includes(char))) throw new Error("接続コードを確認してください。");
    const material = await crypto.subtle.importKey("raw", encoder.encode(normalized), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode("trace-cloud-sync-v1"), iterations: 200000 }, material, 512));
    const encryptionKey = await crypto.subtle.importKey("raw", bits.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const channelHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`channel:${normalized}`)));
    return { encryptionKey, auth: base64url(bits.slice(32)), channel: hex(channelHash).slice(0, 32) };
  }

  async function encrypt(text, keys) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(keys.channel) }, keys.encryptionKey, encoder.encode(text)));
    return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), iv: base64url(iv), ciphertext: base64url(ciphertext) });
  }

  async function decrypt(text, keys) {
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error("クラウド上のデータを読み取れません。"); }
    if (!payload || payload.version !== 1 || typeof payload.iv !== "string" || typeof payload.ciphertext !== "string") throw new Error("クラウド上のデータ形式が不正です。");
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(payload.iv), additionalData: encoder.encode(keys.channel) }, keys.encryptionKey, fromBase64url(payload.ciphertext));
      return decoder.decode(plain);
    } catch { throw new Error("接続コードが違うか、データが壊れています。"); }
  }

  async function request(config, method, body) {
    if (!endpoint()) throw new Error("クラウド保管箱の準備がまだ完了していません。");
    if (!window.isSecureContext || !crypto.subtle) throw new Error("暗号化を利用できる安全な画面から開いてください。");
    const keys = await deriveKeys(config.code);
    const response = await fetch(`${endpoint()}/v1/sync/${keys.channel}`, {
      method,
      headers: { "Authorization": `Bearer ${keys.auth}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body
    });
    if (response.status === 404) return { response, keys, missing: true };
    const data = await response.text();
    if (!response.ok) {
      let message = "クラウド同期に失敗しました。";
      try { message = JSON.parse(data).error || message; } catch {}
      throw new Error(message);
    }
    return { response, keys, data };
  }

  async function push() {
    const config = readConfig();
    if (!config || config.role !== "sender") throw new Error("この端末は送信用に設定されていません。");
    els.message.textContent = "暗号化して送信しています…";
    const packageText = await window.TraceApp.exportPackage();
    const keys = await deriveKeys(config.code);
    const encrypted = await encrypt(packageText, keys);
    if (encrypted.length > 20 * 1024 * 1024) throw new Error("写真を含むデータが大きすぎます。写真を減らして再試行してください。");
    await request(config, "POST", encrypted);
    els.message.textContent = `送信しました（${new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date())}）。PCは起動時に自動受信します。`;
  }

  async function pull(silent = false) {
    const config = readConfig();
    if (!config || config.role !== "receiver") return;
    if (!silent) els.message.textContent = "スマホのメモを確認しています…";
    const result = await request(config, "GET");
    if (result.missing) {
      els.message.textContent = "スマホからの最初の送信を待っています。";
      return;
    }
    const etag = result.response.headers.get("ETag") || "";
    if (etag && etag === localStorage.getItem(`${STORAGE_KEY}:etag`)) {
      if (!silent) els.message.textContent = "受信済みです。新しいメモはありません。";
      return;
    }
    const packageText = await decrypt(result.data, result.keys);
    const parsed = window.TraceTransfer.parsePackage(packageText);
    if (parsed.ignored) throw new Error("安全に読み取れないメモがあるため、自動受信を中止しました。");
    const plan = await window.TraceApp.importMemos(parsed.memos);
    if (etag) localStorage.setItem(`${STORAGE_KEY}:etag`, etag);
    els.message.textContent = plan.writes ? `${plan.writes}件を受信しました。既存メモは変更していません。` : "受信済みです。新しいメモはありません。";
  }

  function render() {
    const config = readConfig();
    els.setup.hidden = Boolean(config);
    els.ready.hidden = !config;
    els.code.hidden = true;
    if (!config) {
      els.role.textContent = "";
      return;
    }
    els.role.textContent = config.role === "sender" ? "スマホ：送信側" : "PC：自動受信側";
    els.sync.textContent = config.role === "sender" ? "同期する" : "今すぐ確認";
  }

  els.create.addEventListener("click", async () => {
    const config = { role: "sender", code: makeCode() };
    saveConfig(config);
    render();
    els.code.textContent = displayCode(config.code);
    els.code.hidden = false;
    els.message.textContent = "この接続コードをPC版へ一度だけ入力してください。続けて現在のメモを送信します。";
    try { await push(); } catch (error) { els.message.textContent = error.message; }
  });

  els.join.addEventListener("click", async () => {
    const code = normalizeCode(els.input.value);
    if (code.length !== 20) {
      els.message.textContent = "20文字の接続コードを入力してください。";
      return;
    }
    saveConfig({ role: "receiver", code });
    els.input.value = "";
    render();
    try { await pull(); } catch (error) { els.message.textContent = error.message; }
  });

  els.sync.addEventListener("click", async () => {
    els.sync.disabled = true;
    try {
      const config = readConfig();
      if (config?.role === "sender") await push(); else await pull();
    } catch (error) { els.message.textContent = error.message; }
    finally { els.sync.disabled = false; }
  });

  els.showCode.addEventListener("click", () => {
    const config = readConfig();
    if (!config) return;
    els.code.textContent = displayCode(config.code);
    els.code.hidden = !els.code.hidden;
  });

  els.reset.addEventListener("click", () => {
    if (!confirm("クラウド同期の接続設定だけをやり直しますか？ メモは削除されません。")) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(`${STORAGE_KEY}:etag`);
    els.message.textContent = "接続設定を解除しました。メモはそのまま残っています。";
    render();
  });

  (async () => {
    await window.TraceApp.ready;
    render();
    const config = readConfig();
    if (config?.role === "receiver") {
      try { await pull(true); } catch (error) { els.message.textContent = error.message; }
      setInterval(() => pull(true).catch(error => { els.message.textContent = error.message; }), 30000);
    }
  })();
})();
