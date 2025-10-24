// die-link-vercel/api/airtable-update-loc.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * 必要な環境変数（3つだけ）
 * - AIRTABLE_PAT        : PAT（data.records:read / write）
 * - AIRTABLE_BASE_ID    : appXXXXXXXX
 * - AIRTABLE_TABLE_ID   : tblYYYYYYYYYYYYYY（テーブルID）
 */

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID!; // ← これ必須

// フィールド名（固定）
const FIELD_BOOK = 'Book';
const FIELD_WC = 'WorkCord';
const FIELD_LOCATION = '型棚場所';
const FIELD_LASTSEEN = '型確認日';

// API エンドポイント（テーブルは ID 指定のみ）
const TABLE_PATH = encodeURIComponent(AIRTABLE_TABLE_ID);
const API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_PATH}`;

type Item = { book: string; wc: string; loc: string; lastSeen: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Book / WorkCord 一致の全レコードID取得（ページング対応） */
async function fetchAllRecordIds(book: string, wc: string): Promise<{ ids: string[], debug: any }> {
  const ids: string[] = [];
  const esc = (s: string) => s.replace(/'/g, "\\'");
  const formula = `AND({${FIELD_BOOK}}='${esc(book)}',{${FIELD_WC}}='${esc(wc)}')`;
  let offset: string | undefined;

  const debug = { formula, pages: 0, statusTrail: [] as any[] };

  while (true) {
    const url = new URL(API);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } });
    debug.statusTrail.push({ step: 'list', status: r.status });

    if (r.status === 429) { await sleep(500); continue; }
    const txt = await r.text();
    if (!r.ok) throw new Error(`list ${r.status}: ${txt}`);

    const j: any = JSON.parse(txt);
    (j.records || []).forEach((rec: any) => ids.push(rec.id));
    offset = j.offset;
    debug.pages++;
    if (!offset) break;
  }
  return { ids, debug };
}

/** 10件ずつ PATCH で更新 */
async function batchUpdate(ids: string[], fields: Record<string, any>): Promise<{ updated: number, debug: any[] }> {
  let updated = 0;
  const debug: any[] = [];

  for (let i = 0; i < ids.length; i += 10) {
    const slice = ids.slice(i, i + 10);
    const payload = { records: slice.map(id => ({ id, fields })) };

    const r = await fetch(API, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const txt = await r.text();
    debug.push({ step: 'patch', range: [i, i + slice.length], status: r.status, body: txt });

    if (r.status === 429) { await sleep(600); i -= 10; continue; }
    if (!r.ok) throw new Error(`patch ${r.status}: ${txt}`);

    const j: any = JSON.parse(txt);
    updated += (j.records || []).length;
  }
  return { updated, debug };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json');

  // デバッグ用：GETでヒット件数を即確認
  if (req.method === 'GET') {
    try {
      const book = String(req.query.book || '').trim();
      const wc   = String(req.query.wc   || '').trim();
      if (!book || !wc) {
        res.status(400).send(JSON.stringify({ ok: false, error: 'need book & wc' })); return;
      }
      const { ids, debug } = await fetchAllRecordIds(book, wc);
      res.status(200).send(JSON.stringify({
        ok: true,
        matched: ids.length,
        ids,
        using: { FIELD_BOOK, FIELD_WC, FIELD_LOCATION, FIELD_LASTSEEN },
        debug, api: API, base: AIRTABLE_BASE_ID, tablePath: TABLE_PATH
      }));
    } catch (e: any) {
      res.status(500).send(JSON.stringify({ ok: false, where: 'GET/list', error: String(e?.message || e) }));
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
    return;
  }

  try {
    const { items } = req.body as { items: Item[] };
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).send(JSON.stringify({ ok: false, error: 'no items' })); return;
    }

    // 重複排除（前後空白も無視）
    const key = (x: Item) => `${x.book.trim()}:::${x.wc.trim()}:::${x.loc.trim()}:::${x.lastSeen.trim()}`;
    const uniq = Array.from(new Map(items.map(i => [key(i), i])).values());

    let totalUpdated = 0;
    const traces: any[] = [];

    for (const it of uniq) {
      const book = it.book.trim();
      const wc   = it.wc.trim();

      // 1) 一致レコードIDの取得
      const { ids, debug: listDbg } = await fetchAllRecordIds(book, wc);
      traces.push({ step: 'list', book, wc, matched: ids.length, debug: listDbg });
      if (ids.length === 0) continue;

      // 2) 更新フィールド（日本語フィールド名でOK）
      const fields: Record<string, any> = {
        [FIELD_LOCATION]: it.loc,
        [FIELD_LASTSEEN]: it.lastSeen
      };

      // 3) バッチ更新
      const { updated, debug: patchDbg } = await batchUpdate(ids, fields);
      traces.push({ step: 'patch', updated, debug: patchDbg });
      totalUpdated += updated;

      await sleep(120); // 軽いレート配慮
    }

    res.status(200).send(JSON.stringify({
      ok: true,
      updatedRecords: totalUpdated,
      using: { FIELD_BOOK, FIELD_WC, FIELD_LOCATION, FIELD_LASTSEEN },
      api: API, base: AIRTABLE_BASE_ID, tablePath: TABLE_PATH,
      traces
    }));
  } catch (e: any) {
    res.status(500).send(JSON.stringify({
      ok: false,
      where: 'POST',
      error: String(e?.message || e),
      debug: {
        api: API,
        base: AIRTABLE_BASE_ID,
        tablePath: TABLE_PATH,
        using: { FIELD_BOOK, FIELD_WC, FIELD_LOCATION, FIELD_LASTSEEN }
      }
    }));
  }
}
