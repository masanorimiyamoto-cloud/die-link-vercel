// api/airtable-update-progress.js  Edge Runtime 版
// 「探す」「仕舞う」の操作に連動して TableJuchu の 進行社外(singleSelect) を自動更新する
// （進行社内は表示したい情報が多いため使わない）
//
//  POST {  action: 'found' | 'stored' | 'fabric',
//          book, wc            … 単発（探す＝照合一致時／知る＝生地照合一致時）
//          items: [{book,wc,loc?}]  … 複数（仕舞う＝棚登録時）
//          loc がある item は Location（棚番号）と LastSeen（当日）も併せて更新する }
//
//  action → 進行社外 の値:
//    found  = 抜型照合済
//    stored = 抜型を棚に仕舞い完了
//    fabric = 生地照合済
//
//  選択肢が Airtable 側に無くても typecast:true で自動作成される。
export const config = { runtime: 'edge' };

const AIRTABLE_PAT     = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appwAnJP9OOZ3MVF5';
const TABLE_ID         = process.env.TABLE_ID || '';
const AIRTABLE_TABLE   = process.env.AIRTABLE_TABLE || 'TableJuchu';
const TABLE_PATH       = encodeURIComponent(TABLE_ID || AIRTABLE_TABLE);
const API              = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_PATH}`;

const FIELD_BOOK     = process.env.FIELD_BOOK     || 'Book';
const FIELD_WC       = process.env.FIELD_WC       || 'WorkCord';   // number型
const FIELD_PROGRESS = process.env.FIELD_PROGRESS || '進行社外';
const FIELD_ARCHIVED = process.env.FIELD_ARCHIVED || 'アーカイブ済';
const FIELD_LOCATION = process.env.FIELD_LOCATION || 'Location';
const FIELD_LASTSEEN = process.env.FIELD_LASTSEEN || 'LastSeen';

// Edge Runtime は UTC のため JST の「今日」を自前で算出
function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const STATUS_LABELS = {
  found:  process.env.PROGRESS_LABEL_FOUND  || '抜型照合済',
  stored: process.env.PROGRESS_LABEL_STORED || '抜型を棚に仕舞い完了',
  fabric: process.env.PROGRESS_LABEL_FABRIC || '生地照合済',
};
// 進行社外に何が入っていても抜型ステータスで上書きする（ユーザー要望）

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

// --- Airtable: Book+WorkCord で該当レコード（進行社外の現在値つき）を取得 ---
async function fetchRecords(book, wc) {
  const esc = (s) => String(s).replace(/'/g, "\\'");
  const n = Number(wc);
  const wcExpr = Number.isFinite(n) ? String(n) : `'${esc(wc)}'`; // WorkCordはnumber型なので数値比較
  const formula =
    `AND({${FIELD_BOOK}}='${esc(book)}',{${FIELD_WC}}=${wcExpr},{${FIELD_ARCHIVED}}!=TRUE())`;

  const records = [];
  let offset;
  while (true) {
    const url = new URL(API);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('pageSize', '100');
    url.searchParams.append('fields[]', FIELD_PROGRESS);
    if (offset) url.searchParams.set('offset', offset);

    const r = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`list ${r.status}: ${txt}`);
    const j = JSON.parse(txt);
    (j.records || []).forEach(rec => records.push(rec));
    offset = j.offset;
    if (!offset) break;
  }
  return { records, formula };
}

// --- Airtable: batch patch (10件ずつ・typecastで選択肢を自動作成) ---
async function batchUpdate(ids, fields) {
  let updated = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const slice = ids.slice(i, i + 10);
    const payload = { records: slice.map(id => ({ id, fields })), typecast: true };

    await new Promise(res => setTimeout(res, 180));

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
    const status = STATUS_LABELS[action];
    if (!status) {
      return json({ ok: false, error: `action は ${Object.keys(STATUS_LABELS).join(' / ')} を指定してください` }, 400);
    }

    // 単発 {book,wc} と 複数 {items:[...]} の両対応
    let items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length && (body?.book || body?.wc)) items = [{ book: body.book, wc: body.wc }];
    items = items
      .map(it => ({
        book: String(it?.book || '').trim(),
        wc: String(it?.wc || '').trim(),
        loc: String(it?.loc || '').trim(),
      }))
      .filter(it => it.book && it.wc);
    // 同一(book,wc)はユニーク化
    items = Array.from(new Map(items.map(it => [`${it.book}:::${it.wc}`, it])).values());
    if (!items.length) return json({ ok: false, error: 'no items (book/wc)' }, 400);

    let totalMatched = 0;
    let totalUpdated = 0;
    const skippedDetails = [];

    for (const it of items) {
      let records = [];
      try {
        const r = await fetchRecords(it.book, it.wc);
        records = r.records;
        if (records.length === 0) {
          skippedDetails.push(`{${it.book}/${it.wc}}: 0 matches`);
          continue;
        }
      } catch (err) {
        skippedDetails.push(`{${it.book}/${it.wc}}: ERROR (${String(err?.message || err).slice(0, 200)})`);
        continue;
      }
      totalMatched += records.length;

      // loc があれば Location（棚番号）と LastSeen（当日）も併せて更新
      const fields = { [FIELD_PROGRESS]: status };
      if (it.loc) {
        fields[FIELD_LOCATION] = it.loc;
        fields[FIELD_LASTSEEN] = todayJST();
      }

      const targets = [];
      for (const rec of records) {
        const cur = String(rec.fields?.[FIELD_PROGRESS] || '').trim();
        // 進行社外が既に同じ値でも、棚番号の付け替えがあり得るため loc 付きは更新する
        if (cur === status && !it.loc) continue;
        targets.push(rec.id);
      }
      if (!targets.length) continue;

      totalUpdated += await batchUpdate(targets, fields);
      await new Promise(r => setTimeout(r, 140));
    }

    return json({
      ok: true,
      action,
      status,
      matched: totalMatched,
      updated: totalUpdated,
      skippedDetails,
    }, 200);

  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
