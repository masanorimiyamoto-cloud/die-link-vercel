// pages/api/die-link.js
export const config = { runtime: 'edge' };

const AIRTABLE_BASE = 'appwAnJP9OOZ3MVF5';
const TABLE_NAME    = 'TableJuchu';
const PAGE_ID_RAW   = 'pagvlY8ISJVIQYsnP';   // ← あなたのID
const WORKCORD_IS_NUMBER = true;

const TOKEN = process.env.AIRTABLE_TOKEN;

function html(msg, ok=false, code=200) {
  const color = ok ? '#0a0' : '#c00';
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">
      <h1 style="color:${color};font-size:28px;margin:0 0 12px">${ok?'OK':'NG'}</h1>
      <pre style="white-space:pre-wrap;font-size:16px;line-height:1.6">${msg}</pre>
      <p><a href="javascript:history.back()">← 戻る</a></p>
    </body>`,
    { status: code, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

export default async function handler(req) {
  try {
    const PAGE_ID = (PAGE_ID_RAW || '').trim();

    const { searchParams } = new URL(req.url);

    // recordId 直指定なら即リダイレクト
    const directRec = (searchParams.get('recordId') || '').trim();
    if (directRec) {
      if (!PAGE_ID) return html('設定エラー：PAGE_ID が未設定です。', false, 500);
      const dest = `https://airtable.com/${AIRTABLE_BASE}/interfaces/${PAGE_ID}?recordId=${encodeURIComponent(directRec)}`;
      return Response.redirect(dest, 302);
    }

    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    if (!book || !wc) {
      return html('パラメータ不足：?book=○○&wc=□□ もしくは ?recordId=recXXXX を指定してください。', false, 400);
    }

    if (!TOKEN) {
      return html('サーバ設定エラー：AIRTABLE_TOKEN が未設定です（Vercelの環境変数→再デプロイ）。', false, 500);
    }

    if (!PAGE_ID || !/^(?:pag|pgl)/.test(PAGE_ID)) {
     return html(`サーバ設定エラー：PAGE_ID が不正です（現在：${PAGE_ID}）。AirtableのインターフェースURLから pag... / pgl... を入れてください。`, false, 500);
    }

    const wcExpr  = WORKCORD_IS_NUMBER ? wc : `'${wc.replace(/'/g,"\\'")}'`;
    const formula = `AND({Book}='${book.replace(/'/g,"\\'")}',{WorkCord}=${wcExpr})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.status !== 200) {
      const txt = await r.text();
      return html(`検索失敗：HTTP ${r.status}\n${txt.slice(0,800)}`, false, 502);
    }

    const j = await r.json();
    const rec = (j.records || [])[0];
    if (!rec) {
      return html(`該当なし：Book='${book}' / WorkCord='${wc}'`, false, 404);
    }

    const dest = `https://airtable.com/${AIRTABLE_BASE}/interfaces/${PAGE_ID}?recordId=${rec.id}`;
    return Response.redirect(dest, 302);

  } catch (e) {
    return html(`関数内エラー：${String(e?.message || e)}`, false, 500);
  }
}
