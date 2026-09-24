(() => {
  "use strict";

  const DB_NAME = "trace-interest-graph";
  const DB_VERSION = 1;
  const STORE = "memos";
  const REACTIONS = ["おもろい", "面白い", "なんか好き", "好き", "気になる", "違和感", "微妙", "ダサい", "落ち着く", "欲しい", "また行きたい"];
  const STOPWORDS = new Set(["これ", "それ", "あれ", "ここ", "そこ", "ため", "よう", "もの", "こと", "感じ", "ちょっと", "なんか", "みたい", "やってた", "だった", "です", "ます", "する", "して", "いる", "ある"]);
  const KEY_TERMS = [
    "東京駅", "丸の内", "Nintendo Museum", "Nintendo", "ミュージアム", "イベント", "ポップアップ",
    "通路", "展示", "空間", "体験", "広告", "ポスター", "照明", "内装", "喫茶店", "ホテル",
    "音声UI", "音声", "UI", "ゲーム", "散歩", "日記", "AIエージェント", "ローカルLLM", "デザイン"
  ];
  const CONCEPTS = {
    "空間体験": ["駅", "通路", "展示", "空間", "内装", "照明", "ミュージアム", "museum", "順路", "場所全体", "店舗"],
    "一時性": ["イベント", "ポップアップ", "期間限定", "今日だけ", "企画展"],
    "視覚表現": ["広告", "ポスター", "パッケージ", "照明", "色", "デザイン", "ui"],
    "遊びの設計": ["nintendo", "ゲーム", "遊ぶ", "体験", "museum"],
    "画面を見ない体験": ["散歩", "音声", "ポッドキャスト", "ながら", "話す"],
    "個人の記録": ["日記", "メモ", "記録", "ログ", "振り返り"]
  };
  const BUILT_IN_SAMPLE_TEXTS = new Set([
    "東京駅で変なイベントやってた。通路を展示に使ってるのがおもろい。",
    "丸の内のポップアップ。照明と展示の距離感がなんか好き。",
    "Nintendo Museum。ゲームを遊ぶ順路そのものが気になる。場所全体がコンテンツみたい。",
    "古いホテルのロビー。少し暗い照明と、長く居ても怒られなさそうな空気が落ち着く。",
    "散歩中に音声で日記を残して、あとからAIが整理してくれたら欲しい。"
  ]);

  const els = {
    form: document.querySelector("#memoForm"),
    text: document.querySelector("#memoText"),
    photo: document.querySelector("#photoInput"),
    photoPreview: document.querySelector("#photoPreview"),
    withLocation: document.querySelector("#withLocation"),
    charCount: document.querySelector("#charCount"),
    message: document.querySelector("#formMessage"),
    syncState: document.querySelector("#syncState"),
    discover: document.querySelector("#discoverGrid"),
    graph: document.querySelector("#graph"),
    layoutState: document.querySelector("#layoutState"),
    mapDetail: document.querySelector("#mapDetail"),
    list: document.querySelector("#memoList"),
    search: document.querySelector("#searchInput"),
    editDialog: document.querySelector("#editDialog"),
    editForm: document.querySelector("#editForm"),
    editText: document.querySelector("#editText"),
    editKeywords: document.querySelector("#editKeywords"),
    exportMemos: document.querySelector("#exportMemos"),
    importMemos: document.querySelector("#importMemos"),
    transferMessage: document.querySelector("#transferMessage")
  };

  let db;
  let memos = [];
  let photoData = null;
  let editingId = null;
  const analyzing = new Set();
  let graphFrame = null;
  let graphEventsBound = false;
  let graphModel = { nodes: [], edges: [], projected: [] };
  let semanticLinks = [];
  let semanticSignature = "";
  let semanticState = "idle";
  let serverConnected = false;
  let layoutRequestToken = 0;
  let lastForceSignature = "";
  const LAYOUT_STORAGE = "trace-semantic-layout-v2";
  const CLOUD_MAP_STORAGE = "trace-semantic-cloud-map-v1";
  const graphView = { yaw: -.55, pitch: .28, zoom: 1, dragging: false, moved: false, lastX: 0, lastY: 0, hover: null, selected: null };
  let resolveAppReady;
  const appReady = new Promise(resolve => { resolveAppReady = resolve; });

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const clean = value => String(value || "").trim().replace(/\s+/g, " ");
  const truncate = (value, n = 34) => clean(value).length > n ? `${clean(value).slice(0, n)}…` : clean(value);
  const formatDate = iso => new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const relativeDate = iso => {
    const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
    if (days === 0) return "今日";
    if (days < 30) return `${days}日前`;
    if (days < 365) return `${Math.round(days / 30)}か月前`;
    return `${Math.round(days / 365)}年前`;
  };

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function storeRequest(mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const getAllRaw = () => storeRequest("readonly", store => store.getAll());
  const putMemo = memo => storeRequest("readwrite", store => store.put(memo));

  function extractKeywords(text) {
    const lowered = text.toLowerCase();
    const found = [];
    KEY_TERMS.forEach(term => {
      if (lowered.includes(term.toLowerCase())) found.push(term);
    });
    const chunks = text.match(/[一-龠々〆ヵヶァ-ヶー]{2,12}|[A-Za-z][A-Za-z0-9-]{1,24}/g) || [];
    chunks.forEach(word => {
      const value = clean(word);
      if (!STOPWORDS.has(value) && !REACTIONS.some(r => value === r) && value.length > 1) found.push(value);
    });
    return [...new Set(found)].sort((a, b) => a.length - b.length).slice(0, 7);
  }

  function extractReactions(text) {
    return REACTIONS.filter(signal => text.includes(signal)).filter((v, i, a) => !a.some((other, j) => j < i && other.includes(v)));
  }

  function inferConcepts(memo) {
    const haystack = `${memo.text} ${(memo.keywords || []).join(" ")}`.toLowerCase();
    const local = Object.entries(CONCEPTS).filter(([, terms]) => terms.some(term => haystack.includes(term))).map(([name]) => name);
    const ai = [
      ...((memo.aiTags && memo.aiTags.concept_tags) || []),
      ...((memo.aiTags && memo.aiTags.broad_tags) || [])
    ].filter(tag => (memo.keywords || []).includes(tag));
    return [...new Set([...local, ...ai])];
  }

  const uniqueTags = (...groups) => [...new Set(groups.flat().map(clean).filter(Boolean))];

  function analysisLabel(memo) {
    if (memo.aiStatus === "completed") return "AI整理済み";
    if (memo.aiStatus === "processing") return "AI整理中…";
    if (memo.aiStatus === "failed") return "AI整理を再試行できます";
    return "AI整理待ち";
  }

  async function analyzeMemo(memo) {
    if (!memo || memo.deletedAt || analyzing.has(memo.id) || memo.aiStatus === "completed") return;
    analyzing.add(memo.id);
    const working = { ...memo, aiStatus: "processing", aiError: null, updatedAt: new Date().toISOString() };
    await putMemo(working);
    await reload();
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: working.text })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.tags) throw new Error(data.error || "AI整理を実行できませんでした。");
      const latest = (await getAllRaw()).find(item => item.id === working.id);
      if (!latest || latest.deletedAt || latest.text !== working.text) return;
      const tags = data.tags;
      const aiKeywords = uniqueTags(tags.surface_tags || [], tags.canonical_tags || [], tags.concept_tags || [], tags.broad_tags || []);
      const explicitAiReactions = (tags.reaction_tags || []).filter(tag => latest.text.includes(tag));
      latest.keywords = uniqueTags(latest.keywords || [], aiKeywords).slice(0, 18);
      latest.reactions = uniqueTags(extractReactions(latest.text), explicitAiReactions).slice(0, 8);
      latest.aiTags = tags;
      latest.aiModel = data.model;
      latest.aiStatus = "completed";
      latest.aiAnalyzedAt = new Date().toISOString();
      latest.aiError = null;
      latest.updatedAt = latest.aiAnalyzedAt;
      await putMemo(latest);
      await reload();
      els.message.textContent = "メモを保存し、AIがタグを整理しました。";
      trySync();
    } catch (error) {
      const latest = (await getAllRaw()).find(item => item.id === working.id);
      if (latest && !latest.deletedAt) {
        latest.aiStatus = "failed";
        latest.aiError = error.message || "AI整理を実行できませんでした。";
        latest.updatedAt = new Date().toISOString();
        await putMemo(latest);
        await reload();
      }
      els.message.textContent = "メモは保存済みです。AI整理はあとで再試行できます。";
    } finally {
      analyzing.delete(memo.id);
    }
  }

  async function processPendingAnalyses() {
    const pending = (await getAllRaw())
      .filter(memo => !memo.deletedAt && (!memo.aiStatus || memo.aiStatus === "pending" || memo.aiStatus === "processing"))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const memo of pending) await analyzeMemo(memo);
  }

  function haversine(a, b) {
    if (!a || !b) return 0;
    const rad = n => n * Math.PI / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLon = rad(b.longitude - a.longitude);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function scorePair(a, b) {
    const ak = new Set((a.keywords || []).map(x => x.toLowerCase()));
    const bk = new Set((b.keywords || []).map(x => x.toLowerCase()));
    const commonKeywords = [...ak].filter(x => bk.has(x));
    const keywordUnion = new Set([...ak, ...bk]).size || 1;
    const keyword = commonKeywords.length / keywordUnion;
    const ac = inferConcepts(a);
    const bc = inferConcepts(b);
    const bridge = ac.filter(x => bc.includes(x));
    const concept = bridge.length / Math.max(1, new Set([...ac, ...bc]).size);
    const reaction = (a.reactions || []).some(x => (b.reactions || []).includes(x)) ? 1 : 0;
    const km = haversine(a.location, b.location);
    const location = a.location && b.location ? Math.max(0, 1 - km / 8) : 0;
    const days = Math.abs(new Date(a.createdAt) - new Date(b.createdAt)) / 86400000;
    const timeBonus = Math.min(1, .45 + days / 220);
    const evidence = Math.min(1, keyword * .52 + location * .24 + reaction * .12 + concept * .12);
    const semantic = Math.min(1, concept * .85 + keyword * .15);
    const obviousness = Math.min(1, keyword * .85 + location * .15);
    const serendipity = Math.min(1, semantic * (1 - obviousness * .72) * timeBonus * 1.45);
    return { a, b, keyword, commonKeywords, bridge, location, km, reaction, days, evidence, serendipity };
  }

  function connections() {
    const all = [];
    for (let i = 0; i < memos.length; i++) {
      for (let j = i + 1; j < memos.length; j++) all.push(scorePair(memos[i], memos[j]));
    }
    return all;
  }

  function isBuiltInSample(memo) {
    return BUILT_IN_SAMPLE_TEXTS.has(clean(memo && memo.text));
  }

  async function removeBuiltInSamples() {
    const existing = await getAllRaw();
    const now = new Date().toISOString();
    const samples = existing.filter(memo => isBuiltInSample(memo) && !memo.deletedAt);
    await Promise.all(samples.map(memo => putMemo({ ...memo, deletedAt: now, updatedAt: now })));
    localStorage.removeItem("trace-demo-seeded");
  }

  async function reload() {
    const all = await getAllRaw();
    memos = all.filter(memo => !memo.deletedAt).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    renderAll();
  }

  function setView(id) {
    document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === id));
    document.querySelectorAll(".bottom-nav a").forEach(link => link.classList.toggle("active", link.dataset.view === id));
    if (id === "map") renderMap();
    if (id === "discover") renderDiscover();
    if (id === "archive") renderArchive();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function reasonFor(c, hypothesis = false) {
    const bridge = c.bridge[0];
    if (hypothesis && bridge) return { title: `「${bridge}」という橋`, detail: `表面の言葉は離れていますが、どちらにも${bridge}への反応が見えます。${Math.round(c.days)}日離れたメモです。` };
    if (c.commonKeywords.length) return { title: `${c.commonKeywords.slice(0, 2).join(" / ")} が共通`, detail: c.location > .5 ? `共通する言葉に加え、場所も約${c.km.toFixed(1)}km以内です。` : "同じ言葉と文脈が繰り返し現れています。" };
    if (c.location > .5) return { title: "近い場所で残したメモ", detail: `約${c.km.toFixed(1)}km以内で記録されています。` };
    return { title: bridge ? `${bridge} が共通` : "弱いつながり", detail: "メモが増えると、よりはっきりした根拠を表示できます。" };
  }

  function renderDiscover() {
    const all = connections();
    const evidence = [...all].filter(c => c.evidence >= .13).sort((a, b) => b.evidence - a.evidence)[0];
    const surprise = [...all].filter(c => c.serendipity >= .19 && c !== evidence && c.bridge.length).sort((a, b) => b.serendipity - a.serendipity)[0];
    if (!evidence && !surprise) {
      els.discover.innerHTML = document.querySelector("#emptyTemplate").innerHTML;
      return;
    }
    els.discover.innerHTML = [
      evidence && connectionCard(evidence, false),
      surprise && connectionCard(surprise, true)
    ].filter(Boolean).join("");
  }

  function connectionCard(c, hypothesis) {
    const reason = reasonFor(c, hypothesis);
    const score = Math.round((hypothesis ? c.serendipity : c.evidence) * 100);
    return `<article class="connection-card ${hypothesis ? "hypothesis" : ""}">
      <div class="card-label"><span>${hypothesis ? "✦ 意外なつながり" : "✓ 確実なつながり"}</span><span class="score">${hypothesis ? "SERENDIPITY" : "EVIDENCE"} ${score}</span></div>
      <div class="memo-pair">
        <div class="pair-item"><time>${relativeDate(c.a.createdAt)}</time><p>${escapeHtml(c.a.text)}</p></div>
        <div class="pair-link" aria-hidden="true"></div>
        <div class="pair-item"><time>${relativeDate(c.b.createdAt)}</time><p>${escapeHtml(c.b.text)}</p></div>
      </div>
      <div class="connection-reason"><strong>${escapeHtml(reason.title)}</strong><p>${escapeHtml(reason.detail)}</p></div>
    </article>`;
  }

  function renderArchive() {
    const q = clean(els.search.value).toLowerCase();
    const filtered = memos.filter(memo => !q || `${memo.text} ${(memo.keywords || []).join(" ")} ${(memo.reactions || []).join(" ")}`.toLowerCase().includes(q));
    if (!filtered.length) {
      els.list.innerHTML = `<div class="empty-state"><p>${q ? "見つかりませんでした。" : "まだメモがありません。"}</p><span>${q ? "別の言葉で検索してみてください。" : "最初のひとつを残してみてください。"}</span></div>`;
      return;
    }
    els.list.innerHTML = filtered.map(memo => `<article class="memo-row">
      <div class="memo-meta">${formatDate(memo.createdAt)}<br>${memo.location ? "位置情報あり" : "この端末"}<br><span class="analysis-state ${escapeHtml(memo.aiStatus || "pending")}">${escapeHtml(analysisLabel(memo))}</span></div>
      <div class="memo-copy"><p>${escapeHtml(memo.text)}</p>
        <div class="tags">${(memo.keywords || []).map(x => `<span class="tag">${escapeHtml(x)}</span>`).join("")}${(memo.reactions || []).map(x => `<span class="tag reaction">${escapeHtml(x)}</span>`).join("")}</div>
        ${memo.photo ? `<img class="memo-photo" src="${memo.photo}" alt="メモに添付した写真">` : ""}
      </div>
      <div class="row-actions">${memo.aiStatus === "failed" ? `<button class="text-button" data-analyze="${escapeHtml(memo.id)}">AI再試行</button>` : ""}<button class="text-button" data-edit="${escapeHtml(memo.id)}">編集</button><button class="text-button danger" data-delete="${escapeHtml(memo.id)}">削除</button></div>
    </article>`).join("");
  }

  function seededPoint(id, radius = 1) {
    let hash = 2166136261;
    for (const char of String(id)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const first = ((hash >>> 0) % 10007) / 10007;
    hash = Math.imul(hash ^ 0x9e3779b9, 16777619);
    const second = ((hash >>> 0) % 10009) / 10009;
    const y = first * 2 - 1;
    const theta = second * Math.PI * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    return {
      x: Math.cos(theta) * ring * radius,
      y: y * radius,
      z: Math.sin(theta) * ring * radius
    };
  }

  function readLayoutPositions() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LAYOUT_STORAGE) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  }

  function saveLayoutPositions(nodes) {
    const saved = {};
    nodes.forEach(node => { saved[node.id] = { x: node.x, y: node.y, z: node.z }; });
    try { localStorage.setItem(LAYOUT_STORAGE, JSON.stringify(saved)); } catch { /* layout can be recalculated */ }
  }

  function isSavedPoint(point) {
    return point && [point.x, point.y, point.z].every(Number.isFinite);
  }

  function applyLogicalLayout(nodes, visibleEdges, forceSignature) {
    if (!nodes.length) return;
    const saved = readLayoutPositions();
    const savedIds = new Set(nodes.filter(node => isSavedPoint(saved[node.id])).map(node => node.id));
    nodes.forEach(node => Object.assign(node, savedIds.has(node.id) ? saved[node.id] : seededPoint(node.id, node.type === "memo" ? 1.2 : .8), { vx: 0, vy: 0, vz: 0 }));
    const byId = new Map(nodes.map(node => [node.id, node]));

    // New tags start near the memos that contain them. New memos start near their
    // strongest semantic neighbour. Existing coordinates remain the anchor.
    nodes.filter(node => !savedIds.has(node.id)).forEach(node => {
      const linkedIds = node.type === "keyword"
        ? visibleEdges.filter(edge => edge.from === node.id || edge.to === node.id).map(edge => edge.from === node.id ? edge.to : edge.from)
        : semanticLinks.filter(link => link.source === node.id || link.target === node.id).sort((a, b) => b.score - a.score).slice(0, 2).map(link => link.source === node.id ? link.target : link.source);
      const anchors = linkedIds.map(id => byId.get(id)).filter(Boolean).filter(anchor => savedIds.has(anchor.id));
      if (anchors.length) {
        const jitter = seededPoint(`${node.id}-jitter`, .18);
        node.x = anchors.reduce((sum, anchor) => sum + anchor.x, 0) / anchors.length + jitter.x;
        node.y = anchors.reduce((sum, anchor) => sum + anchor.y, 0) / anchors.length + jitter.y;
        node.z = anchors.reduce((sum, anchor) => sum + anchor.z, 0) / anchors.length + jitter.z;
      }
    });

    const attractions = [];
    visibleEdges.forEach(edge => {
      const a = byId.get(edge.from), b = byId.get(edge.to);
      if (a && b && a.type !== b.type) attractions.push({ a, b, target: .52, strength: .052 });
    });
    semanticLinks.forEach(link => {
      const a = byId.get(link.source), b = byId.get(link.target);
      if (a && b) attractions.push({ a, b, target: 1.22 - link.score * .82, strength: .026 + link.score * .062 });
    });

    const unchanged = forceSignature === lastForceSignature;
    const firstSemanticLayout = semanticState === "ready" && savedIds.size === 0;
    const iterations = unchanged ? 0 : (firstSemanticLayout ? 260 : 180);
    for (let step = 0; step < iterations; step++) {
      const forces = new Map(nodes.map(node => [node.id, { x: 0, y: 0, z: 0 }]));
      for (let left = 0; left < nodes.length; left++) {
        for (let right = left + 1; right < nodes.length; right++) {
          const a = nodes[left], b = nodes[right];
          let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          let distance = Math.hypot(dx, dy, dz);
          if (distance < .025) {
            const nudge = seededPoint(`${a.id}-${b.id}`, .025);
            dx = nudge.x; dy = nudge.y; dz = nudge.z; distance = .025;
          }
          const repulsion = .0105 / (distance * distance + .035);
          const fx = dx / distance * repulsion, fy = dy / distance * repulsion, fz = dz / distance * repulsion;
          forces.get(a.id).x -= fx; forces.get(a.id).y -= fy; forces.get(a.id).z -= fz;
          forces.get(b.id).x += fx; forces.get(b.id).y += fy; forces.get(b.id).z += fz;
        }
      }
      attractions.forEach(({ a, b, target, strength }) => {
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const distance = Math.max(.025, Math.hypot(dx, dy, dz));
        const pull = (distance - target) * strength;
        const fx = dx / distance * pull, fy = dy / distance * pull, fz = dz / distance * pull;
        forces.get(a.id).x += fx; forces.get(a.id).y += fy; forces.get(a.id).z += fz;
        forces.get(b.id).x -= fx; forces.get(b.id).y -= fy; forces.get(b.id).z -= fz;
      });
      nodes.forEach(node => {
        const force = forces.get(node.id);
        const mobility = savedIds.has(node.id) ? .34 : 1;
        force.x -= node.x * .0045; force.y -= node.y * .0045; force.z -= node.z * .0045;
        node.vx = (node.vx + force.x * mobility) * .81;
        node.vy = (node.vy + force.y * mobility) * .81;
        node.vz = (node.vz + force.z * mobility) * .81;
        node.x += node.vx; node.y += node.vy; node.z += node.vz;
        const radius = Math.hypot(node.x, node.y, node.z);
        if (radius > 1.8) {
          node.x *= 1.8 / radius; node.y *= 1.8 / radius; node.z *= 1.8 / radius;
        }
      });
    }
    nodes.forEach(node => { delete node.vx; delete node.vy; delete node.vz; });
    if (semanticState === "ready" || semanticState === "fallback") saveLayoutPositions(nodes);
    lastForceSignature = forceSignature;
  }

  function layoutInputSignature(shownMemos) {
    return shownMemos.map(memo => JSON.stringify([
      memo.id,
      clean(memo.text),
      memo.keywords || [],
      memo.reactions || [],
      (memo.aiTags && memo.aiTags.concept_tags) || [],
      (memo.aiTags && memo.aiTags.broad_tags) || []
    ])).join("|");
  }

  function sanitizeCloudMap(value) {
    if (!value || value.version !== 1 || typeof value.signature !== "string" || value.signature.length > 500000) return null;
    if (!Array.isArray(value.links) || value.links.length > 300 || !value.positions || typeof value.positions !== "object" || Array.isArray(value.positions)) return null;
    const links = [];
    for (const link of value.links) {
      if (!link || typeof link.source !== "string" || typeof link.target !== "string" || link.source.length > 120 || link.target.length > 120) return null;
      const score = Number(link.score);
      if (!Number.isFinite(score) || score < 0 || score > 1) return null;
      links.push({ source: link.source, target: link.target, score });
    }
    const positions = Object.create(null);
    const entries = Object.entries(value.positions);
    if (entries.length > 1000) return null;
    for (const [id, point] of entries) {
      if (!id || id.length > 180 || !point || ![point.x, point.y, point.z].every(number => Number.isFinite(number) && Math.abs(number) <= 1000)) return null;
      positions[id] = { x: Number(point.x), y: Number(point.y), z: Number(point.z) };
    }
    return { version: 1, signature: value.signature, links, positions };
  }

  function readCloudMap(signature) {
    try {
      const map = sanitizeCloudMap(JSON.parse(localStorage.getItem(CLOUD_MAP_STORAGE) || "null"));
      return map && map.signature === signature ? map : null;
    } catch { return null; }
  }

  function installCloudMap(value) {
    const map = sanitizeCloudMap(value);
    const signature = layoutInputSignature(memos.slice(0, 18));
    if (!map || map.signature !== signature) return false;
    semanticLinks = map.links;
    semanticSignature = signature;
    localStorage.setItem(CLOUD_MAP_STORAGE, JSON.stringify(map));
    localStorage.setItem(LAYOUT_STORAGE, JSON.stringify(map.positions));
    setLayoutState("ready", "意味配置：PC分析を同期");
    lastForceSignature = `${signature}:ready:${semanticLinks.map(link => `${link.source}-${link.target}-${link.score}`).join("|")}`;
    build3DGraph();
    if (location.hash === "#map") draw3DGraph();
    return true;
  }

  function setLayoutState(state, label) {
    semanticState = state;
    if (els.layoutState) {
      els.layoutState.className = `layout-state ${state}`;
      els.layoutState.textContent = label;
    }
  }

  async function requestSemanticLinks() {
    const shownMemos = memos.slice(0, 18);
    const signature = layoutInputSignature(shownMemos);
    if (shownMemos.length < 2) {
      semanticLinks = [];
      semanticSignature = signature;
      setLayoutState("ready", "意味配置：準備済み");
      return;
    }
    if (!serverConnected) {
      const synced = readCloudMap(signature);
      if (synced) {
        installCloudMap(synced);
        return;
      }
      semanticLinks = [];
      semanticSignature = signature;
      setLayoutState("fallback", "意味配置：端末内タグのみ");
      return;
    }
    if (signature === semanticSignature && semanticState === "ready") return;
    const token = ++layoutRequestToken;
    setLayoutState("loading", "意味配置：計算中…");
    try {
      const response = await fetch("/api/semantic-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memos: shownMemos.map(memo => ({
          id: memo.id,
          text: memo.text,
          keywords: memo.keywords || [],
          reactions: memo.reactions || [],
          aiTags: memo.aiTags || {}
        })) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !Array.isArray(data.links)) throw new Error(data.error || "意味配置を計算できませんでした。");
      if (token !== layoutRequestToken || signature !== layoutInputSignature(memos.slice(0, 18))) return;
      semanticLinks = data.links;
      semanticSignature = signature;
      setLayoutState("ready", `意味配置：${data.model}`);
      build3DGraph();
      if (location.hash === "#map") draw3DGraph();
    } catch {
      if (token !== layoutRequestToken) return;
      semanticLinks = [];
      semanticSignature = signature;
      setLayoutState("fallback", "意味配置：タグのみ");
      build3DGraph();
      if (location.hash === "#map") draw3DGraph();
    }
  }

  function build3DGraph() {
    const counts = new Map();
    memos.forEach(memo => (memo.keywords || []).forEach(keyword => counts.set(keyword, (counts.get(keyword) || 0) + 1)));
    const keywordNames = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([name]) => name);
    const shownMemos = memos.slice(0, 18);
    const nodes = [];
    keywordNames.forEach(name => nodes.push({ id: `k-${name}`, type: "keyword", label: name }));
    shownMemos.forEach(memo => nodes.push({ id: memo.id, type: "memo", label: truncate(memo.text, 11), memo }));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const edges = [];
    shownMemos.forEach(memo => (memo.keywords || []).filter(keyword => keywordNames.includes(keyword)).slice(0, 5).forEach(keyword => {
      if (byId.has(memo.id) && byId.has(`k-${keyword}`)) edges.push({ from: memo.id, to: `k-${keyword}`, type: "evidence" });
    }));
    const drawnPairs = new Set();
    const pairKey = (a, b) => [a, b].sort().join("|");
    const memoLinks = semanticLinks
      .filter(link => link.score >= .34 && byId.has(link.source) && byId.has(link.target))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    memoLinks.forEach(link => {
      const key = pairKey(link.source, link.target);
      drawnPairs.add(key);
      edges.push({ from: link.source, to: link.target, type: "semantic", score: link.score });
    });
    connections()
      .filter(c => c.serendipity >= .19 && c.bridge.length && byId.has(c.a.id) && byId.has(c.b.id))
      .sort((a, b) => b.serendipity - a.serendipity)
      .filter(c => !drawnPairs.has(pairKey(c.a.id, c.b.id)))
      .slice(0, 5)
      .forEach(c => edges.push({ from: c.a.id, to: c.b.id, type: "hypothesis", score: c.serendipity }));
    const degree = new Map(nodes.map(node => [node.id, 0]));
    edges.forEach(edge => {
      degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    });
    nodes.forEach(node => { node.degree = degree.get(node.id) || 0; });
    const forceSignature = `${layoutInputSignature(shownMemos)}:${semanticState}:${semanticLinks.map(link => `${link.source}-${link.target}-${link.score}`).join("|")}`;
    applyLogicalLayout(nodes, edges, forceSignature);
    graphModel = { nodes, edges, projected: [], byId };
  }

  function rotate3D(node) {
    const cy = Math.cos(graphView.yaw), sy = Math.sin(graphView.yaw);
    const cp = Math.cos(graphView.pitch), sp = Math.sin(graphView.pitch);
    const x1 = node.x * cy - node.z * sy;
    const z1 = node.x * sy + node.z * cy;
    return { x: x1, y: node.y * cp - z1 * sp, z: node.y * sp + z1 * cp };
  }

  function draw3DGraph() {
    const canvas = els.graph;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(300, rect.width);
    const height = Math.max(360, rect.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const glow = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * .62);
    glow.addColorStop(0, "#1c2924");
    glow.addColorStop(1, "#0d1210");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    if (!graphModel.nodes.length) {
      ctx.fillStyle = "#dce3df";
      ctx.textAlign = "center";
      ctx.font = '18px "Yu Mincho", serif';
      ctx.fillText("メモを残すと、ここに3Dマップが育ちます。", width / 2, height / 2);
      graphModel.projected = [];
      return;
    }

    const base = Math.min(width, height) * .265 * graphView.zoom;
    const camera = 4.2;
    const projected = graphModel.nodes.map(node => {
      const rotated = rotate3D(node);
      const perspective = camera / (camera - rotated.z);
      return { ...node, sx: width / 2 + rotated.x * base * perspective, sy: height / 2 + rotated.y * base * perspective, depth: rotated.z, perspective };
    });
    const projectedById = new Map(projected.map(node => [node.id, node]));

    const focusId = graphView.hover || graphView.selected;
    const focusNodes = new Set(focusId ? [focusId, ...graphModel.edges.filter(edge => edge.from === focusId || edge.to === focusId).map(edge => edge.from === focusId ? edge.to : edge.from)] : []);
    graphModel.edges
      .map(edge => ({ ...edge, a: projectedById.get(edge.from), b: projectedById.get(edge.to) }))
      .filter(edge => edge.a && edge.b)
      .sort((a, b) => (a.a.depth + a.b.depth) - (b.a.depth + b.b.depth))
      .forEach(edge => {
        const depth = (edge.a.depth + edge.b.depth) / 2;
        const focused = !focusId || edge.from === focusId || edge.to === focusId;
        const baseAlpha = edge.type === "semantic"
          ? Math.min(.96, .52 + (edge.score || 0) * .42)
          : edge.type === "hypothesis" ? .78 : .4;
        ctx.beginPath();
        ctx.moveTo(edge.a.sx, edge.a.sy);
        ctx.lineTo(edge.b.sx, edge.b.sy);
        ctx.setLineDash(edge.type === "hypothesis" ? [4, 7] : []);
        const alpha = baseAlpha * Math.max(.72, Math.min(1, .86 + depth * .1)) * (focused ? 1 : .38);
        const color = edge.type === "hypothesis" ? "226,75,48" : "116,186,168";
        ctx.strokeStyle = `rgba(${color},${alpha})`;
        ctx.lineWidth = edge.type === "semantic" ? 1.7 + (edge.score || 0) * 2.5 : edge.type === "hypothesis" ? 1.6 : 1.15;
        ctx.stroke();
      });
    ctx.setLineDash([]);

    projected.sort((a, b) => a.depth - b.depth).forEach(node => {
      const hovered = graphView.hover === node.id;
      const selected = graphView.selected === node.id;
      const related = !focusId || focusNodes.has(node.id);
      const radius = Math.max(4.5, (node.type === "memo" ? 7.5 + Math.min(5, node.degree * .8) : 5.6 + Math.min(2, node.degree * .3)) * node.perspective * ((hovered || selected) ? 1.3 : 1));
      const alpha = Math.max(.22, Math.min(1, .72 + node.depth * .13)) * (related ? 1 : .15);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowBlur = hovered || selected ? 22 : node.type === "memo" && node.degree >= 3 ? 9 : 0;
      ctx.shadowColor = node.type === "memo" ? "rgba(226,75,48,.72)" : "rgba(94,180,158,.58)";
      ctx.beginPath();
      if (node.type === "memo") {
        ctx.arc(node.sx, node.sy, radius, 0, Math.PI * 2);
      } else {
        ctx.moveTo(node.sx, node.sy - radius);
        ctx.lineTo(node.sx + radius, node.sy);
        ctx.lineTo(node.sx, node.sy + radius);
        ctx.lineTo(node.sx - radius, node.sy);
        ctx.closePath();
      }
      ctx.fillStyle = node.type === "memo" ? (selected || hovered ? "#ff805f" : "#e24b30") : (selected || hovered ? "#c3f1e4" : "#74baa8");
      ctx.fill();
      if (selected || hovered) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(255,255,255,.92)";
        ctx.stroke();
      }
      ctx.restore();

      const showLabel = selected || hovered || (related && ((!focusId && (node.depth > .3 || node.degree >= 3)) || (focusId && focusNodes.has(node.id))));
      if (showLabel) {
        ctx.font = `${selected || hovered ? 600 : 400} ${node.type === "memo" ? 10 : 11}px "Yu Gothic UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(13,18,16,.88)";
        ctx.lineJoin = "round";
        ctx.strokeText(node.label, node.sx, node.sy + radius + 6);
        ctx.fillStyle = "#edf2ef";
        ctx.fillText(node.label, node.sx, node.sy + radius + 6);
      }
      node.hitRadius = Math.max(14, radius + 5);
    });
    graphModel.projected = projected;
  }

  function nodeAt(clientX, clientY) {
    const rect = els.graph.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    return [...graphModel.projected].sort((a, b) => b.depth - a.depth).find(node => Math.hypot(node.sx - x, node.sy - y) <= node.hitRadius) || null;
  }

  function bindGraphEvents() {
    if (graphEventsBound) return;
    graphEventsBound = true;
    els.graph.addEventListener("pointerdown", event => {
      graphView.dragging = true;
      graphView.moved = false;
      graphView.lastX = event.clientX;
      graphView.lastY = event.clientY;
      els.graph.setPointerCapture(event.pointerId);
    });
    els.graph.addEventListener("pointermove", event => {
      if (graphView.dragging) {
        const dx = event.clientX - graphView.lastX, dy = event.clientY - graphView.lastY;
        graphView.yaw += dx * .008;
        graphView.pitch = Math.max(-1.25, Math.min(1.25, graphView.pitch + dy * .006));
        graphView.lastX = event.clientX;
        graphView.lastY = event.clientY;
        graphView.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
      } else {
        const hit = nodeAt(event.clientX, event.clientY);
        graphView.hover = hit && hit.id;
        els.graph.style.cursor = hit ? "pointer" : "grab";
      }
    });
    els.graph.addEventListener("pointerup", event => {
      const hit = nodeAt(event.clientX, event.clientY);
      if (!graphView.moved) {
        graphView.selected = hit?.id || null;
        if (hit) showNodeDetail(hit);
        else els.mapDetail.textContent = memos.length ? "近いほど、意味・概念・反応が似ています。選択で根拠を表示。" : "メモが増えると3Dマップになります。";
      }
      graphView.dragging = false;
      els.graph.releasePointerCapture(event.pointerId);
    });
    els.graph.addEventListener("pointercancel", () => { graphView.dragging = false; });
    els.graph.addEventListener("pointerleave", () => { if (!graphView.dragging) graphView.hover = null; });
    els.graph.addEventListener("wheel", event => {
      event.preventDefault();
      graphView.zoom = Math.max(.62, Math.min(1.72, graphView.zoom * (event.deltaY > 0 ? .92 : 1.08)));
    }, { passive: false });
    els.graph.addEventListener("keydown", event => {
      if (event.key === "ArrowLeft") graphView.yaw -= .12;
      else if (event.key === "ArrowRight") graphView.yaw += .12;
      else if (event.key === "ArrowUp") graphView.pitch -= .1;
      else if (event.key === "ArrowDown") graphView.pitch += .1;
      else if (event.key === "+" || event.key === "=") graphView.zoom = Math.min(1.72, graphView.zoom * 1.08);
      else if (event.key === "-") graphView.zoom = Math.max(.62, graphView.zoom * .92);
      else return;
      event.preventDefault();
    });
    document.querySelector("#resetGraph").addEventListener("click", () => {
      Object.assign(graphView, { yaw: -.55, pitch: .28, zoom: 1, hover: null, selected: null });
      draw3DGraph();
    });
    window.addEventListener("resize", () => { if (document.querySelector("#map").classList.contains("active")) draw3DGraph(); });
  }

  function animate3DGraph() {
    if (!document.querySelector("#map").classList.contains("active")) {
      graphFrame = null;
      return;
    }
    if (!graphView.dragging && !matchMedia("(prefers-reduced-motion: reduce)").matches) graphView.yaw += .00115;
    draw3DGraph();
    graphFrame = requestAnimationFrame(animate3DGraph);
  }

  function renderMap() {
    build3DGraph();
    bindGraphEvents();
    if (graphFrame) cancelAnimationFrame(graphFrame);
    graphFrame = requestAnimationFrame(animate3DGraph);
    els.mapDetail.textContent = memos.length ? "近いほど、意味・概念・反応が似ています。選択で根拠を表示。" : "メモが増えると3Dマップになります。";
    requestSemanticLinks();
  }

  function showNodeDetail(node) {
    if (node.type === "memo") {
      const related = connections().filter(c => c.a.id === node.id || c.b.id === node.id).sort((a, b) => Math.max(b.evidence, b.serendipity) - Math.max(a.evidence, a.serendipity))[0];
      const semantic = semanticLinks.filter(link => link.source === node.id || link.target === node.id).sort((a, b) => b.score - a.score)[0];
      const semanticMemo = semantic && memos.find(memo => memo.id === (semantic.source === node.id ? semantic.target : semantic.source));
      els.mapDetail.innerHTML = `<strong>${escapeHtml(node.memo.text)}</strong>${semanticMemo ? `<br>意味が最も近いメモ：${escapeHtml(truncate(semanticMemo.text, 30))}（${Math.round(semantic.score * 100)}%）` : ""}${related ? `<br>最も強い接続：${escapeHtml(reasonFor(related, related.serendipity > related.evidence).title)}` : ""}`;
    } else {
      const linked = memos.filter(m => (m.keywords || []).includes(node.label));
      els.mapDetail.innerHTML = `<strong>#${escapeHtml(node.label)}</strong><br>${linked.length}件のメモに現れています。`;
    }
  }

  function renderAll() {
    renderDiscover();
    renderArchive();
    if (location.hash === "#map") renderMap();
  }

  function getLocation() {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 4500, maximumAge: 60000 }
      );
    });
  }

  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 1280 / img.width);
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", .78));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function trySync() {
    try {
      const raw = await getAllRaw();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const response = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memos: raw }), signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error("sync unavailable");
      const data = await response.json();
      const cleanupTime = new Date().toISOString();
      const receivedLiveSample = (data.memos || []).some(memo => isBuiltInSample(memo) && !memo.deletedAt);
      const cleaned = (data.memos || []).map(memo => isBuiltInSample(memo) ? { ...memo, deletedAt: memo.deletedAt || cleanupTime, updatedAt: memo.deletedAt ? memo.updatedAt : cleanupTime } : memo);
      await Promise.all(cleaned.map(putMemo));
      if (receivedLiveSample) {
        const cleanedRaw = await getAllRaw();
        await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memos: cleanedRaw }) });
      }
      els.syncState.classList.remove("offline");
      els.syncState.querySelector("span:last-child").textContent = "PCと同期済み";
      serverConnected = true;
      await reload();
      return true;
    } catch {
      serverConnected = false;
      els.syncState.classList.add("offline");
      els.syncState.querySelector("span:last-child").textContent = "スマホに保存済み";
      return false;
    }
  }

  async function syncAndAnalyze() {
    if (await trySync()) await processPendingAnalyses();
  }

  function cloudMapSnapshot() {
    return sanitizeCloudMap({
      version: 1,
      signature: layoutInputSignature(memos.slice(0, 18)),
      links: semanticLinks,
      positions: readLayoutPositions()
    });
  }

  window.TraceApp = {
    ready: appReady,
    async exportPackage() {
      const ready = await appReady;
      if (!ready || !window.TraceTransfer) throw new Error("メモの保存領域を開けませんでした。");
      return window.TraceTransfer.createPackage(await getAllRaw(), location.origin);
    },
    async exportCloudBundle() {
      const ready = await appReady;
      if (!ready || !window.TraceTransfer) throw new Error("メモの保存領域を開けませんでした。");
      await syncAndAnalyze();
      await requestSemanticLinks();
      build3DGraph();
      const packageText = window.TraceTransfer.createPackage(await getAllRaw(), location.origin);
      const packageData = JSON.parse(packageText);
      const map = cloudMapSnapshot();
      if (!map) throw new Error("3Dマップを安全に書き出せませんでした。");
      const revision = `crc32:${window.TraceTransfer.crc32(JSON.stringify({ memos: packageData.memos, map }))}`;
      return JSON.stringify({ format: "trace-interest-graph-cloud", version: 1, revision, packageText, map });
    },
    async importMemos(incoming) {
      const ready = await appReady;
      if (!ready || !window.TraceTransfer) throw new Error("メモの保存領域を開けませんでした。");
      const plan = window.TraceTransfer.planImport(await getAllRaw(), incoming, uid);
      for (const memo of plan.writes) await putMemo(memo);
      if (plan.writes.length) {
        await reload();
        syncAndAnalyze();
      }
      return { ...plan, writes: plan.writes.length };
    },
    async importCloudBundle(text) {
      const ready = await appReady;
      if (!ready || !window.TraceTransfer || typeof text !== "string" || text.length > 64 * 1024 * 1024) throw new Error("PCからの同期データを読み取れませんでした。");
      let bundle;
      try { bundle = JSON.parse(text); } catch { throw new Error("PCからの同期データを読み取れませんでした。"); }
      if (!bundle || bundle.format !== "trace-interest-graph-cloud" || bundle.version !== 1 || typeof bundle.packageText !== "string") throw new Error("PCからの同期データ形式が不正です。");
      const parsed = window.TraceTransfer.parsePackage(bundle.packageText);
      if (parsed.ignored) throw new Error("安全に読み取れないメモがあるため、PCからの受信を中止しました。");
      const plan = window.TraceTransfer.planImport(await getAllRaw(), parsed.memos, uid, new Date().toISOString(), { mergeAnalysis: true });
      for (const memo of [...plan.writes, ...plan.updates]) await putMemo(memo);
      if (plan.writes.length || plan.updates.length) await reload();
      const mapInstalled = installCloudMap(bundle.map);
      return { ...plan, writes: plan.writes.length, updates: plan.updates.length, mapInstalled, revision: String(bundle.revision || "") };
    }
  };

  function transferFilename() {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
    return `trace-transfer-${stamp}.json`;
  }

  async function exportTransferFile() {
    if (!window.TraceTransfer) throw new Error("移行機能を読み込めませんでした。再読み込みしてください。");
    const raw = await getAllRaw();
    const liveCount = raw.filter(memo => !memo.deletedAt).length;
    if (!liveCount) throw new Error("書き出せるメモがまだありません。");
    const text = window.TraceTransfer.createPackage(raw, location.origin);
    const exportedCount = JSON.parse(text).memos.length;
    if (exportedCount !== liveCount) throw new Error("安全に書き出せないメモが含まれるため、処理を中止しました。");
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = transferFilename();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    els.transferMessage.textContent = `${exportedCount}件を書き出しました。このファイルにはメモと写真が含まれるため、安全に保管してください。`;
  }

  async function importTransferFile(file) {
    if (!window.TraceTransfer) throw new Error("移行機能を読み込めませんでした。再読み込みしてください。");
    if (!file || file.size > 64 * 1024 * 1024) throw new Error("ファイルが大きすぎるか、選択されていません。");
    const parsed = window.TraceTransfer.parsePackage(await file.text());
    if (parsed.ignored) throw new Error(`${parsed.ignored}件を安全に読み取れないため、取り込みを中止しました。`);
    const current = await getAllRaw();
    const plan = window.TraceTransfer.planImport(current, parsed.memos, uid);
    if (!plan.writes.length) {
      els.transferMessage.textContent = `新しいメモはありませんでした。重複${plan.duplicate}件はそのままです。`;
      return;
    }
    const summary = [
      `新規${plan.added}件`,
      `競合コピー${plan.conflictCopy}件`,
      `重複のため変更なし${plan.duplicate}件`
    ].join("／");
    const approved = confirm(`${summary}\n\n既存メモは削除・上書きしません。この内容で取り込みますか？`);
    if (!approved) {
      els.transferMessage.textContent = "取り込みをキャンセルしました。データは変更していません。";
      return;
    }
    for (const memo of plan.writes) await putMemo(memo);
    await reload();
    els.transferMessage.textContent = `${plan.writes.length}件を安全に取り込みました。既存メモは変更していません。`;
    syncAndAnalyze();
  }

  els.text.addEventListener("input", () => els.charCount.textContent = `${els.text.value.length} / 500`);
  els.photo.addEventListener("change", async () => {
    const file = els.photo.files[0];
    if (!file) return;
    els.message.textContent = "写真を準備しています…";
    try {
      photoData = await readPhoto(file);
      els.photoPreview.style.backgroundImage = `url(${photoData})`;
      els.photoPreview.hidden = false;
      els.message.textContent = "写真を追加しました。";
    } catch { els.message.textContent = "写真は追加できませんでした。メモはそのまま保存できます。"; }
  });

  els.exportMemos.addEventListener("click", async () => {
    els.transferMessage.textContent = "移行ファイルを準備しています…";
    try { await exportTransferFile(); }
    catch (error) { els.transferMessage.textContent = error.message || "書き出しに失敗しました。"; }
  });

  els.importMemos.addEventListener("change", async () => {
    els.transferMessage.textContent = "移行ファイルを確認しています…";
    try { await importTransferFile(els.importMemos.files[0]); }
    catch (error) { els.transferMessage.textContent = error.message || "取り込みに失敗しました。"; }
    finally { els.importMemos.value = ""; }
  });

  els.form.addEventListener("submit", async event => {
    event.preventDefault();
    const text = clean(els.text.value);
    if (!text) return;
    const now = new Date().toISOString();
    const memo = { id: uid(), text, keywords: extractKeywords(text), reactions: extractReactions(text), aiStatus: "pending", aiTags: null, photo: photoData, location: null, createdAt: now, updatedAt: now, deletedAt: null };
    await putMemo(memo);
    els.text.value = "";
    els.photo.value = "";
    photoData = null;
    els.photoPreview.hidden = true;
    els.charCount.textContent = "0 / 500";
    els.message.textContent = "保存しました。";
    els.text.focus({ preventScroll: true });
    await reload();
    if (els.withLocation.checked) {
      getLocation().then(async locationData => {
        if (!locationData) return;
        const current = (await getAllRaw()).find(x => x.id === memo.id);
        if (!current || current.deletedAt) return;
        current.location = locationData;
        current.updatedAt = new Date().toISOString();
        await putMemo(current);
        await reload();
        trySync();
      });
    }
    if (await trySync()) {
      els.message.textContent = "保存・同期しました。";
      analyzeMemo(memo);
    } else {
      els.message.textContent = "保存しました。AI整理はPC接続時に行います。";
    }
  });

  els.text.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });

  els.search.addEventListener("input", renderArchive);
  els.list.addEventListener("click", async event => {
    const editId = event.target.dataset.edit;
    const deleteId = event.target.dataset.delete;
    const analyzeId = event.target.dataset.analyze;
    if (analyzeId) {
      const memo = memos.find(x => x.id === analyzeId);
      if (memo) {
        memo.aiStatus = "pending";
        await putMemo(memo);
        analyzeMemo(memo);
      }
      return;
    }
    if (editId) {
      const memo = memos.find(x => x.id === editId);
      if (!memo) return;
      editingId = editId;
      els.editText.value = memo.text;
      els.editKeywords.value = (memo.keywords || []).join("、");
      els.editDialog.showModal();
    }
    if (deleteId) {
      const memo = memos.find(x => x.id === deleteId);
      if (!memo || !confirm("このメモを削除しますか？ 関連する線もマップから消えます。")) return;
      memo.deletedAt = new Date().toISOString();
      memo.updatedAt = memo.deletedAt;
      await putMemo(memo);
      await reload();
      trySync();
    }
  });

  els.editForm.addEventListener("submit", async event => {
    event.preventDefault();
    const memo = memos.find(x => x.id === editingId);
    if (!memo) return;
    const previousText = memo.text;
    memo.text = clean(els.editText.value);
    memo.keywords = [...new Set(els.editKeywords.value.split(/[、,]/).map(clean).filter(Boolean))].slice(0, 10);
    memo.reactions = extractReactions(memo.text);
    if (memo.text !== previousText) {
      memo.aiStatus = "pending";
      memo.aiTags = null;
      memo.aiError = null;
    }
    memo.updatedAt = new Date().toISOString();
    await putMemo(memo);
    els.editDialog.close();
    await reload();
    trySync();
    if (memo.aiStatus === "pending") analyzeMemo(memo);
  });

  document.querySelectorAll(".bottom-nav a").forEach(link => link.addEventListener("click", () => setView(link.dataset.view)));
  window.addEventListener("hashchange", () => setView(location.hash.slice(1) || "capture"));
  window.addEventListener("online", syncAndAnalyze);

  (async () => {
    db = await openDb();
    await removeBuiltInSamples();
    await reload();
    setView(location.hash.slice(1) || "capture");
    resolveAppReady(true);
    await syncAndAnalyze();
    setInterval(syncAndAnalyze, 30000);
  })().catch(error => {
    console.error(error);
    resolveAppReady(false);
    els.message.textContent = "保存領域を開けませんでした。ブラウザのプライベートモードを解除して再読み込みしてください。";
  });
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(() => {}));
  }
})();
