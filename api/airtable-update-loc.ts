// die-link-vercel/api/airtable-update-loc.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;

// ★ あなたのコードにすでにある Table ID を優先して使う
const TABLE_ID = 'tbl3r511iE8MS22vm';                 // ← あなたの tbl... をここに
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'TableJuchu'; // 保険で“名前”も残す

// ★ Table ID があればそちらを使い、無ければテーブル名で呼ぶ
const TABLE_PATH = encodeURIComponent(TABLE_ID || AIRTABLE_TABLE);
const API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_PATH}`;

type Item = { book: string; wc: string; loc: string; lastSeen: string };

const FIELD_BOOK = 'Book';
const FIELD_WC   = 'WorkCord';
const FIELD_LOCATION = 'Location';   // ← 日本語を使う場合は '型棚場所'
const FIELD_LASTSEEN = 'LastSeen';   // ← 日本語を使う場合は '型確認日'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 指定の Book / WorkCord に一致する全レコード ID を取得
async function fetchAllRecordIds(book: string, wc: string): Promise<{ ids: string[], formula: string }> {
  const ids: string[] = [];
  const esc = (s: string) => s.replace(/'/g, "\\'");
  const formula = `AND({${FIELD_BOOK}}='${esc(book)}',{${FIELD_WC}}='${esc(wc)}')`;
  let offset: string | undefined;

  while (true) {
    const url = new URL(API);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } });
    if (r.status === 429) { await sleep(500); continue; }

    const txt = await r.text();
    if (!r.ok) throw new Error(`list ${r.status}: ${txt}`);

    const j: any = JSON.parse(txt);
    (j.records || []).forEach((rec: any) => ids.push(rec.id));
    offset = j.offset;
    if (!offset) break;
  }
  return { ids, formula };
}

// 10件ずつ PATCH 更新
async function batchUpdate(ids: string[], fields: Record<string, any>): Promise<number> {
  let updated = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const slice = ids.slice(i, i + 10);
    const payload = { records: slice.map(id => ({ id, fields })) };
    const r = await fetch(API, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.status === 429) { await sleep(600); i -= 10; continue; }
    const txt = await r.text();
    if (!r.ok) throw new Error(`patch ${r.status}: ${txt}`);
    const j: any = JSON.parse(txt);
    updated += (j.records || []).length;
  }
  return updated;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json');

  // デバッグ: GET でヒット件数と formula/URL を確認できる
  if (req.method === 'GET') {
    try {
      const book = String(req.query.book || '').trim();
      const wc   = String(req.query.wc   || '').trim();
      if (!book || !wc) { res.status(400).send(JSON.stringify({ ok:false, error:'need book & wc' })); return; }
      const { ids, formula } = await fetchAllRecordIds(book, wc);
      res.status(200).send(JSON.stringify({ ok:true, matched: ids.length, ids, formula, api: API, tablePath: TABLE_PATH }));
    } catch (e: any) {
      res.status(500).send(JSON.stringify({ ok:false, where:'GET', error: String(e?.message || e), api: API, tablePath: TABLE_PATH }));
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
      res.status(400).send(JSON.stringify({ ok:false, error:'no items' })); return;
    }

    // 重複排除（前後空白も無視）
    const key = (x: Item) => `${x.book.trim()}:::${x.wc.trim()}:::${x.loc.trim()}:::${x.lastSeen.trim()}`;
    const uniq = Array.from(new Map(items.map(i => [key(i), i])).values());

    let totalUpdated = 0;
    for (const it of uniq) {
      const { ids } = await fetchAllRecordIds(it.book.trim(), it.wc.trim());
      if (ids.length === 0) continue;

      const fields: Record<string, any> = {
        [FIELD_LOCATION]: it.loc,
        [FIELD_LASTSEEN]: it.lastSeen
      };

      totalUpdated += await batchUpdate(ids, fields);
      await sleep(120);
    }

    res.status(200).send(JSON.stringify({ ok:true, updatedRecords: totalUpdated, api: API, tablePath: TABLE_PATH }));
  } catch (e: any) {
    res.status(500).send(JSON.stringify({
      ok:false,
      where:'POST',
      error: String(e?.message || e),
      api: API,
      tablePath: TABLE_PATH
    }));
  }
}
