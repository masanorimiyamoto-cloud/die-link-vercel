// api/_auth.js
// 個人ログイン（社員番号＋PIN）の共通部品。先頭が _ なので Vercel の関数としては公開されない。
// auth.js（ログインAPI）と、操作者を記録したい各API（airtable-update-progress など）が使う。
//
// 仕組み:
//   - 社員は Airtable の TableStaff（Booksky_net の wsPersonID とは別管理）。
//   - PIN は平文で持たず PBKDF2-SHA256 の暗号値を「PIN暗号値」に保存する。
//     形式: pbkdf2-sha256$<回数>$<salt(base64url)>$<hash(base64url)>
//   - ログイン状態は HttpOnly Cookie「dl_sess」。中身は署名付きの小さなJSONで、
//     サーバー側に保存場所は要らない（SESSION_SECRET で HMAC 署名）。
//   - 紛失・退職時は TableStaff の「有効」をOFF、または「ログイン世代」を+1 すると
//     次の確認（最大 STAFF_CACHE_MS 後）で既存ログインが無効になる。
//   - PIN を 5 回続けて間違えると 15 分ロック（TableStaff に回数と解除時刻を持つ）。
//
// Edge Runtime と Node 20（tools/hash-pin.mjs）の両方で動くよう Web Crypto だけを使う。

const AIRTABLE_PAT     = (typeof process !== 'undefined' && (process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN)) || '';
const AIRTABLE_BASE_ID = (typeof process !== 'undefined' && process.env.AIRTABLE_BASE_ID) || 'appwAnJP9OOZ3MVF5';
const STAFF_TABLE      = (typeof process !== 'undefined' && process.env.STAFF_TABLE_ID) || 'tblKr9eBEiXLzXFhh';
const WORKLOG_TABLE    = (typeof process !== 'undefined' && process.env.WORKLOG_TABLE_ID) || 'tblQFZ7QEuRaBW4oj';
const SESSION_SECRET   = (typeof process !== 'undefined' && process.env.SESSION_SECRET) || '';

export const SESSION_COOKIE = 'dl_sess';
export const SESSION_DAYS   = 30;      // 個人スマホなので長め。使っていれば自動延長
const RENEW_AFTER_MS        = 24 * 3600 * 1000; // 発行から1日たったら延長して再発行
const MAX_FAILS             = 5;
const LOCK_MINUTES          = 15;
const PBKDF2_ITER           = 100000;
const STAFF_CACHE_MS        = 60 * 1000; // 有効/世代の確認結果を使い回す時間

// TableStaff のフィールド名
export const F = {
  name: '氏名', no: '社員番号', pin: 'PIN暗号値', active: '有効', role: '権限',
  gen: 'ログイン世代', fails: 'ログイン失敗回数', lockUntil: 'ロック解除時刻', lastLogin: '最終ログイン',
};
export const ROLE_ADMIN = '管理者';
export const ROLE_STAFF = 'スタッフ';

/* ---------------- base64url ---------------- */
function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function bytesFromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const enc = new TextEncoder();
const dec = new TextDecoder();

// 長さが同じ前提の定数時間比較（タイミングでPINや署名を推測させない）
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------------- PIN ---------------- */
export function isValidPinFormat(pin) {
  return /^\d{4,8}$/.test(String(pin || ''));
}

async function pbkdf2(pin, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPin(pin) {
  if (!isValidPinFormat(pin)) throw new Error('PINは4〜8桁の数字にしてください');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt, PBKDF2_ITER);
  return `pbkdf2-sha256$${PBKDF2_ITER}$${b64urlFromBytes(salt)}$${b64urlFromBytes(hash)}`;
}

export async function verifyPin(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iter = parseInt(parts[1], 10);
  if (!Number.isFinite(iter) || iter < 10000 || iter > 1000000) return false;
  const salt = bytesFromB64url(parts[2]);
  const expect = bytesFromB64url(parts[3]);
  const got = await pbkdf2(pin, salt, iter);
  return safeEqual(got, expect);
}

// 社員が見つからないときも同じだけ時間をかけ、番号の存在を推測させない
export async function dummyVerify(pin) {
  await pbkdf2(String(pin || '0000'), new Uint8Array(16), PBKDF2_ITER);
  return false;
}

/* ---------------- 署名付きセッション ---------------- */
async function hmacKey() {
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    // 既定値で動かすと誰でもログイン情報を偽造できるため、未設定なら止める
    throw new Error('SESSION_SECRET が未設定か短すぎます（32文字以上）');
  }
  return crypto.subtle.importKey('raw', enc.encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(payload) {
  const body = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body)));
  return `${body}.${b64urlFromBytes(sig)}`;
}

