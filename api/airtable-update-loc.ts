// die-link-vercel/api/airtable-update-loc.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * 環境:
*  AIRTABLE_PAT        : Airtable Personal Access Token
 *  AIRTABLE_BASE_ID    : ベースID (appXXXXXXXX)
 *  TABLE_ID            : (推奨) テーブルID (tblXXXXXXXX) があればこちらを使う
 *  AIRTABLE_TABLE      : (保険) テーブル名（TableJuchu 等）
 *  FIELD_BOOK          : 既定 'Book'
 *  FIELD_WC            : 既定 'WorkCord'
 *  FIELD_LOCATION      : 既定 'Location'      ← 日本語にしたい場合は '型棚場所' を設定
 *  FIELD_LASTSEEN      : 既定 'LastSeen'      ← 日本語にしたい場合は '型確認日' を設定
*/

const AIRTABLE_PAT     = process.env.AIRTABLE_PAT!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const TABLE_ID         = process.env.TABLE_ID || '';
const AIRTABLE_TABLE   = process.env.AIRTABLE_TABLE || 'TableJuchu';
const TABLE_PATH       = encodeURIComponent(TABLE_ID || AIRTABLE_TABLE);
const API              = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_PATH}`;

const FIELD_BOOK      = process.env.FIELD_BOOK      || 'Book';
const FIELD_WC        = process.env.FIELD_WC        || 'WorkCord';
const FIELD_LOCATION  = process.env.FIELD_LOCATION  || 'Location';
const FIELD_LASTSEEN  = process.env.FIELD_LASTSEEN  || 'LastSeen';

type Item = {
  book: string;
  wc: string;
  wn?: string;
  loc: string;
  captured_at?: string; // クライアントが送るキー
  lastSeen?: string;    // 既存のキー（フォールバック用）
};

// ---- CORS -----------------------------------------------------------------
function setCORS(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// ---- フェッチ with リトライ ------------------------------------------------
async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit & { _attempt?: number } = {}
): Promise<Response> {
  const attempt = (init._attempt ?? 0) + 1;
  const r = await fetch(input, init);
  if (r.ok) return r;
  const retryable = r.status === 429 || (r.status >= 500 && r.status < 600);
  if (!retryable || attempt >= 6) return r;
  const base = 300 * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 120);
  const wait = Math.min(4000, base + jitter);
  await new Promise((res) => setTimeout(res, wait));
  return fetchWithRetry(input, { ...init, _attempt: attempt });
}

// ---- レコードID取得 ---------------------------------------------------------
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
    });
    const txt = await r.text();
    // ★ fetchWithRetry は 4xx エラーをスローしないので、ここでチェック
    if (!r.ok) {
      // formula が間違っている場合 (422 UNKNOWN_FIELD_NAME など) はここ
      throw new Error(`list ${r.status}: ${txt}`);
    }

    const j: any = JSON.parse(txt);
    (j.records || []).forEach((rec: any) => ids.push(rec.id));
    offset = j.offset;
    if (!offset) break;
  }
  return { ids, formula };
}

// ---- 一括更新 --------------------------------------------------------------
async function batchUpdate(ids: string[], fields: Record<string, any>): Promise<number> {
  let updated = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const slice = ids.slice(i, i + 10);
    const payload = { records: slice.map((id) => ({ id, fields })) };
    await new Promise((res) => setTimeout(res, 180));

    const r = await fetchWithRetry(API, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
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

  // ---- GET: デバッグ --------------------------------------------------------
  if (req.method === 'GET') {
    try {
      const book = String(req.query.book || '').trim();
      const wc   = String(req.query.wc   || '').trim();
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

    const key = (x: Item) =>
      `${(x.book || '').trim()}:::${(x.wc || '').trim()}:::${(x.loc || '').trim()}:::${(x.captured_at || x.lastSeen || '').trim()}`;
    const uniq: Item[] = Array.from(new Map(itemsRaw.map((i) => [key(i), i])).values());

    let totalUpdated = 0;
    const skippedDetails: string[] = []; 

    for (const it of uniq) {
      const book = (it.book || '').trim();
      const wc   = (it.wc   || '').trim();
      const loc  = (it.loc  || '').trim();
      const last = (it.captured_at || it.lastSeen || '').trim(); 

      if (!book || !wc || !loc) continue;

      let ids: string[] = [];
      try {
        const result = await fetchAllRecordIds(book, wc);
        ids = result.ids;
        if (ids.length === 0) {
          skippedDetails.push(`{${book}/${wc}}: 0 matches (formula: ${result.formula})`);
        }
      } catch (fetchErr: any) {
        // ▼▼▼ ここから修正 ▼▼▼
        // 検索自体が失敗した場合（例: フィールド名間違い）
        let errMsg = fetchErr.message || String(fetchErr);
        // Airtable APIのエラーJSONを抽出する試み
        const jsonMatch = /\{.*\}/.exec(errMsg);
        if (jsonMatch) {
          try {
            const errObj = JSON.parse(jsonMatch[0]);
            if (errObj.error) {
              // "INVALID_FILTER_BY_FORMULA Unknown field name: "BookName"" のような形式を狙う
              errMsg = `${errObj.error.type || ''} ${errObj.error.message || ''}`;
            }
          } catch {} // パース失敗は無視
        }
        skippedDetails.push(`{${book}/${wc}}: ERROR (${errMsg})`);
        // ▲▲▲ ここまで修正 ▲▲▲
        continue; // この item はスキップして次へ
      }

      if (ids.length === 0) continue; 

      const fields: Record<string, any> = { [FIELD_LOCATION]: loc };
      if (last) fields[FIELD_LASTSEEN] = last;

      totalUpdated += await batchUpdate(ids, fields);

      await new Promise((r) => setTimeout(r, 140));
    }

    res.status(200).send(JSON.stringify({ 
      ok: true, 
      success: true, 
      updatedRecords: totalUpdated, 
      skippedDetails: skippedDetails, // スキップされた理由
      api: API 
    }));

  } catch (e: any) {
    // ハンドラ全体がコケた場合
    res.status(500).send(JSON.stringify({
      ok: false,
      where: 'POST',
      error: String(e?.message || e),
      api: API
    }));
  }
}