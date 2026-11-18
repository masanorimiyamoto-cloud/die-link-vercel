// api/material-match.js
// 目の前の生地（カメラ撮影）と、Google Drive登録済みの参照画像をAIビジョンで照合する。
// action=search（2026-11-18）: 品番を指定せず、撮影した生地に似た見本を生地の台帳（TableFabric）から探し、
// その生地を使う品番を全部返す（「知る」の 🔎 生地から探す）。決まりは _fabric.js
import { callVisionJSON, resolveModel } from './_vision.js';
import { requireUser } from './_auth.js';
import { FABRIC_TABLE, FB, toFabric, planBatches, buildParts, mergeResults, lookupItems, itemRows } from './_fabric.js';
export const config = { runtime: 'edge' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ---------- 共通ユーティリティ（drive-find.js / drive-proxy.js と同方式） ---------- */
function bytesToBase64(bytes) {
  // 大きな画像でもスタックを溢れさせないようチャンク分割
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function utf8ToBase64Url(s) { return bytesToBase64Url(new TextEncoder().encode(s)); }
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(b64); const buf = new ArrayBuffer(raw.length); const v = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) v[i] = raw.charCodeAt(i);
  return buf;
}
async function getGoogleAccessToken() {
  const SA_JSON = process.env.GOOGLE_SA_JSON || '';
  if (!SA_JSON) throw new Error('GOOGLE_SA_JSON is missing');
  const svc = JSON.parse(SA_JSON);
  const header = utf8ToBase64Url('{"alg":"RS256","typ":"JWT"}');
  const now = Math.floor(Date.now() / 1000);
  const payload = utf8ToBase64Url(JSON.stringify({
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(svc.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
function normalizeWc(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const num = Number(t);
  if (Number.isFinite(num) && Math.floor(num) === num) return String(num);
  if (/\.0$/.test(t)) return t.replace(/\.0$/, '');
  return t;
}
function escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ---------- セキュリティ（drive-proxy.js と同方式） ---------- */
function parseCookies(req) {
  const h = req.headers.get('cookie') || ''; const o = {};
  h.split(';').forEach(kv => { const [k, ...vs] = kv.split('='); if (!k) return; o[k.trim()] = decodeURIComponent((vs.join('=') || '').trim()); });
  return o;
}
function sameOrigin(req) {
  const self = new URL(req.url).origin;
  const origin = req.headers.get('origin') || '';
  const referer = req.headers.get('referer') || '';
  // 前方一致だと https://自ドメイン.evil.com も通るので、オリジンを取り出して完全一致で比べる
  const same = (v) => { try { return new URL(v).origin === self; } catch { return false; } };
  return same(origin) || same(referer);
}

/* ---------- Drive参照画像の特定 ---------- */
async function findReferenceImage(token, book, wc) {
  const folderId = (process.env.GDRIVE_DIE_MASTER_ID || '').trim();
  if (!folderId) throw new Error('GDRIVE_DIE_MASTER_ID is missing');
  const base = `${book}-${wc}`.trim();
  // 画像のみ対象（PDF/図面の線画は生地照合に使えないため除外）
  const isZu = (n) => new RegExp(`^${escapeRegex(base)}-zu\\.(?:jpeg|jpg|png)$`, 'i').test(n || '');
  const isSi = (n) => new RegExp(`^${escapeRegex(base)}-si\\.(?:jpeg|jpg|png)$`, 'i').test(n || '');
  const isOld = (n) => new RegExp(`^${escapeRegex(base)}\\.(?:jpeg|jpg|png)$`, 'i').test(n || '');

  const q = [`'${folderId}' in parents`, 'trashed = false'].join(' and ');
  const listUrl = `https://www.googleapis.com/drive/v3/files?` + new URLSearchParams({
    q, pageSize: '1000', fields: 'files(id,name,mimeType)',
  });
  const r = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`drive list ${r.status}`);
  const all = (await r.json()).files || [];
  const cands = all.filter(f => isZu(f.name) || isSi(f.name) || isOld(f.name));
  if (!cands.length) return null;
  const pri = (n) => isZu(n) ? 1 : isSi(n) ? 2 : isOld(n) ? 3 : 9;
  cands.sort((a, b) => pri(a.name) - pri(b.name));
  return cands[0];
}

async function fetchImageAsBase64(token, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!r.ok) throw new Error(`drive media ${r.status}`);
  const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { mime, data: bytesToBase64(bytes) };
}

/* ---------- Claudeビジョン照合 ---------- */
const MATCH_PROMPT = `あなたは製造現場の生地（材料）照合アシスタントです。
1枚目は「登録済みの参照画像」、2枚目は「作業者が目の前の生地をスマホで撮影した画像」です。
2枚が同一の生地かどうかを、色・地の色味・織り/編みの目・柄・質感の観点で見比べて判定してください。

重要な前提:
- 撮影条件（照明・角度・距離・ホワイトバランス）の違いは許容し、生地そのものの違いに注目すること。
- これは「見た目の照合」であり、写真から素材組成までは断定できない。確信が持てない場合は uncertain とすること。
- 参照画像が生地写真でなく線画や図面に見える場合も uncertain とし、その旨を reason に書くこと。

回答は次のJSONオブジェクト「のみ」を出力すること（前後に文章やマークダウンを付けない）:
{"verdict":"match|mismatch|uncertain","confidence":0〜100の整数,"reason":"日本語30〜80字"}

verdict の意味:
- "match": 同じ生地と考えてよい
- "mismatch": 明らかに別の生地（色・柄・織りが違う）
- "uncertain": 判断材料が不足、または参照画像が生地写真でない`;

/* ---------- 生地から品番を探す（action=search） ---------- */
const AIRTABLE_PAT = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appwAnJP9OOZ3MVF5';

// Airtable の表を全ページ読む（欄はフィールドIDで返す）
async function airtableList(table, { filterByFormula = '', fields = [] } = {}) {
  if (!AIRTABLE_PAT) throw new Error('AIRTABLE_PAT is missing');
  const rows = []; let offset = '';
  do {
    const p = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    if (filterByFormula) p.set('filterByFormula', filterByFormula);
    fields.forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}?${p}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: 'no-store' });
    if (!r.ok) throw new Error(`airtable ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    rows.push(...(j.records || []));
    offset = j.offset || '';
  } while (offset);
  return rows;
}

async function fetchUrlAsBase64(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`見本写真 ${r.status}`);
  const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return { mime, data: bytesToBase64(new Uint8Array(await r.arrayBuffer())) };
}

async function fabricSearch(payload, cap) {
  const t0 = Date.now();
  const recs = await airtableList(FABRIC_TABLE, { filterByFormula: `{有効}`, fields: Object.values(FB) });
  const fabrics = recs.map(toFabric).filter(fb => fb.photos.length);
  if (!fabrics.length) return { ok: true, total: 0, candidates: [], quality: 'ok', reason: 'noSamples', ms: Date.now() - t0 };
  const groups = planBatches(fabrics);
  if (!groups) return { ok: false, error: `見本の生地が多すぎます（${fabrics.length}件）。前段の絞り込みが必要です`, total: fabrics.length };

  // 札は検索ごとに F1… を振り直す。AI が返した札はこの表でだけ生地に戻す
  const labels = new Map();
  groups.flat().forEach((fb, i) => { fb.label = 'F' + (i + 1); labels.set(fb.label, fb); });
  // 見本写真を先に全部読む（読めなかった写真は飛ばす。生地の写真が1枚も読めなければその生地は送らない）
  const urls = [...new Set(groups.flat().flatMap(fb => fb.photos.map(p => p.url)))];
  const imgs = new Map();
  await Promise.all(urls.map(u => fetchUrlAsBase64(u).then(v => imgs.set(u, v)).catch(() => {})));
  const sendable = groups.map(g => g.filter(fb => fb.photos.some(p => imgs.has(p.url)))).filter(g => g.length);
  if (!sendable.length) return { ok: false, error: '見本写真を読めませんでした。少し待ってからもう一度試してください', total: fabrics.length };

  const results = await Promise.all(sendable.map(g => callVisionJSON({ modelKey: payload.model, parts: buildParts(g, cap, imgs), maxTokens: 1024 })
    .then(value => ({ ok: true, value })).catch(e => ({ ok: false, error: String(e?.message || e) }))));
  const merged = mergeResults(results, labels);
  if (!merged.answered) return { ok: false, error: 'AIの照合に失敗しました: ' + (results.find(r => !r.ok)?.error || '').slice(0, 160), total: fabrics.length };

  const allItems = merged.candidates.flatMap(c => c.fb.items);
  const info = allItems.length ? await lookupItems(airtableList, allItems) : new Map();
  return {
    ok: true, total: fabrics.length, quality: merged.quality, advice: merged.advice,
    partial: merged.failed > 0, // 一部の組で AI が答えなかった（見落としがあり得る）
    model: resolveModel(payload.model).label, ms: Date.now() - t0,
    candidates: merged.candidates.slice(0, 5).map(c => ({
      id: c.fb.id, name: c.fb.name, material: c.fb.material, score: c.score, reason: c.reason,
      photo: c.fb.photos[0]?.url || '', items: itemRows(c.fb, info), bad: c.fb.bad,
    })),
  };
}

// 時間のかかる処理を、空白を流しながら待つ（Edge は最初の応答を25秒以内に返す必要がある）。
// JSON の前の空白は JSON.parse が読み飛ばすので、画面はふつうに r.json() で読める
function streamJson(work) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(ctrl) {
      const iv = setInterval(() => { try { ctrl.enqueue(enc.encode(' ')); } catch {} }, 5000);
      let body;
      try { body = await work(); } catch (e) { body = { ok: false, error: String(e?.message || e) }; }
      clearInterval(iv);
      ctrl.enqueue(enc.encode(JSON.stringify(body)));
      ctrl.close();
    },
  }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/* ---------- ハンドラ ---------- */
export default async function handler(req) {
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);

    const u = new URL(req.url);
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.hostname);
    if (!isLocal) {
      if (!sameOrigin(req)) return json({ ok: false, error: 'Origin/Referer mismatch' }, 403);
      const cookies = parseCookies(req);
      const cookie = cookies['xcsrf'] || '';
      const header = req.headers.get('x-csrf') || '';
      if (!cookie || !header || cookie !== header) return json({ ok: false, error: 'CSRF invalid' }, 403);
      // ログイン必須（2026-11-10）。xcsrf は誰にでも発行されるので、CSRF だけでは外から AI を呼べてしまう
      const auth = await requireUser(req);
      if (auth.deny) return auth.deny;
    }

    const payload = await req.json().catch(() => ({}));
    if (payload.action === 'search') {
      const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(payload.image || '');
      if (!m) return json({ ok: false, error: 'missing image' }, 400);
      return streamJson(() => fabricSearch(payload, { mime: m[1], data: m[2] }));
    }
    const book = (payload.book || '').trim();
    const wc = normalizeWc(payload.wc || '');
    const image = payload.image || ''; // data URL もしくは生base64
    if (!book || !wc) return json({ ok: false, error: 'missing book/wc' }, 400);
    if (!image) return json({ ok: false, error: 'missing image' }, 400);

    // 撮影画像を base64 + mime に正規化
    let capMime = 'image/jpeg', capData = image;
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(image);
    if (m) { capMime = m[1]; capData = m[2]; }

    const token = await getGoogleAccessToken();
    const ref = await findReferenceImage(token, book, wc);
    if (!ref) return json({ ok: true, found: false, error: '参照画像が見つかりません' });

    const refImg = await fetchImageAsBase64(token, ref.id);
    const result = await callVisionJSON({
      modelKey: payload.model,
      parts: [
        { text: '【1枚目】登録済みの参照画像:' },
        { image: { mime: refImg.mime, data: refImg.data } },
        { text: '【2枚目】目の前の生地の撮影画像:' },
        { image: { mime: capMime, data: capData } },
        { text: MATCH_PROMPT },
      ],
      maxTokens: 1024,
    });

    return json({
      ok: true,
      found: true,
      refFileName: ref.name,
      verdict: result.verdict,
      confidence: result.confidence,
      reason: result.reason,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
