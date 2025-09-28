export const config = { runtime: 'edge' };

const AIRTABLE_BASE = 'appwAnJP9OOZ3MVF5';
const TABLE_NAME    = 'TableJuchu';
const WORKCORD_IS_NUMBER = true;
const TOKEN = process.env.AIRTABLE_TOKEN;

function html(title, message, isSuccess = true) {
  const color = isSuccess ? '#0a0' : '#c00';
  const bgColor = isSuccess ? '#f0fff0' : '#fff0f0';
  
  return new Response(
    `<!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${title}</title>
      <style>
        body {
          font-family: system-ui, -apple-system, sans-serif;
          padding: 24px;
          background-color: ${bgColor};
          margin: 0;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
        }
        .container {
          max-width: 600px;
          width: 100%;
          text-align: center;
        }
        .status {
          color: ${color};
          font-size: 32px;
          font-weight: bold;
          margin: 0 0 20px 0;
        }
        .message {
          background: white;
          padding: 24px;
          border-radius: 12px;
          border: 2px solid ${color};
          margin: 0 0 20px 0;
          white-space: pre-wrap;
          font-size: 16px;
          line-height: 1.6;
        }
        .info-box {
          background: #f8f9fa;
          padding: 16px;
          border-radius: 8px;
          margin: 16px 0;
          border-left: 4px solid ${color};
        }
        .back-button {
          background: ${color};
          color: white;
          padding: 12px 24px;
          border: none;
          border-radius: 6px;
          font-size: 16px;
          cursor: pointer;
          text-decoration: none;
          display: inline-block;
        }
        .back-button:hover {
          opacity: 0.9;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="status">${isSuccess ? '✅ 正しい抜型です' : '❌ 確認が必要'}</div>
        <div class="message">${message}</div>
        <a href="javascript:history.back()" class="back-button">← 別の抜型を確認</a>
      </div>
    </body>
    </html>`,
    { 
      status: isSuccess ? 200 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8' } 
    }
  );
}

export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    
    // 検索パラメータ
    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    
    if (!book || !wc) {
      return html(
        'パラメータ不足',
        '以下のパラメータを指定してください：\n\n?book=○○&wc=□□\n\n例：?book=Ko&wc=5402',
        false
      );
    }

    if (!TOKEN) {
      return html(
        'システムエラー',
        'サーバ設定エラー：AIRTABLE_TOKEN 未設定\n\n管理者に連絡してください。',
        false
      );
    }

    // Airtable検索
    const formula = `AND({Book}="${book.replace(/"/g, '\\"')}", {WorkCord}=${wc})`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}`;

    const response = await fetch(url, { 
      headers: { 
        Authorization: `Bearer ${TOKEN}`,
      } 
    });

    if (!response.ok) {
      return html(
        '検索エラー',
        `Airtable APIでエラーが発生しました：\n${response.status} ${response.statusText}`,
        false
      );
    }

    const data = await response.json();
    const records = data.records || [];

    if (records.length === 0) {
      return html(
        '該当する注文が見つかりません',
        `検索条件：\n• Book: ${book}\n• WorkCord: ${wc}\n\n該当する注文データが見つかりませんでした。\n条件を確認してください。`,
        false
      );
    }

    // 最初のレコードを使用
    const record = records[0];
    const fields = record.fields || {};
    
    // 納期とその他の情報を取得
    const deliveryDate = fields['納期'] || fields['DeliveryDate'] || fields['納期日'] || '未設定';
    const productName = fields['製品名'] || fields['ProductName'] || '未設定';
    const customer = fields['顧客名'] || fields['Customer'] || '未設定';
    
    let message = `✅ この抜型は正しいです\n\n`;
    message += `【注文情報】\n`;
    message += `• Book: ${book}\n`;
    message += `• WorkCord: ${wc}\n`;
    message += `• 製品名: ${productName}\n`;
    message += `• 顧客名: ${customer}\n`;
    message += `• 納期: ${deliveryDate}\n\n`;
    
    if (records.length > 1) {
      message += `※ 注: 同じ条件で${records.length}件見つかりました\n`;
    }
    
    message += `この抜型は注文データと一致しています。`;

    return html('抜型確認完了', message, true);

  } catch (error) {
    return html(
      'システムエラー',
      `予期せぬエラーが発生しました：\n${error.message}\n\n管理者に連絡してください。`,
      false
    );
  }
}