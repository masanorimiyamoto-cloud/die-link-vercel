export const config = { runtime: 'edge' };

const AIRTABLE_BASE = 'appwAnJP9OOZ3MVF5';
const TABLE_NAME    = 'TableJuchu';
const PAGE_ID       = 'pagV1rqHkuuSg3BPm'; // ← あなたのIDに置換済みであること
const TOKEN         = process.env.AIRTABLE_TOKEN; // ← VercelのEnv（Production）に設定
const WORKCORD_IS_NUMBER = true; // WorkCord が数値フィールドなら true

function html(msg, ok=false, code=200) {
  const color = ok ? '#0a0' : '#c00';
  return new Response(
    `<!doctype html><meta charset="utf-8">
     <body style="font-family:system-ui;padding:24px">
      <h1 style="color:${color};font-size:28px;margin:0 0 12px">${ok?'OK':'NG'}</h1>
      <pre style="white-space:pre-wrap;font-size:16px;line-height:1.6">${msg}</pre>
      <p><a href="javascript:history.back()">← 戻る</a></p>`,
    { status: code, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

export default async function handler(req) {
  try {
    // 1) 基本パラメータ
    const { searchParams } = new URL(req.url);
    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    if (!book || !wc) return html('パラメータ不足：book と wc を指定してください。', false, 400);

    // 2) サーバ設定チェック
    if (!TOKEN) {
      return html('サーバ設定エラー：AIRTABLE_TOKEN が未設定です（Vercel → Project → Settings → Environment Variables に追加後、再デプロイが必要）。', false, 500);
    }
    if (!PAGE_ID || !/^pg[al]/.test(PAGE_ID)) {
      return html(`サーバ設定エラー：PAGE_ID が不正です（現在：${PAGE_ID}）。AirtableのインターフェースURLから pgl... / pag... を入れてください。`, false, 500);
    }

    // 3) Airtable 検索
    const wcExpr  = WORKCORD_IS_NUMBER ? wc : `'${wc.replace(/'/g,"\\'")}'`;
    const formula = `AND({Book}='${book.replace(/'/g,"\\'")}',{WorkCord}=${wcExpr})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}`
              + `?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }});
    if (r.status !== 200) {
      const txt = await r.text();
      console.error('Airtable API error', r.status, txt);
      return html(`検索失敗：${r.status}\n${txt.slice(0,500)}`, false, 502);
    }

    const j = await r.json();
    const rec = (j.records || [])[0];
    if (!rec) {
      return html(`該当なし：Book='${book}' / WorkCord='${wc}'\n（型・全角/半角・数値/文字の違いも確認してください）`, false, 404);
    }

    // 4) 見つかった → インターフェース詳細へ recordId 付きで 302
    const dest = `https://airtable.com/${AIRTABLE_BASE}/interfaces/${PAGE_ID}?recordId=${rec.id}`;
    return Response.redirect(dest, 302);

  } catch (e) {
    console.error('Function crashed:', e);
    return html(`関数内エラー：${String(e)}`, false, 500);
  }
}
