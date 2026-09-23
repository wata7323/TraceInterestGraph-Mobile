(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TraceTransfer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FORMAT = "trace-interest-graph-transfer";
  const VERSION = 1;
  const MAX_MEMOS = 5000;
  const MAX_PHOTO_LENGTH = 12 * 1024 * 1024;
  const TAG_KEYS = ["surface_tags", "canonical_tags", "concept_tags", "broad_tags", "reaction_tags"];

  function clean(value, limit) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, limit);
  }

  function validDate(value) {
    const text = String(value || "");
    return text && Number.isFinite(Date.parse(text)) ? text : null;
  }

  function cleanList(value, maxItems, maxLength) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(item => clean(item, maxLength)).filter(Boolean))].slice(0, maxItems);
  }

  function cleanAiTags(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const tags = {};
    TAG_KEYS.forEach(key => { tags[key] = cleanList(value[key], 6, 80); });
    return tags;
  }

  function cleanLocation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    const accuracy = Number(value.accuracy);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    return { latitude, longitude, accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null };
  }

  function sanitizeMemo(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.deletedAt) return null;
    const id = clean(value.id, 120);
    const text = clean(value.text, 500);
    const createdAt = validDate(value.createdAt);
    const updatedAt = validDate(value.updatedAt) || createdAt;
    if (!id || !text || !createdAt || !updatedAt) return null;
    const hasPhoto = value.photo !== null && value.photo !== undefined && value.photo !== "";
    const photoIsSafe = typeof value.photo === "string" && value.photo.length <= MAX_PHOTO_LENGTH && /^data:image\/(?:jpeg|png|webp);base64,/i.test(value.photo);
    if (hasPhoto && !photoIsSafe) return null;
    const location = cleanLocation(value.location);
    if (value.location !== null && value.location !== undefined && !location) return null;
    const photo = photoIsSafe ? value.photo : null;
    const aiStatus = ["pending", "processing", "completed", "failed"].includes(value.aiStatus) ? value.aiStatus : "pending";
    return {
      id,
      text,
      keywords: cleanList(value.keywords, 24, 80),
      reactions: cleanList(value.reactions, 12, 80),
      aiStatus: aiStatus === "processing" ? "pending" : aiStatus,
      aiTags: cleanAiTags(value.aiTags),
      aiModel: clean(value.aiModel, 120) || null,
      aiAnalyzedAt: validDate(value.aiAnalyzedAt),
      aiError: clean(value.aiError, 300) || null,
      photo,
      location,
      createdAt,
      updatedAt,
      deletedAt: null
    };
  }

  function crc32(text) {
    const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text) : Array.from(text).map(char => char.charCodeAt(0) & 255);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
  }

  function createPackage(memos, source) {
    const safeMemos = (Array.isArray(memos) ? memos : []).map(sanitizeMemo).filter(Boolean).slice(0, MAX_MEMOS);
    const payload = {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      source: clean(source, 240),
      memos: safeMemos
    };
    return JSON.stringify({ ...payload, checksum: `crc32:${crc32(JSON.stringify(payload))}` }, null, 2);
  }

  function parsePackage(text) {
    if (typeof text !== "string" || text.length > 64 * 1024 * 1024) throw new Error("移行ファイルが大きすぎます。");
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("Traceの移行ファイルとして読み取れません。"); }
    if (!parsed || parsed.format !== FORMAT || parsed.version !== VERSION || !Array.isArray(parsed.memos)) throw new Error("対応していない移行ファイルです。");
    if (parsed.memos.length > MAX_MEMOS) throw new Error("メモ件数が多すぎます。");
    const { checksum, ...payload } = parsed;
    if (checksum !== `crc32:${crc32(JSON.stringify(payload))}`) throw new Error("ファイルが途中で壊れたか、内容が変更されています。");
    const memos = parsed.memos.map(sanitizeMemo).filter(Boolean);
    return { memos, ignored: parsed.memos.length - memos.length, exportedAt: validDate(parsed.exportedAt), source: clean(parsed.source, 240) };
  }

  function contentFingerprint(memo) {
    return JSON.stringify({
      text: memo.text,
      photo: memo.photo,
      location: memo.location,
      createdAt: memo.createdAt
    });
  }

  function planImport(existing, incoming, makeId, now = new Date().toISOString()) {
    const current = new Map((Array.isArray(existing) ? existing : []).filter(item => item && typeof item.id === "string").map(item => [item.id, item]));
    const writes = [];
    let added = 0;
    let duplicate = 0;
    let conflictCopy = 0;
    for (const item of Array.isArray(incoming) ? incoming : []) {
      const memo = sanitizeMemo(item);
      if (!memo) continue;
      const old = current.get(memo.id);
      if (!old) {
        writes.push({ ...memo, importedAt: now });
        current.set(memo.id, memo);
        added += 1;
        continue;
      }
      const safeOld = sanitizeMemo(old);
      if (safeOld && contentFingerprint(safeOld) === contentFingerprint(memo)) {
        duplicate += 1;
        continue;
      }
      const originalId = memo.id;
      const copied = { ...memo, id: makeId(), importedAt: now, importedConflictOf: originalId, updatedAt: now };
      writes.push(copied);
      current.set(copied.id, copied);
      conflictCopy += 1;
    }
    return { writes, added, duplicate, conflictCopy };
  }

  return { FORMAT, VERSION, createPackage, parsePackage, planImport, sanitizeMemo, crc32 };
});
