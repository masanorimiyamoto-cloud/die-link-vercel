// die-link-vercel/api/airtable-update-loc.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * 環境:
 *  AIRTABLE_PAT        : Airtable Personal Access Token
 *  AIRTABLE_BASE_ID    : ベースID (appXXXXXXXX)
 *  TABLE_ID            : (推奨) テーブルID (tblXXXXXXXX) があればこちらを使う
 *  AIRTABLE_TABLE      : (保険) テーブル名（TableJuchu 等）
 *  FIELD_BOOK          : 既定 'Book'
 *  FIELD_WC            : 既定 'WorkCord'
 *  FIELD_LOCATION      : 既定 'Location'      ← 日本語にしたい場合は '型棚場所' を設定
 *  FIELD_LASTSEEN      : 既定 'LastSeen'      ← 日本語にしたい場合は '型確認日' を設定
 */

const AIRTABLE_PAT     = process.env.AIRTABLE_PAT!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const TABLE_ID         = process.env.TABLE_ID || '';                       // 例: 'tbl3r511iE8MS22vm'
const AIRTABLE_TABLE   = process.env.AIRTABLE_TABLE || 'TableJuchu';       // 予備でテーブル名
const TABLE_PATH       = encodeURIComponent(TABLE_ID || AIRTABLE_TABLE);
const API              = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_PATH}`;

const FIELD_BOOK      = process.env.FIELD_BOOK      || 'Book';
const FIELD_WC        = process.env.FIELD_WC        || 'WorkCord';
const FIELD_LOCATION  = process.env.FIELD_LOCATION  || 'Location';
const FIELD_LASTSEEN  = process.env.FIELD_LASTSEEN  || 'LastSeen';

type Item = { book: string; wc: string; loc: string; lastSeen?: string };

// ---- CORS（フロントが別オリジンでも叩けるように） --------------------------
function setCORS(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// ---- 共通: フェッチ with リトライ（429/5xx 対策：指数バックオフ+ジッタ） ----
async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit & { _attempt?: number } = {}
): Promise<Response> {
  const attempt = (init._attempt ?? 0) + 1;
  const r = await fetch(input, init);
  if (r.ok) return r;

  // リトライ対象
  const retryable = r.status === 429 || (r.status >= 500 && r.status < 600);
  if (!retryable) return r;

  if (attempt >= 6) return r; // 最大試行

  // バックオフ（基準 300ms * 2^(attempt-1) ± ジッタ）
  const base = 300 * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 120);
  const wait = Math.min(4000, base + jitter);
  await new Promise((res) => setTimeout(res, wait));
  return fetchWithRetry(input, { ...init, _attempt: attempt });
}

// ---- Book/WC の一致で全レコードIDを回収（100件ページング） ------------------
async function fetchAllRecordIds(book: string, wc: string): Promise<{ ids: string[]; formula: string }> {
  const ids: string[] = [];
  const esc = (s: string) => s.replace(/'/g, "\\'");
  const formula = `AND({${FIELD_BOOK}}='${esc(book)}',{${FIELD_WC}}='${esc(wc)}')`;
  let offset: string | undefined;

  while (true) {
    const url = new URL(API);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const r = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      // Serverless でのタイムアウトを避けるため keepalive はオフ
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`list ${r.status}: ${txt}`);

    const j: any = JSON.parse(txt);
    (j.records || []).forEach((rec: any) => ids.push(rec.id));
    offset = j.offset;
    if (!offset) break;
  }
  return { ids, formula };
}

// ---- PATCH を10件ずつ・逐次で実行（429時はfetchWithRetryが吸収） ------------
async function batchUpdate(ids: string[], fields: Record<string, any>): Promise<number> {
  let updated = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const slice = ids.slice(i, i + 10);
    const payload = { records: slice.map((id) => ({ id, fields })) };

    // 過負荷対策：軽いスロットリング
    await new Promise((res) => setTimeout(res, 180));

    const r = await fetchWithRetry(API, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`patch ${r.status}: ${txt}`);
    const j: any = JSON.parse(txt);
    updated += (j.records || []).length;
  }
  return updated;
}

// ---- ハンドラ ---------------------------------------------------------------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCORS(res);
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID) {
    res.status(500).send(JSON.stringify({ ok: false, error: 'Airtable credentials missing', api: API }));
    return;
  }

  // ---- GET: デバッグ（件数/式/実際のAPIパス確認） ---------------------------
  if (req.method === 'GET') {
    try {
      const book = String(req.query.book || '').trim();
      const wc   = String(req.query.wc   || '').trim();
      if (!book || !wc) {
        res.status(400).send(JSON.stringify({ ok: false, error: 'need book & wc', api: API }));
        return;
      }
      const { ids, formula } = await fetchAllRecordIds(book, wc);
      res.status(200).send(JSON.stringify({ ok: true, matched: ids.length, ids, formula, api: API }));
    } catch (e: any) {
      res.status(500).send(JSON.stringify({ ok: false, where: 'GET', error: String(e?.message || e), api: API }));
    }
    return;
  }

  // ---- POST: 一括更新本体 ----------------------------------------------------
  if (req.method !== 'POST') {
    res.status(405).send(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
    return;
  }

  try {
    const itemsRaw = (req.body && (req.body as any).items) as Item[] | undefined;
    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
      res.status(400).send(JSON.stringify({ ok: false, error: 'no items' }));
      return;
    }

    // 重複排除（book/wc/loc/lastSeen のトリム後でユニーク化）
    const key = (x: Item) =>
      `${(x.book || '').trim()}:::${(x.wc || '').trim()}:::${(x.loc || '').trim()}:::${(x.lastSeen || '').trim()}`;
    const uniq: Item[] = Array.from(new Map(itemsRaw.map((i) => [key(i), i])).values());

    let totalUpdated = 0;
    for (const it of uniq) {
      const book = (it.book || '').trim();
      const wc   = (it.wc   || '').trim();
      const loc  = (it.loc  || '').trim();
      const last = (it.lastSeen || '').trim();

      if (!book || !wc || !loc) continue;

      const { ids } = await fetchAllRecordIds(book, wc);
      if (ids.length === 0) continue;

      const fields: Record<string, any> = { [FIELD_LOCATION]: loc };
      if (last) fields[FIELD_LASTSEEN] = last; // 形式: YYYY-MM-DD

      totalUpdated += await batchUpdate(ids, fields);

      // 連続 item 更新の過負荷対策
      await new Promise((r) => setTimeout(r, 140));
    }

    res.status(200).send(JSON.stringify({ ok: true, updatedRecords: totalUpdated, api: API }));
  } catch (e: any) {
    res.status(500).send(JSON.stringify({
      ok: false,
      where: 'POST',
      error: String(e?.message || e),
      api: API
    }));
  }
}