export async function readSession(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(), bytesFromB64url(sig), enc.encode(body));
  } catch { return null; }
  if (!ok) return null;
  try {
    const p = JSON.parse(dec.decode(bytesFromB64url(body)));
    if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

export function sessionCookie(token, { dev = false, maxAgeSec = SESSION_DAYS * 86400 } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', `Max-Age=${maxAgeSec}`, 'HttpOnly', 'SameSite=Lax'];
  if (!dev) parts.push('Secure');
  return parts.join('; ');
}
export function clearSessionCookie({ dev = false } = {}) {
  return sessionCookie('', { dev, maxAgeSec: 0 });
}

export function makeSessionPayload(staff) {
  const now = Date.now();
  return {
    sid: staff.id, no: staff.no, name: staff.name, role: staff.role, gen: staff.gen,
    iat: now, exp: now + SESSION_DAYS * 86400 * 1000,
  };
}
export function needsRenew(p) {
  return Date.now() - (p.iat || 0) > RENEW_AFTER_MS;
}

/* ---------------- リクエスト補助 ---------------- */
export function parseCookies(req) {
  const h = req.headers.get('cookie') || '';
  const o = {};
  h.split(';').forEach(kv => {
    const [k, ...vs] = kv.split('=');
    if (!k) return;
    try { o[k.trim()] = decodeURIComponent((vs.join('=') || '').trim()); } catch { /* 壊れたCookieは無視 */ }
  });
  return o;
}
export function isLocalReq(req) {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(new URL(req.url).host);
}
// 既存APIと同じ二重送信Cookie方式の CSRF 確認（ローカルは免除）
export function checkCsrf(req) {
  if (isLocalReq(req)) return true;
  const self = new URL(req.url).origin;
  const origin = req.headers.get('origin') || '';
  const referer = req.headers.get('referer') || '';
  if (!(origin.startsWith(self) || referer.startsWith(self))) return false;
  const cookie = parseCookies(req)['xcsrf'] || '';
  const header = req.headers.get('x-csrf') || '';
  return !!cookie && cookie === header;
}

/* ---------------- Airtable: TableStaff ---------------- */
const STAFF_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${STAFF_TABLE}`;

async function airtable(url, init = {}) {
  if (!AIRTABLE_PAT) throw new Error('AIRTABLE_PAT is missing');
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
      cache: 'no-store',
    });
    if (r.ok) return r.json();
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt >= 4) throw new Error(`airtable ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await new Promise(res => setTimeout(res, 300 * 2 ** (attempt - 1)));
  }
}

export function toStaff(rec) {
  const f = rec.fields || {};
  return {
    id: rec.id,
    no: f[F.no] ?? null,
    name: f[F.name] || '',
    pinHash: f[F.pin] || '',
    active: !!f[F.active],
    role: f[F.role] === ROLE_ADMIN ? ROLE_ADMIN : ROLE_STAFF,
    gen: Number(f[F.gen] || 0),
    fails: Number(f[F.fails] || 0),
    lockUntil: f[F.lockUntil] ? Date.parse(f[F.lockUntil]) : 0,
  };
}

export async function findStaffByNo(no) {
  const n = Number(no);
  if (!Number.isInteger(n) || n < 0) return null;
  const url = new URL(STAFF_API);
  url.searchParams.set('filterByFormula', `{${F.no}}=${n}`);
  url.searchParams.set('maxRecords', '2');
  const j = await airtable(url);
  const recs = j.records || [];
  if (recs.length !== 1) return null; // 0件、または番号重複はログインさせない
  return toStaff(recs[0]);
}

export async function getStaffById(id) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(id || ''))) return null;
  try { return toStaff(await airtable(`${STAFF_API}/${id}`)); }
  catch { return null; }
}

export async function listStaff() {
  const out = [];
  let offset;
  do {
    const url = new URL(STAFF_API);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const j = await airtable(url);
    (j.records || []).forEach(r => out.push(toStaff(r)));
    offset = j.offset;
  } while (offset);
  return out;
}

export async function updateStaff(id, fields) {
  return airtable(STAFF_API, { method: 'PATCH', body: JSON.stringify({ records: [{ id, fields }] }) });
}

/* ---------------- ログイン中の本人を確かめる ---------------- */
const staffCache = new Map(); // sid -> { at, active, gen, role, name }

async function currentStaffState(sid) {
  const c = staffCache.get(sid);
  if (c && Date.now() - c.at < STAFF_CACHE_MS) return c;
  const s = await getStaffById(sid);
  const v = s ? { at: Date.now(), active: s.active && !!s.pinHash, gen: s.gen, role: s.role, name: s.name } : { at: Date.now(), active: false };
  staffCache.set(sid, v);
  return v;
}
export function forgetStaffCache(sid) { staffCache.delete(sid); }

// 戻り値: { user, payload } または null。user = { id, no, name, role }
// 社員表の「有効」と「ログイン世代」も確認するので、無効化は最大1分で効く。
export async function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const p = await readSession(token).catch(() => null);
  if (!p || !p.sid) return null;
  const st = await currentStaffState(p.sid);
  if (!st.active || st.gen !== p.gen) return null;
  return { user: { id: p.sid, no: p.no, name: st.name || p.name, role: st.role }, payload: p };
}

/* ---------------- 作業ログ ---------------- */
// entry = { action, recordIds?, book?, wc?, detail? }。1件でも配列でもよい。
// 失敗しても本来の処理は止めない（ログのために現場の操作を失敗させない）。
export async function writeWorkLog(user, entries) {
  if (!user) return false;
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return true;
  const now = new Date().toISOString();
  const records = list.map(e => {
    const fields = {
      '日時': now,
      '社員': [user.id],
      '社員名': user.name,
      '操作': String(e.action || ''),
      'Book': String(e.book || ''),
      'WorkCord': String(e.wc ?? ''),
      '内容': String(e.detail || ''),
    };
    const ids = (e.recordIds || []).filter(id => /^rec[A-Za-z0-9]{14}$/.test(id));
    if (ids.length) fields['受注'] = ids;
    return { fields };
  });
  try {
    for (let i = 0; i < records.length; i += 10) {
      await airtable(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${WORKLOG_TABLE}`, {
        method: 'POST', body: JSON.stringify({ records: records.slice(i, i + 10) }),
      });
    }
    return true;
  } catch (e) {
    console.error('worklog failed', e?.message || e);
    return false;
  }
}

export const LIMITS = { MAX_FAILS, LOCK_MINUTES };
