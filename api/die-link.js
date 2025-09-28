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
        return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です`, false, 500);
      }
      if ((searchParams.get('dry') || '') === '1') return html(`Would redirect to:\n${dest}`, true, 200);
      return Response.redirect(dest, 302);
    }

    // 検索パラメータ
    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    if (!book || !wc) {
      return html('パラメータ不足：?book=○○&wc=□□ もしくは ?recordId=recXXXX を指定してください。', false, 400);
    }

    if (!TOKEN) {
      return html('サーバ設定エラー：AIRTABLE_TOKEN 未設定', false, 500);
    }

    // シンプルな検索
    const formula = `AND({Book}="${book.replace(/"/g, '\\"')}", {WorkCord}=${wc})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}`;

    console.log('Search URL:', url);

    const r = await fetch(url, { 
      headers: { 
        Authorization: `Bearer ${TOKEN}`,
      } 
    });

    if (!r.ok) {
      return html(`Airtable APIエラー：${r.status} ${r.statusText}`, false, 502);
    }

    const data = await r.json();
    const records = data.records || [];

    if (records.length === 0) {
      return html(`該当なし：Book='${book}' / WorkCord='${wc}'\n検索式: ${formula}`, false, 404);
    }

    // 最初のレコードを使用（複数ある場合は最初のもの）
    const record = records[0];
    const dest = buildInterfaceUrl(AIRTABLE_BASE, INTERFACE_PATH_OR_PAGEID, record.id);
    
    if (!dest) {
      return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です`, false, 500);
    }

    if ((searchParams.get('dry') || '') === '1') {
      let debugMsg = `Would redirect to:\n${dest}\n\n`;
      debugMsg += `検索結果: ${records.length}件見つかりました\n`;
      debugMsg += `使用レコードID: ${record.id}\n`;
      debugMsg += `検索式: ${formula}`;
      return html(debugMsg, true, 200);
    }

    return Response.redirect(dest, 302);

  } catch (error) {
    return html(`エラーが発生しました：${error.message}`, false, 500);
  }
}