// api/material-match.js
// 目の前の生地（カメラ撮影）と、Google Drive登録済みの参照画像をAIビジョンで照合する。
// action=search（2026-11-18 作り替え）: 品番を指定せず、撮影した生地に似た見本を受注の画像から作った索引（TableFabricIndex）と
// 生地の台帳（TableFabric）から探し、その生地を使う品番を全部返す（「知る」の 🔎 生地から品番を探す）。
// action=index: 受注の画像を索引に取り込み、AI で生地の有無・範囲・色・柄を書く（画面の「索引を進める」で進める。毎晩の Cron はトークン節約のため外した）。決まりは _fabric.js
import { callVisionJSON, resolveModel } from './_vision.js';
import { requireUser } from './_auth.js';
import {
  FABRIC_TABLE, FB, IDX_TABLE, IX, JUCHU_TABLE, JU, CLASSIFY_BATCH, SEARCH_POOL, toFabric, collectImages, planSync, newIndexFields, pendingRows, indexStatus,
  buildClassifyParts, parseClassify, DESCRIBE_PROMPT, parseDescribe, prefilter, indexSample, fabricSample, planBatches, buildSearchParts,
  mergeResults, buildAnswer, lookupItems, itemRows,
} from './_fabric.js';
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

// Airtable に書く（10行ずつ）。method: POST=作る / PATCH=直す / DELETE=消す
async function airtableWrite(method, table, items) {
  const out = [];
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}`, body;
    if (method === 'DELETE') url += '?' + chunk.map(id => 'records[]=' + encodeURIComponent(id)).join('&');
    else body = JSON.stringify({ records: chunk, typecast: true });
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(url, { method, headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, 'content-type': 'application/json' }, body, cache: 'no-store' });
      if (r.ok) { out.push(...((await r.json()).records || [])); break; }
      if ((r.status !== 429 && r.status < 500) || attempt >= 4) throw new Error(`airtable ${method} ${r.status} ${(await r.text()).slice(0, 200)}`);
      await new Promise(res => setTimeout(res, 400 * attempt));
    }
  }
  return out;
}

/* ---------- 索引の取り込み（action=index） ---------- */
const IDX_FIELDS = Object.values(IX);
// 索引の仕分け（生地あり/線画・範囲・色・柄）に使うモデル。安い Haiku（トークン節約）。FABRIC_INDEX_MODEL で替えられる
const INDEX_MODEL = process.env.FABRIC_INDEX_MODEL || 'claude-haiku-5-5';
// 1回分: 受注の画像と索引を合わせ（追加・差し替え・削除）、未判定の画像を limit 枚まで AI に見せて書く
async function indexStep(payload, limit = 16) {
  const juchu = await airtableList(JUCHU_TABLE, { filterByFormula: 'NOT({画像}=BLANK())', fields: [JU.book, JU.wc, JU.image] });
  const images = collectImages(juchu);
  let rows = await airtableList(IDX_TABLE, { fields: IDX_FIELDS });
  const plan = planSync(images, rows);
  if (plan.remove.length) await airtableWrite('DELETE', IDX_TABLE, plan.remove);
  if (plan.update.length) await airtableWrite('PATCH', IDX_TABLE, plan.update);
  const made = plan.create.length ? await airtableWrite('POST', IDX_TABLE, plan.create.map(img => ({ fields: newIndexFields(img) }))) : [];
  const gone = new Set(plan.remove);
  const upd = new Map(plan.update.map(u => [u.id, u.fields]));
  rows = [...rows.filter(r => !gone.has(r.id)).map(r => upd.has(r.id) ? { ...r, fields: { ...r.fields, ...upd.get(r.id) } } : r), ...made];

  // 画像は今読んだ受注の URL で取る（期限切れにならない）
  const byKey = new Map([...images.values()].map(img => [img.key, img]));
  const todo = pendingRows(rows).slice(0, limit);
  const imgs = new Map(); let unread = 0;
  await Promise.all(todo.map(r => {
    const img = byKey.get(r.fields?.[IX.key]);
    return img ? fetchUrlAsBase64(img.url).then(v => imgs.set(r.id, v)).catch(() => { unread++; }) : (unread++, null);
  }));
  const writes = new Map();
  const batches = [];
  for (let i = 0; i < todo.length; i += CLASSIFY_BATCH) batches.push(todo.slice(i, i + CLASSIFY_BATCH));
  await Promise.all(batches.map(async (b) => {
    const { parts, labels } = buildClassifyParts(b, imgs);
    if (!labels.size) return;
    try {
      // 仕分けは安いモデルで。失敗（鍵が無い等）したらこの組だけ画面のモデルでやり直す
      const v = await callVisionJSON({ modelKey: INDEX_MODEL, parts, maxTokens: 2048 })
        .catch(() => callVisionJSON({ modelKey: payload?.model, parts, maxTokens: 2048 }));
      for (const [id, f] of parseClassify(v, labels)) writes.set(id, f);
    } catch { /* この組は失敗のまま（下で 失敗・試行回数+1） */ }
  }));
  const now = new Date().toISOString();
  const patch = todo.map(r => ({ id: r.id, fields: { ...(writes.get(r.id) || { [IX.state]: '失敗' }), [IX.tries]: Number(r.fields?.[IX.tries] || 0) + 1, [IX.at]: now } }));
  if (patch.length) await airtableWrite('PATCH', IDX_TABLE, patch);
  const pm = new Map(patch.map(p => [p.id, p.fields]));
  rows = rows.map(r => pm.has(r.id) ? { ...r, fields: { ...r.fields, ...pm.get(r.id), [IX.state]: pm.get(r.id)[IX.state] } } : r);
  return { created: made.length, updated: plan.update.length, removed: plan.remove.length, classified: writes.size, failed: todo.length - writes.size, unread,
    images: images.size, status: indexStatus(rows) };
}
// Cron: 時間の許す限り繰り返す（最初の応答は空白で返し始めているので、Edge の25秒には当たらない）
async function indexRun(payload, budgetMs) {
  const t0 = Date.now(); let last, steps = 0;
  do { last = await indexStep(payload, 16); steps++; } while (last.status.pending > 0 && last.classified + last.failed > 0 && Date.now() - t0 < budgetMs);
  return { ok: true, steps, ...last };
}

/* ---------- 検索（action=search） ---------- */
// 索引の見本の画像を、受注から今の URL で取る（受注RecordID＋添付ID → 大きめのサムネイル）
async function resolveIndexPhotos(samples) {
  const recs = [...new Set(samples.map(s => s.rec).filter(id => /^rec[A-Za-z0-9]{14}$/.test(id || '')))];
  const urlByAtt = new Map();
  for (let i = 0; i < recs.length; i += 40) {
    const f = 'OR(' + recs.slice(i, i + 40).map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    for (const r of await airtableList(JUCHU_TABLE, { filterByFormula: f, fields: [JU.image] })) {
      for (const a of r.fields?.[JU.image] || []) urlByAtt.set(a.id, a.thumbnails?.large?.url || a.url);
    }
  }
  for (const s of samples) { const u = urlByAtt.get(s.att); s.photos = u ? [{ url: u }] : []; }
}

async function fabricSearch(payload, cap) {
  const t0 = Date.now();
  const model = resolveModel(payload.model).label;
  // 撮影写真の色・柄（絞り込み用）と、索引・台帳を同時に読む
  const [descR, idxRows, ledgerRecs] = await Promise.all([
    callVisionJSON({ modelKey: payload.model, parts: [{ image: cap }, { text: DESCRIBE_PROMPT }], maxTokens: 512 }).then(v => ({ ok: true, v }), e => ({ ok: false, e })),
    airtableList(IDX_TABLE, { fields: IDX_FIELDS }),
    airtableList(FABRIC_TABLE, { filterByFormula: `{有効}`, fields: Object.values(FB) }).catch(() => []),
  ]);
  const index = indexStatus(idxRows);
  const ledger = ledgerRecs.map(toFabric);
  const feat = descR.ok ? parseDescribe(descR.v) : { colors: [], pattern: '', quality: 'ok', advice: '', desc: '' };
  const base = { ok: true, index, model, quality: feat.quality, advice: feat.advice, seen: { colors: feat.colors, pattern: feat.pattern } };
  if (!descR.ok) return { ok: false, error: 'AIが撮影写真を読めませんでした: ' + String(descR.e?.message || descR.e).slice(0, 160), index };

  const fabricRows = idxRows.filter(r => r.fields?.[IX.state]?.name === '済' || r.fields?.[IX.state] === '済')
    .filter(r => (r.fields?.[IX.kind]?.name || r.fields?.[IX.kind]) === '生地あり');
  const ledgerSamples = ledger.filter(fb => fb.photos.length).map(fabricSample);
  if (!fabricRows.length && !ledgerSamples.length) {
    return { ...base, items: [], similar: [], compared: 0, reason: index.pending ? 'indexing' : 'noSamples', ms: Date.now() - t0 };
  }
  if (feat.quality !== 'ok' && !feat.colors.length) return { ...base, items: [], similar: [], compared: 0, reason: 'quality', ms: Date.now() - t0 };

  // 色・柄で絞る（台帳の写真は色・柄が分からないので必ず残す）
  const pool = [...ledgerSamples, ...prefilter(fabricRows.map(indexSample), feat, Math.max(0, SEARCH_POOL - ledgerSamples.length))];
  await resolveIndexPhotos(pool.filter(s => s.from === 'image'));
  const urls = [...new Set(pool.flatMap(s => s.photos.map(p => p.url)))];
  const imgs = new Map();
  await Promise.all(urls.map(u => fetchUrlAsBase64(u).then(v => imgs.set(u, v)).catch(() => {})));
  const unread = pool.filter(s => !s.photos.some(p => imgs.has(p.url))).length;   // 画像を読めなかった見本（照合していない）
  const calls = planBatches(pool.filter(s => s.photos.some(p => imgs.has(p.url)))).map(g => buildSearchParts(g, cap, imgs)).filter(c => c.labels.size);
  if (!calls.length) return { ok: false, error: '見本の画像を読めませんでした。少し待ってからもう一度試してください', index };
  const results = await Promise.all(calls.map(c => callVisionJSON({ modelKey: payload.model, parts: c.parts, maxTokens: 1024 })
    .then(value => ({ ok: true, value, labels: c.labels }), e => ({ ok: false, error: String(e?.message || e), labels: c.labels }))));
  const merged = mergeResults(results);
  if (!merged.answered) return { ok: false, error: 'AIの照合に失敗しました: ' + (results.find(r => !r.ok)?.error || '').slice(0, 160), index, retry: true };
  const compared = results.filter(r => r.ok).reduce((n, r) => n + r.labels.size, 0);
  const notCompared = unread + results.filter(r => !r.ok).reduce((n, r) => n + r.labels.size, 0);

  const ans = buildAnswer(merged.matched, ledger);
  const all = [...ans.items, ...ans.similar.flatMap(s => s.items)];
  const info = all.length ? await lookupItems(airtableList, all) : new Map();
  // 根拠の見本の写真（画面で見比べる）
  const photoOf = new Map(pool.map(s => [s.sid, s.photos[0]?.url || '']));
  const nameOf = new Map(pool.map(s => [s.sid, s.name || '']));
  return {
    ...base, compared, notCompared, partial: notCompared > 0, pool: pool.length, fabricImages: fabricRows.length,
    items: itemRows(ans.items, info).map(x => ({ book: x.book, wc: x.wc, itemName: x.itemName, active: x.active, ndate: x.ndate, known: x.known,
      score: x.ev.score, reason: x.ev.reason, via: x.ev.via, photo: photoOf.get(x.ev.sid) || '', source: nameOf.get(x.ev.sid) || '' })),
    similar: ans.similar.map(s => ({ score: s.score, reason: s.reason, photo: photoOf.get(s.sid) || '', source: nameOf.get(s.sid) || '',
      items: itemRows(s.items, info).map(x => ({ book: x.book, wc: x.wc, itemName: x.itemName, active: x.active, ndate: x.ndate, known: x.known })) })),
    ms: Date.now() - t0,
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
    // 毎晩の Cron（vercel.json）: 索引の取り込み。CRON_SECRET があれば Bearer、無ければ Vercel Cron の UA だけ受ける
    if (req.method === 'GET' && new URL(req.url).searchParams.get('action') === 'index') {
      const secret = process.env.CRON_SECRET || '';
      const fromCron = secret ? (req.headers.get('authorization') || '') === `Bearer ${secret}` : /vercel-cron/i.test(req.headers.get('user-agent') || '');
      if (!fromCron) return json({ ok: false, error: 'forbidden' }, 403);
      return streamJson(() => indexRun({}, 200000));
    }
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
    // 画面の「索引を進める」: 1回分（16枚まで）。画面は残りがあれば続けて呼ぶ
    if (payload.action === 'index') return streamJson(async () => ({ ok: true, ...(await indexStep(payload, 16)) }));
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
