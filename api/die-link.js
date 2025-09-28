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
      if (!dest) return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です`, false, 500);
      if ((searchParams.get('dry') || '') === '1') return html(`Would redirect to:\n${dest}`, true, 200);
      return Response.redirect(dest, 302);
    }

    // 検索パラメータ
    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    if (!book || !wc) return html('パラメータ不足：?book=○○&wc=□□ もしくは ?recordId=recXXXX を指定してください。', false, 400);

    if (!TOKEN) return html('サーバ設定エラー：AIRTABLE_TOKEN 未設定', false, 500);

    // 検索式
    const wcExpr = WORKCORD_IS_NUMBER ? wc : `"${wc.replace(/"/g, '\\"')}"`;
    const formula = `AND({Book}="${book.replace(/"/g, '\\"')}", {WorkCord}=${wcExpr})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=10`;

    const r = await fetch(url, { 
      headers: { 
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      } 
    });
    
    if (r.status !== 200) {
      const errorText = await r.text();
      return html(`検索失敗：HTTP ${r.status}\n${errorText.slice(0,800)}`, false, 502);
    }

    const j = await r.json();
    const records = j.records || [];
    
    if (records.length === 0) {
      return html(`該当なし：Book='${book}' / WorkCord='${wc}'`, false, 404);
    }

    // 複数件見つかった場合の処理
    let targetRecord = records[0];
    
    if (records.length > 1) {
      // 複数件ある場合は最新のレコードを選択（createdTimeでソート）
      records.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
      targetRecord = records[0];
      
      // dryモードで確認
      if ((searchParams.get('dry') || '') === '1') {
        let debugInfo = `⚠️ 複数件（${records.length}件）見つかりました\n\n`;
        debugInfo += `最新レコードを選択:\n`;
        debugInfo += `- ID: ${targetRecord.id}\n`;
        debugInfo += `- 作成日時: ${targetRecord.createdTime}\n\n`;
        debugInfo += `全レコード:\n`;
        records.forEach((rec, i) => {
          debugInfo += `${i+1}. ID: ${rec.id}, 作成: ${rec.createdTime}\n`;
          debugInfo += `   フィールド: ${JSON.stringify(rec.fields)}\n\n`;
        });
        
        const dest = buildInterfaceUrl(AIRTABLE_BASE, INTERFACE_PATH_OR_PAGEID, targetRecord.id);
        return html(`Would redirect to:\n${dest}\n\n${debugInfo}`, true, 200);
      }
    }

    const dest = buildInterfaceUrl(AIRTABLE_BASE, INTERFACE_PATH_OR_PAGEID, targetRecord.id);
    if (!dest) return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です`, false, 500);
    
    if ((searchParams.get('dry') || '') === '1') {
      const debugInfo = records.length > 1 ? 
        `⚠️ 複数件（${records.length}件）見つかりました。最新レコードを使用します。\n` : 
        `✅ 1件見つかりました。\n`;
      return html(`Would redirect to:\n${dest}\n\n${debugInfo}`, true, 200);
    }
    
    return Response.redirect(dest, 302);

  } catch (e) {
    return html(`関数内エラー：${String(e?.message || e)}`, false, 500);
  }
}