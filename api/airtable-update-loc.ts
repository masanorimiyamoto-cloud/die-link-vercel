import type { VercelRequest, VercelResponse } from '@vercel/node';



const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'TableJuchu';

const API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;

type Item = { book: string; wc: string; loc: string; lastSeen: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchAllRecordIds(book: string, wc: string): Promise<string[]> {
  const ids: string[] = [];
  const esc = (s: string) => s.replace(/'/g, "\\'");
  const formula = `AND({Book}='${esc(book)}',{WorkCord}='${esc(wc)}')`;
  let offset: string | undefined;

  while (true) {
    const url = new URL(API);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } });
    if (r.status === 429) { await sleep(500); continue; }
    if (!r.ok) throw new Error(`Airtable list ${r.status}: ${await r.text()}`);

    const j: any = await r.json();
    (j.records || []).forEach((rec: any) => ids.push(rec.id));
    offset = j.offset;
    if (!offset) break;
  }
  return ids;
}

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
    if (!r.ok) throw new Error(`Airtable patch ${r.status}: ${await r.text()}`);
    const j: any = await r.json();
    updated += (j.records || []).length;
  }
  return updated;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).send(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
    return;
  }

  try {
    const { items } = req.body as { items: Item[] };
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).send(JSON.stringify({ ok: false, error: 'no items' }));
      return;
    }

    // 同じ book/wc/loc/lastSeen の重複を削除
    const key = (x: Item) => `${x.book}:::${x.wc}:::${x.loc}:::${x.lastSeen}`;
    const uniq = Array.from(new Map(items.map(i => [key(i), i])).values());

    let totalUpdated = 0;
    for (const it of uniq) {
      const ids = await fetchAllRecordIds(it.book, it.wc);
      if (ids.length === 0) continue;
      //const fields = { Location: it.loc, LastSeen: it.lastSeen };
      const fields = { 型棚場所: it.loc, 型確認日: it.lastSeen };

      totalUpdated += await batchUpdate(ids, fields);
      await sleep(120);
    }

    res.status(200).send(JSON.stringify({ ok: true, updatedRecords: totalUpdated }));
  } catch (e: any) {
    res.status(500).send(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}
