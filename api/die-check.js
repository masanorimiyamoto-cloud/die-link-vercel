// pages/api/die-check.js
export const config = { runtime: 'edge' };

/** ===== 設定 ===== */
const AIRTABLE_BASE  = 'appwAnJP9OOZ3MVF5';   // ← あなたの app...
const TABLE_NAME     = 'TableJuchu';          // ← あなたのテーブル名
const BOOK_FIELD     = 'Book';
const WORKCORD_FIELD = 'WorkCord';
const NAME_FIELD     = 'Name';                // ★ 追加：表示したいフィールド
const WORKCORD_IS_NUMBER = true;

// 納期として優先的に探すフィールド名（あれば従来通り拾う）
const DUE_FIELD_CANDIDATES = ['納期', 'Due', 'DueDate', 'WorkDay', 'DeliveryDate'];

const TOKEN = process.env.AIRTABLE_TOKEN;

/** ===== ユーティリティ ===== */
function renderHTML({ ok, title, lines = [], code = 200 }) {
  const color = ok ? '#0a0' : '#c00';
  const body  = [
    `<!doctype html><meta charset="utf-8">`,
    `<body style="font-family:system-ui;padding:24px;line-height:1.7">`,
    `<h1 style="color:${color};font-size:28px;margin:0 0 12px">${title}</h1>`,
    ...lines.map(l => `<div style="font-size:16px">${l}</div>`),
    `<p style="margin-top:20px"><a href="javascript:history.back()">← 戻る</a></p>`,
    `</body>`
  ].join('\n');
  return new Response(body, { status: code, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function renderJSON(payload, code = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fmtDateLike(v) {
  if (!v) return '';
  const dt = new Date(v);
  if (!isNaN(dt.getTime())) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

function pickDueField(fields) {
  for (const key of DUE_FIELD_CANDIDATES) {
    if (key in fields && fields[key] != null && fields[key] !== '') return { key, value: fields[key] };
  }
  return null;
}

// Name 文字列の簡易パーサ（任意。書式に合わせて調整可）
function parseNameInfo(nameText) {
  if (!nameText) return {};
  const t = String(nameText);

  // 例: 「製品名:XXX 数量:123 納期:2025/10/02」などから拾う素朴な正規表現
  const prodMatch = t.match(/(?:製品名|品名|Product)\s*[:：]\s*([^\s,，／/]+)|^([^\s,，／/]+)/);
  const qtyMatch  = t.match(/(?:数量|Qty|量)\s*[:：]?\s*([0-9,]+)\s*(?:個|枚|set|ｾｯﾄ)?/i);
  const dueMatch  = t.match(/(?:納期|Due|納入日|納品日)\s*[:：]?\s*([0-9]{2,4}[\/\-年\.][0-9]{1,2}[\/\-月\.][0-9]{1,2}日?)/);

  const product = prodMatch ? (prodMatch[1] || prodMatch[2]) : undefined;
  const quantity = qtyMatch ? qtyMatch[1].replace(/,/g, '') : undefined;
  const dueFree = dueMatch ? dueMatch[1] : undefined;

  return {
    product,
    quantity: quantity ? Number(quantity) : undefined,
    dueTextFromName: dueFree ? fmtDateLike(dueFree) : undefined,
  };
}

/** ===== Handler ===== */
export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const wantJSON = (searchParams.get('json') || '') === '1';

    if (!TOKEN) {
      const msg = 'サーバ設定エラー：AIRTABLE_TOKEN が未設定です（Vercel → Environment Variables に追加後、再デプロイ）。';
      return wantJSON ? renderJSON({ ok: false, error: msg }, 500) : renderHTML({ ok: false, title: 'NG', lines: [msg], code: 500 });
    }

    // recordId 直指定
    const recordId = (searchParams.get('recordId') || '').trim();
    if (recordId) {
      const rec = await fetchRecordById(recordId);
      if (!rec) {
        const msg = `指定のレコードが見つかりません：${recordId}`;
        return wantJSON ? renderJSON({ ok: false, error: msg }, 404) : renderHTML({ ok: false, title: '該当なし', lines: [msg], code: 404 });
      }
      return respondOk(rec, { wantJSON });
    }

    // book & wc 検索
    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    if (!book || !wc) {
      const msg = 'パラメータ不足：?book=〇〇&wc=□□  または  ?recordId=recXXXX を指定してください。';
      return wantJSON ? renderJSON({ ok: false, error: msg }, 400) : renderHTML({ ok: false, title: 'NG', lines: [msg], code: 400 });
    }

    const recs = await fetchByBookAndWc(book, wc);
    if (recs.length === 0) {
      const msg = `該当なし：${BOOK_FIELD}='${book}' / ${WORKCORD_FIELD}='${wc}'`;
      return wantJSON ? renderJSON({ ok: false, error: msg }, 404) : renderHTML({ ok: false, title: '該当なし', lines: [msg], code: 404 });
    }
    if (recs.length > 1) {
      const msg = `複数件ヒット：${recs.length} 件\n（${BOOK_FIELD} と ${WORKCORD_FIELD} の一意性を確認してください）`;
      return wantJSON ? renderJSON({ ok: false, error: msg, hits: recs.map(r => r.id) }, 409)
                      : renderHTML({ ok: false, title: '複数ヒット', lines: [msg], code: 409 });
    }

    return respondOk(recs[0], { wantJSON });

  } catch (e) {
    const msg = `関数内エラー：${String(e?.message || e)}`;
    return renderHTML({ ok: false, title: 'NG', lines: [msg], code: 500 });
  }
}

/** ===== Airtable helpers ===== */
async function fetchRecordById(recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}/${encodeURIComponent(recordId)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (r.status === 200) return r.json();
  return null;
}

async function fetchByBookAndWc(book, wc) {
  const wcExpr = WORKCORD_IS_NUMBER ? wc : `'${wc.replace(/'/g, "\\'")}'`;
  const formula = `AND({${BOOK_FIELD}}='${book.replace(/'/g, "\\'")}',{${WORKCORD_FIELD}}=${wcExpr})`;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?maxRecords=2&filterByFormula=${encodeURIComponent(formula)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`Airtable API エラー: HTTP ${r.status} / ${text.slice(0, 400)}`);
  }
  const j = await r.json();
  return j.records || [];
}

/** ===== 共通の成功レスポンス ===== */
function respondOk(rec, { wantJSON }) {
  const f = rec.fields || {};

  // 納期フィールド（優先）
  const due = pickDueField(f);
  const dueText = due ? fmtDateLike(due.value) : '(納期フィールド未設定)';

  // ★ Name の表示と簡易抽出
  const nameRaw = (f[NAME_FIELD] ?? '').toString();
  const parsed = parseNameInfo(nameRaw);

  if (wantJSON) {
    return renderJSON({
      ok: true,
      message: 'この抜型は正しいです。',
      recordId: rec.id,
      book: f[BOOK_FIELD] ?? null,
      workcord: f[WORKCORD_FIELD] ?? null,
      name: nameRaw || null,
      // 追加情報（取れた場合のみ）
      parsedFromName: {
        product: parsed.product ?? null,
        quantity: parsed.quantity ?? null,
        due: parsed.dueTextFromName ?? null,
      },
      dueField: due?.key || null,
      due: dueText,
    }, 200);
  }

  // HTML表示
  const lines = [
    `<b>Record ID:</b> ${rec.id}`,
    `<b>${BOOK_FIELD}:</b> ${f[BOOK_FIELD] ?? ''}`,
    `<b>${WORKCORD_FIELD}:</b> ${f[WORKCORD_FIELD] ?? ''}`,
    `<b>${NAME_FIELD}:</b> ${nameRaw || '(未設定)'}`,                // ★ 追加表示
    `<b>納期:</b> ${parsed.dueTextFromName || dueText}`,            // Nameに納期があればそれを優先表示
  ];

  // Nameから製品名/数量が取れていれば補助表示
  if (parsed.product)  lines.splice(3, 0, `<b>製品名(推定):</b> ${parsed.product}`);
  if (parsed.quantity) lines.splice(4, 0, `<b>数量(推定):</b> ${parsed.quantity.toLocaleString()}`);

  return renderHTML({ ok: true, title: 'この抜型は正しいです', lines, code: 200 });
}
