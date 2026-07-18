// api/slip-verify.js  Edge Runtime 版
// 受領伝票の照合（複合機を使わない伝票照合）
//   伝票QR = Airtable RecordID（最大10明細分）を1つのQRに格納（伝票発行時にExcel→Airtable同期済み）
//   照合は「紙伝票（手書き訂正込みの最終状態） vs Airtable（最新の真実）」
//
// POST {action:'fetch', ids:['rec...', ...]}
//   → 各明細の現在値（Book/WorkCord/ItemName/NAmount/Ndate/進行社外/照合状態）をQRの行順で返す
//
// POST {action:'verify', items:[{id, status, details, namount?, ndate?}]}
//   status: OK | UpdatedBySlip | Mismatch | CancelledLine
//     OK            … 紙伝票とAirtableが一致
//     UpdatedBySlip … 手書き訂正をAirtableへ反映して一致させた（namount/ndate で NAmount/Ndate も更新）
//     Mismatch      … 不一致のまま（値は更新しない）
//     CancelledLine … 二重線で取り消された行
//   結果は VerificationStatus(singleSelect) / VerificationDetails(longText) に記録する。
export const config = { runtime: 'edge' };

const AIRTABLE_PAT     = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appwAnJP9OOZ3MVF5';
const TABLE_ID         = process.env.TABLE_ID || '';
const AIRTABLE_TABLE   = process.env.AIRTABLE_TABLE || 'TableJuchu';
const TABLE_PATH       = encodeURIComponent(TABLE_ID || AIRTABLE_TABLE);
const API              = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_PATH}`;

const FIELD_BOOK         = process.env.FIELD_BOOK     || 'Book';
const FIELD_WC           = process.env.FIELD_WC       || 'WorkCord';
const FIELD_ITEMNAME     = process.env.FIELD_ITEMNAME || 'ItemName';
const FIELD_NAMOUNT      = process.env.FIELD_NAMOUNT  || 'NAmount';
const FIELD_NDATE        = process.env.FIELD_NDATE    || 'Ndate';
const FIELD_PROGRESS_OUT = process.env.FIELD_PROGRESS || '進行社外';
const FIELD_VSTATUS      = process.env.FIELD_VSTATUS  || 'VerificationStatus';
const FIELD_VDETAILS     = process.env.FIELD_VDETAILS || 'VerificationDetails';

const STATUSES = new Set(['OK', 'UpdatedBySlip', 'Mismatch', 'CancelledLine']);
const REC_RE = /^rec[A-Za-z0-9]{14}$/;
const MAX_IDS = 20; // 伝票1枚=最大10明細だが余裕を持たせる

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-csrf',
    'content-type': 'application/json; charset=utf-8',
  };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: corsHeaders() });
}
function parseCookies(req) {
  const h = req.headers.get('cookie') || '';
  const out = {};
  h.split(';').forEach(kv => {
    const [k, ...vs] = kv.split('=');
    if (!k) return;
    out[k.trim()] = decodeURIComponent((vs.join('=') || '').trim());
  });
  return out;
}
function sameOrigin(req) {
  const selfOrigin = new URL(req.url).origin;
  const origin  = req.headers.get('origin')  || '';
  const referer = req.headers.get('referer') || '';
  return (origin.startsWith(selfOrigin) || referer.startsWith(selfOrigin));
}

// --- fetch with retry (429/5xx) ---
async function fetchWithRetry(input, init = {}) {
  const attempt = (init._attempt ?? 0) + 1;
  const r = await fetch(input, init);
  if (r.ok) return r;
  const retryable = r.status === 429 || (r.status >= 500 && r.status < 600);
  if (!retryable || attempt >= 6) return r;
  const base = 300 * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 120);
  const wait = Math.min(4000, base + jitter);
  await new Promise(res => setTimeout(res, wait));
  return fetchWithRetry(input, { ...init, _attempt: attempt });
}

// --- RecordID群 → 現在値（QRの並び＝伝票の行順を保つ） ---
async function fetchByIds(ids) {
  const formula = 'OR(' + ids.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
  const url = new URL(API);
  url.searchParams.set('filterByFormula', formula);
  url.searchParams.set('pageSize', '100');
  [FIELD_BOOK, FIELD_WC, FIELD_ITEMNAME, FIELD_NAMOUNT, FIELD_NDATE,
   FIELD_PROGRESS_OUT, FIELD_VSTATUS, FIELD_VDETAILS]
    .forEach(f => url.searchParams.append('fields[]', f));

  const r = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`list ${r.status}: ${txt}`);
  const j = JSON.parse(txt);
  const byId = new Map((j.records || []).map(rec => [rec.id, rec.fields || {}]));

  return ids.map(id => {
    const f = byId.get(id);
    if (!f) return { id, missing: true };
    return {
      id,
      Book: f[FIELD_BOOK] ?? '',
      WorkCord: f[FIELD_WC] ?? '',
      ItemName: f[FIELD_ITEMNAME] ?? '',
      NAmount: f[FIELD_NAMOUNT] ?? null,
      Ndate: f[FIELD_NDATE] ?? '',
      ProgressOut: f[FIELD_PROGRESS_OUT] ?? '',
      VerificationStatus: f[FIELD_VSTATUS] ?? '',
      VerificationDetails: f[FIELD_VDETAILS] ?? '',
    };
  });
}

// --- 照合結果の書込（レコードごとに個別フィールド・10件ずつPATCH） ---
async function patchItems(items) {
  const done = [];
  for (let i = 0; i < items.length; i += 10) {
    const slice = items.slice(i, i + 10);
    if (i) await new Promise(res => setTimeout(res, 180));
    const r = await fetchWithRetry(API, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        records: slice.map(it => ({ id: it.id, fields: it.fields })),
        typecast: true, // VerificationStatus の選択肢が未作成でも自動追加
      }),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`patch ${r.status}: ${txt}`);
    const j = JSON.parse(txt);
    (j.records || []).forEach(rec => done.push(rec.id));
  }
  return done;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405);
  }
  if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID) {
    return json({ ok: false, error: 'Airtable credentials missing' }, 500);
  }

  // 同一オリジン + CSRF（/api/session が発行する xcsrf Cookie とヘッダの一致）
  if (!sameOrigin(req)) {
    return json({ ok: false, error: 'Origin/Referer 不一致' }, 403);
  }
  const cookies = parseCookies(req);
  const csrfCookie = cookies['xcsrf'] || '';
  const csrfHeader = req.headers.get('x-csrf') || '';
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return json({ ok: false, error: 'CSRF 検証NG' }, 403);
  }

  try {
    let body = {};
    try { body = await req.json(); } catch {}
    const action = String(body?.action || '').trim();

    if (action === 'fetch') {
      const ids = Array.from(new Set(
        (Array.isArray(body?.ids) ? body.ids : [])
          .map(s => String(s || '').trim())
          .filter(s => REC_RE.test(s))
      )).slice(0, MAX_IDS);
      if (!ids.length) return json({ ok: false, error: 'RecordID がありません' }, 400);

      const records = await fetchByIds(ids);
      return json({ ok: true, records }, 200);
    }

    if (action === 'verify') {
      const items = (Array.isArray(body?.items) ? body.items : [])
        .map(it => {
          const id = String(it?.id || '').trim();
          const status = String(it?.status || '').trim();
          if (!REC_RE.test(id) || !STATUSES.has(status)) return null;
          const fields = {
            [FIELD_VSTATUS]: status,
            [FIELD_VDETAILS]: String(it?.details || '').slice(0, 2000),
          };
          // 手書き訂正の反映は UpdatedBySlip のときだけ受け付ける（他statusで値は書き換えない）
          if (status === 'UpdatedBySlip') {
            const n = Number(it?.namount);
            if (it?.namount != null && Number.isFinite(n)) fields[FIELD_NAMOUNT] = n;
            const d = String(it?.ndate || '').trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) fields[FIELD_NDATE] = d;
          }
          return { id, fields };
        })
        .filter(Boolean)
        .slice(0, MAX_IDS);
      if (!items.length) return json({ ok: false, error: 'items がありません' }, 400);

      const ids = await patchItems(items);
      return json({ ok: true, updated: ids.length, ids }, 200);
    }

    return json({ ok: false, error: 'action は fetch / verify を指定してください' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
