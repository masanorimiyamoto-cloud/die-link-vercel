// api/box-shape-match.js
// 目の前の抜き製品（カメラ撮影）と、Google Drive登録済みの図面（-zu 線画 / 展開図）を
// Claudeビジョンで「形状」照合する。生地照合(material-match.js)の姉妹機能。
import { callVisionJSON } from './_vision.js';
export const config = { runtime: 'edge' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ---------- 共通ユーティリティ（material-match.js と同方式） ---------- */
function bytesToBase64(bytes) {
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

function parseCookies(req) {
  const h = req.headers.get('cookie') || ''; const o = {};
  h.split(';').forEach(kv => { const [k, ...vs] = kv.split('='); if (!k) return; o[k.trim()] = decodeURIComponent((vs.join('=') || '').trim()); });
  return o;
}
function sameOrigin(req) {
  const self = new URL(req.url).origin;
  const origin = req.headers.get('origin') || '';
  const referer = req.headers.get('referer') || '';
  return origin.startsWith(self) || referer.startsWith(self);
}

/* ---------- Drive参照図面の特定（-zu 線画を最優先） ---------- */
async function findReferenceDrawing(token, book, wc) {
  const folderId = (process.env.GDRIVE_DIE_MASTER_ID || '').trim();
  if (!folderId) throw new Error('GDRIVE_DIE_MASTER_ID is missing');
  const base = `${book}-${wc}`.trim();
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
  // 形状照合は線画(-zu)が最良 → zu > si > old
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

/* ---------- Claudeビジョン形状照合 ---------- */
const SHAPE_PROMPT = `あなたは製造現場の抜き製品（段ボール／紙箱の半製品）の形状照合アシスタントです。
1枚目は「登録済みの図面（抜き型の展開図・線画のことが多い）」、2枚目は「作業者が目の前の抜き製品をスマホで撮影した画像」です。
2枚が同じ品番の製品か、形状の観点で見比べて判定してください。

見るべき点（形が一致するか）:
- 全体のプロポーション（縦横比）と外形のシルエット
- フラップ（耳）・差し込み片・のりしろの数と配置
- 切り欠き・スリット・穴・ロック形状の位置
- 罫線（折り線）の本数・走り方の大まかな一致

許容する差（違いとみなさない）:
- 撮影の歪み・遠近・回転・裏表・照明・影
- 図面は線画／現物は実物なので、色・材質・印刷の有無は無視する
- 図面に寸法線・文字・タイトル枠が入っていても、それは製品形状ではないので無視する

確信が持てない、または図面が形状を判別できる内容でない場合は uncertain とすること。

回答は次のJSONオブジェクト「のみ」を出力（前後に文章やマークダウンを付けない）:
{"verdict":"match|mismatch|uncertain","confidence":0〜100の整数,"reason":"日本語30〜80字"}

verdict の意味:
- "match": 同じ品番の製品形状とみてよい
- "mismatch": 明らかに別形状（フラップ配置・切り欠き・プロポーションが違う）
- "uncertain": 判断材料が不足、または図面から形状を判別できない`;

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
    }

    const payload = await req.json().catch(() => ({}));
    const book = (payload.book || '').trim();
    const wc = normalizeWc(payload.wc || '');
    const image = payload.image || '';
    if (!book || !wc) return json({ ok: false, error: 'missing book/wc' }, 400);
    if (!image) return json({ ok: false, error: 'missing image' }, 400);

    let capMime = 'image/jpeg', capData = image;
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(image);
    if (m) { capMime = m[1]; capData = m[2]; }

    const token = await getGoogleAccessToken();
    const ref = await findReferenceDrawing(token, book, wc);
    if (!ref) return json({ ok: true, found: false, error: '登録図面が見つかりません' });

    const refImg = await fetchImageAsBase64(token, ref.id);
    const result = await callVisionJSON({
      modelKey: payload.model,
      parts: [
        { text: '【1枚目】登録済みの図面（抜き型の展開図・線画）:' },
        { image: { mime: refImg.mime, data: refImg.data } },
        { text: '【2枚目】目の前の抜き製品の撮影画像:' },
        { image: { mime: capMime, data: capData } },
        { text: SHAPE_PROMPT },
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
