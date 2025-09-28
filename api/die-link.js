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

    // デバッグ情報
    let debugInfo = `検索条件:\n- Book: "${book}"\n- WorkCord: "${wc}"\n- 数値扱い: ${WORKCORD_IS_NUMBER}\n\n`;

    // Airtable検索 - 複数の検索方法を試す
    let formulas = [];
    
    // 方法1: 元の検索式
    let wcExpr = WORKCORD_IS_NUMBER ? wc : `"${wc.replace(/"/g, '\\"')}"`;
    formulas.push(`AND({Book}="${book.replace(/"/g, '\\"')}", {WorkCord}=${wcExpr})`);
    
    // 方法2: フィールド名を変更してみる
    formulas.push(`AND({book}="${book.replace(/"/g, '\\"')}", {workcord}=${wcExpr})`);
    formulas.push(`AND({BOOK}="${book.replace(/"/g, '\\"')}", {WORKCORD}=${wcExpr})`);
    
    // 方法3: WorkCordを文字列として検索
    if (WORKCORD_IS_NUMBER) {
      formulas.push(`AND({Book}="${book.replace(/"/g, '\\"')}", {WorkCord}="${wc}")`);
    }

    let foundRecord = null;
    let lastError = '';

    for (const formula of formulas) {
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}`;
      
      debugInfo += `検索式: ${formula}\n`;
      debugInfo += `URL: ${url}\n\n`;

      try {
        const r = await fetch(url, { 
          headers: { 
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json'
          } 
        });
        
        if (r.status === 200) {
          const j = await r.json();
          debugInfo += `結果: ${j.records?.length || 0}件見つかりました\n`;
          
          if (j.records && j.records.length > 0) {
            foundRecord = j.records[0];
            debugInfo += `成功！ レコードID: ${foundRecord.id}\n`;
            break;
          }
        } else {
          const errorText = await r.text();
          debugInfo += `エラー: HTTP ${r.status} - ${errorText.slice(0,200)}\n`;
          lastError = errorText;
        }
      } catch (e) {
        debugInfo += `例外: ${e.message}\n`;
        lastError = e.message;
      }
      
      debugInfo += '---\n';
    }

    if (!foundRecord) {
      // テーブルの構造を確認するための全件取得（デバッグ用）
      try {
        const sampleUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?maxRecords=3`;
        const sampleRes = await fetch(sampleUrl, { 
          headers: { Authorization: `Bearer ${TOKEN}` } 
        });
        
        if (sampleRes.status === 200) {
          const sampleData = await sampleRes.json();
          debugInfo += `\n--- テーブルサンプルデータ ---\n`;
          sampleData.records?.forEach((rec, i) => {
            debugInfo += `レコード${i+1}:\n`;
            debugInfo += `ID: ${rec.id}\n`;
            debugInfo += `Fields: ${JSON.stringify(rec.fields, null, 2)}\n\n`;
          });
        }
      } catch (e) {
        debugInfo += `サンプル取得エラー: ${e.message}\n`;
      }
      
      return html(`該当なし：Book='${book}' / WorkCord='${wc}'\n\nデバッグ情報:\n${debugInfo}`, false, 404);
    }

    const dest = buildInterfaceUrl(AIRTABLE_BASE, INTERFACE_PATH_OR_PAGEID, foundRecord.id);
    if (!dest) return html(`設定エラー：INTERFACE_PATH_OR_PAGEID が不正です`, false, 500);
    
    if ((searchParams.get('dry') || '') === '1') return html(`Would redirect to:\n${dest}\n\nデバッグ情報:\n${debugInfo}`, true, 200);
    return Response.redirect(dest, 302);

  } catch (e) {
    return html(`関数内エラー：${String(e?.message || e)}`, false, 500);
  }
}