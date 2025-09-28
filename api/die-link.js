export const config = { runtime: 'edge' };

const AIRTABLE_BASE = 'appwAnJP9OOZ3MVF5';
const TABLE_NAME    = 'TableJuchu';

// ここに「/interfaces の後ろ全部」または「pag…だけ」を入れる
const INTERFACE_PATH_OR_PAGEID = 'pagvlY8ISJVIQYsnP'; // ← 今は pag だけでOK。後で pgl.../pages/pag... に差し替え可

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

function buildInterfaceUrl(baseId, pathOrPag, recordId) {
  const p = (pathOrPag || '').trim();

  // 1) 推奨：pgl.../pages/pag... 形式
  if (/^(?:pgl)[A-Za-z0-9]+\/pages\/pag[A-Za-z0-9]+$/.test(p)) {
    return `https://airtable.com/${baseId}/interfaces/${p}?recordId=${encodeURIComponent(recordId)}`;
  }
  // 2) 代替：pag... だけ（編集URLではなく閲覧用の短縮パス）
  if (/^pag[A-Za-z0-9]+$/.test(p)) {
    // 編集画面は /edit が付くが、閲覧は付かない。?recordId はそのまま使える。
    return `https://airtable.com/${baseId}/${p}?recordId=${encodeURIComponent(recordId)}`;
  }
  // 3) 不正
  return null;
}

export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);

    // recordId直指定（テストしやすい）
    const recIdDirect = (searchParams.get('recordId') || '').trim();
    if (recIdDirect) {
      const dest = buildInterfaceUrl(AIRTABLE_BASE, INTERFACE_PATH_OR_PAGEID, recIdDirect);
      if (!dest) {
        return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です。\n` +
                    `例）pglXXXX/pages/pagYYYY もしくは pagYYYY`, false, 500);
      }
      // 確認用: &dry=1 でURLだけ表示
      if ((searchParams.get('dry') || '') === '1') return html(`Would redirect to:\n${dest}`, true, 200);
      return Response.redirect(dest, 302);
    }

    // 検索パラメータ（?book=...&wc=...）
    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    if (!book || !wc) return html('パラメータ不足：?book=○○&wc=□□ もしくは ?recordId=recXXXX を指定してください。', false, 400);

    if (!TOKEN) return html('サーバ設定エラー：AIRTABLE_TOKEN 未設定（保存後は再デプロイが必要）', false, 500);

    // Airtable検索
    const wcExpr  = WORKCORD_IS_NUMBER ? wc : `'${wc.replace(/'/g,"\\'")}'`;
    const formula = `AND({Book}='${book.replace(/'/g,"\\'")}',{WorkCord}=${wcExpr})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.status !== 200) return html(`検索失敗：HTTP ${r.status}\n${(await r.text()).slice(0,800)}`, false, 502);

    const j = await r.json();
    const rec = (j.records || [])[0];
    if (!rec) return html(`該当なし：Book='${book}' / WorkCord='${wc}'`, false, 404);

    const dest = buildInterfaceUrl(AIRTABLE_BASE, INTERFACE_PATH_OR_PAGEID, rec.id);
    if (!dest) {
      return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です。\n` +
                  `例）pglXXXX/pages/pagYYYY もしくは pagYYYY`, false, 500);
    }
    if ((searchParams.get('dry') || '') === '1') return html(`Would redirect to:\n${dest}`, true, 200);
    return Response.redirect(dest, 302);

  } catch (e) {
    return html(`関数内エラー：${String(e?.message || e)}`, false, 500);
  }
}
