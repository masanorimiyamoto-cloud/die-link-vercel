// api/airtable-update-loc.js  Edge Runtime 版（@vercel/node 不要）
export const config = { runtime: 'edge' };

/**
 * 環境変数:
 *  AIRTABLE_PAT, AIRTABLE_BASE_ID, TABLE_ID(任意), AIRTABLE_TABLE(任意)
 *  FIELD_BOOK, FIELD_WC, FIELD_LOCATION, FIELD_LASTSEEN（任意。未設定なら既定値）
 */

const AIRTABLE_PAT     = process.env.AIRTABLE_PAT || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || '';
const TABLE_ID         = process.env.TABLE_ID || '';
const AIRTABLE_TABLE   = process.env.AIRTABLE_TABLE || 'TableJuchu';
const TABLE_PATH       = encodeURIComponent(TABLE_ID || AIRTABLE_TABLE);
const API              = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_PATH}`;

const FIELD_BOOK      = process.env.FIELD_BOOK     || 'Book';
const FIELD_WC        = process.env.FIELD_WC       || 'WorkCord';
const FIELD_LOCATION  = process.env.FIELD_LOCATION || 'Location';
const FIELD_LASTSEEN  = process.env.FIELD_LASTSEEN || 'LastSeen';

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'content-type': 'application/json; charset=utf-8',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: corsHeaders() });
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

// --- Airtable: list ids by formula ---
async function fetchAllRecordIds(book, wc) {
  const ids = [];
  const esc = (s) => String(s).replace(/'/g, "\\'");
  const formula = `AND({${FIELD_BOOK}}='${esc(book)}',{${FIELD_WC}}='${esc(wc)}')`;
  let offset;

  while (true) {
    const url = new URL(API);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const r = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    const txt = await r.text();
    if (!r.ok) {
      throw new Error(`list ${r.status}: ${txt}`);
    }
    const j = JSON.parse(txt);
    (j.records || []).forEach(rec => ids.push(rec.id));
    offset = j.offset;
    if (!offset) break;
  }
  return { ids, formula };
}

// --- Airtable: batch patch (10件ずつ) ---
async function batchUpdate(ids, fields) {
  let updated = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const slice = ids.slice(i, i + 10);
    const payload = { records: slice.map(id => ({ id, fields })) };

    await new Promise(res => setTimeout(res, 180)); // 軽いクールダウン

    const r = await fetchWithRetry(API, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`patch ${r.status}: ${txt}`);
    const j = JSON.parse(txt);
    updated += (j.records || []).length;
  }
  return updated;
}

// --- 本体 ---
export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }

  if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID) {
    return json({ ok: false, error: 'Airtable credentials missing', api: API }, 500);
  }

  // GET: デバッグ（record id 一覧）
  if (req.method === 'GET') {
    try {
      const u = new URL(req.url);
      const book = (u.searchParams.get('book') || '').trim();
      const wc   = (u.searchParams.get('wc')   || '').trim();
      if (!book || !wc) return json({ ok: false, error: 'need book & wc', api: API }, 400);
      const { ids, formula } = await fetchAllRecordIds(book, wc);
      return json({ ok: true, matched: ids.length, ids, formula, api: API }, 200);
    } catch (e) {
      return json({ ok: false, where: 'GET', error: String(e?.message || e), api: API }, 500);
    }
  }

  // POST: 一括更新
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405);
  }

  try {
    let body = {};
    try { body = await req.json(); } catch {}
    const itemsRaw = Array.isArray(body?.items) ? body.items : undefined;
    if (!itemsRaw || itemsRaw.length === 0) {
      return json({ ok: false, error: 'no items' }, 400);
    }

    // 同一({book,wc,loc,last})はユニーク化
    const key = (x) =>
      `${(x.book || '').trim()}:::${(x.wc || '').trim()}:::${(x.loc || '').trim()}:::${(x.captured_at || x.lastSeen || '').trim()}`;
    const uniq = Array.from(new Map(itemsRaw.map(i => [key(i), i])).values());

    let totalUpdated = 0;
    const skippedDetails = [];

    for (const it of uniq) {
      const book = String(it.book || '').trim();
      const wc   = String(it.wc   || '').trim();
      const loc  = String(it.loc  || '').trim();
      const last = String(it.captured_at || it.lastSeen || '').trim();
      if (!book || !wc || !loc) continue;

      let ids = [];
      try {
        const r = await fetchAllRecordIds(book, wc);
        ids = r.ids;
        if (ids.length === 0) {
          skippedDetails.push(`{${book}/${wc}}: 0 matches (formula: ${r.formula})`);
        }
      } catch (err) {
        let msg = err?.message || String(err);
        const m = /\{.*\}/.exec(msg);
        if (m) {
          try {
            const obj = JSON.parse(m[0]);
            if (obj.error) msg = `${obj.error.type || ''} ${obj.error.message || ''}`;
          } catch {}
        }
        skippedDetails.push(`{${book}/${wc}}: ERROR (${msg})`);
        continue;
      }

      if (ids.length === 0) continue;

      const fields = { [FIELD_LOCATION]: loc };
      if (last) fields[FIELD_LASTSEEN] = last;

      totalUpdated += await batchUpdate(ids, fields);
      await new Promise(r => setTimeout(r, 140));
    }

    return json({
      ok: true,
      success: true,
      updatedRecords: totalUpdated,
      skippedDetails,
      api: API,
    }, 200);

  } catch (e) {
    return json({ ok: false, where: 'POST', error: String(e?.message || e), api: API }, 500);
  }
}
