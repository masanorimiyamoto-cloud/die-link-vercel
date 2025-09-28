export const config = { runtime: 'edge' };

const AIRTABLE_BASE = 'appwAnJP9OOZ3MVF5';
const TABLE_NAME    = 'TableJuchu';
const INTERFACE_PATH_OR_PAGEID = 'pagvlY8ISJVIQYsnP';
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

  if (/^(?:pgl)[A-Za-z0-9]+\/pages\/pag[A-Za-z0-9]+$/.test(p)) {
    return `https://airtable.com/${baseId}/interfaces/${p}?recordId=${encodeURIComponent(recordId)}`;
  }
  if (/^pag[A-Za-z0-9]+$/.test(p)) {
    return `https://airtable.com/${baseId}/${p}?recordId=${encodeURIComponent(recordId)}`;
  }
  return null;
}

export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);

    // recordId直指定
    const recIdDirect = (searchParams.get('recordId') || '').trim();
    if (recIdDirect) {
      const dest = buildInterfaceUrl(AIRTABLE_BASE, INTERFACE_PATH_OR_PAGEID, recIdDirect);
      if (!dest) {
        return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です。\n` +
                    `例）pglXXXX/pages/pagYYYY もしくは pagYYYY`, false, 500);
      }
      if ((searchParams.get('dry') || '') === '1') return html(`Would redirect to:\n${dest}`, true, 200);
      return Response.redirect(dest, 302);
    }

    // 検索パラメータ
    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    if (!book || !wc) return html('パラメータ不足：?book=○○&wc=□□ もしくは ?recordId=recXXXX を指定してください。', false, 400);

    if (!TOKEN) return html('サーバ設定エラー：AIRTABLE_TOKEN 未設定', false, 500);

    // Airtable検索 - 修正箇所
    let wcExpr;
    if (WORKCORD_IS_NUMBER) {
      // 数値の場合はそのまま
      wcExpr = wc;
    } else {
      // 文字列の場合はダブルクォートで囲む
      wcExpr = `"${wc.replace(/"/g, '\\"')}"`;
    }
    
    const formula = `AND({Book}="${book.replace(/"/g, '\\"')}", {WorkCord}=${wcExpr})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}`;

    console.log('検索URL:', url); // デバッグ用

    const r = await fetch(url, { 
      headers: { 
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      } 
    });
    
    if (r.status !== 200) {
      const errorText = await r.text();
      console.error('Airtable APIエラー:', errorText);
      return html(`検索失敗：HTTP ${r.status}\n${errorText.slice(0,800)}`, false, 502);
    }

    const j = await r.json();
    console.log('検索結果:', JSON.stringify(j, null, 2)); // デバッグ用
    
    const rec = (j.records || [])[0];
    if (!rec) {
      return html(`該当なし：Book='${book}' / WorkCord='${wc}'\n検索式: ${formula}`, false, 404);
    }

    const dest = buildInterfaceUrl(AIRTABLE_BASE, INTERFACE_PATH_OR_PAGEID, rec.id);
    if (!dest) {
      return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です。`, false, 500);
    }
    
    if ((searchParams.get('dry') || '') === '1') return html(`Would redirect to:\n${dest}`, true, 200);
    return Response.redirect(dest, 302);

  } catch (e) {
    console.error('エラー:', e);
    return html(`関数内エラー：${String(e?.message || e)}`, false, 500);
  }
}