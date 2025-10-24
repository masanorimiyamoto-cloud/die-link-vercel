// app/api/airtable-update-loc/route.ts
// Use the standard Web Request type instead of NextRequest to avoid missing type declarations
// (NextRequest is not required here since we only use req.json()).
const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;          // ★環境変数: PAT
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;  // ★環境変数: Base ID
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "TableJuchu"; // ←テーブル名

const API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;

type Item = { book: string; wc: string; loc: string; lastSeen: string };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllRecordIds(book: string, wc: string): Promise<string[]> {
  const ids: string[] = [];
  const formula = `AND({Book}='${book.replace(/'/g,"\\'")}', {WorkCord}='${wc.replace(/'/g,"\\'")}')`;
  let offset: string | undefined = undefined;

  while (true) {
    const url = new URL(API);
    url.searchParams.set("filterByFormula", formula);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }
    });

    // 簡易リトライ(レート制御)
    if (r.status === 429) { await sleep(500); continue; }
    if (!r.ok) throw new Error(`Airtable list failed: ${r.status} ${await r.text()}`);

    const j = await r.json();
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
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (r.status === 429) { await sleep(600); i -= 10; continue; }
    if (!r.ok) throw new Error(`Airtable patch failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    updated += (j.records || []).length;
  }
  return updated;
}

export async function POST(req: Request) {
  try {
    const { items } = await req.json() as { items: Item[] };
    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "no items" }), { status: 400 });
    }

    let totalUpdated = 0;

    // 同一 book/wc が重複して来た場合に備え、ユニーク化
    const key = (x: Item) => `${x.book}:::${x.wc}:::${x.loc}:::${x.lastSeen}`;
    const uniq = Array.from(new Map(items.map(i => [key(i), i])).values());

    for (const it of uniq) {
      const ids = await fetchAllRecordIds(it.book, it.wc);
      if (ids.length === 0) continue;
      const fields = {
        Location: it.loc,
        LastSeen: it.lastSeen
      };
      totalUpdated += await batchUpdate(ids, fields);
      // 軽いレート配慮
      await sleep(120);
    }

    return new Response(JSON.stringify({ ok: true, updatedRecords: totalUpdated }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500 });
  }
}
