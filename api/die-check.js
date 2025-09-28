// pages/api/die-check.js
export const config = { runtime: 'edge' };

/** ===== 設定 ===== */
const AIRTABLE_BASE  = 'appwAnJP9OOZ3MVF5';   // ← あなたの app...
const TABLE_NAME     = 'TableJuchu';          // ← あなたのテーブル名
const BOOK_FIELD     = 'Book';                // ← 書籍/案件コード等のフィールド名
const WORKCORD_FIELD = 'WorkCord';            // ← 抜型をひもづけるコード
const WORKCORD_IS_NUMBER = true;              // ← 数値フィールドなら true, 文字列なら false

// 納期として優先的に探すフィールド名（先に見つかったものを採用）
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
  // ISO / yyyy-mm-dd / yyyy/mm/dd をそれっぽく整形
  const tryDate = new Date(v);
  if (!isNaN(tryDate.getTime())) {
    const y = tryDate.getFullYear();
    const m = String(tryDate.getMonth() + 1).padStart(2, '0');
    const d = String(tryDate.getDate()).padStart(2, '0');
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

/** ===== Handler =====
 * 入力：?book=〇〇&wc=□□  もしくは  ?recordId=recXXXX
 * 出力：HTML（既定） / JSON（?json=1 指定時）
 * 目的：該当が1件なら「この抜型は正しいです」＋ 納期 を返す
 */
export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const wantJSON = (searchParams.get('json') || '') === '1';

    if (!TOKEN) {
      const msg = 'サーバ設定エラー：AIRTABLE_TOKEN が未設定です（Vercel → Environment Variables に追加後、再デプロイ）。';
      return wantJSON ? renderJSON({ ok: false, error: msg }, 500) : renderHTML({ ok: false, title: 'NG', lines: [msg], code: 500 });
    }

    // 1) recordId 直指定（優先）
    const recordId = (searchParams.get('recordId') || '').trim();
    if (recordId) {
      const rec = await fetchRecordById(recordId);
      if (!rec) {
        const msg = `指定のレコードが見つかりません：${recordId}`;
        return wantJSON ? renderJSON({ ok: false, error: msg }, 404) : renderHTML({ ok: false, title: '該当なし', lines: [msg], code: 404 });
      }
      return respondOk(rec, { wantJSON });
    }

    // 2) book & wc で検索
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
  const due = pickDueField(f);
  const dueText = due ? fmtDateLike(due.value) : '(納期フィールド未設定)';

  if (wantJSON) {
    return renderJSON({
      ok: true,
      message: 'この抜型は正しいです。',
      recordId: rec.id,
      dueField: due?.key || null,
      due: dueText,
    }, 200);
  }

  return renderHTML({
    ok: true,
    title: 'この抜型は正しいです',
    lines: [
      `<b>Record ID:</b> ${rec.id}`,
      `<b>${BOOK_FIELD}:</b> ${f[BOOK_FIELD] ?? ''}`,
      `<b>${WORKCORD_FIELD}:</b> ${f[WORKCORD_FIELD] ?? ''}`,
      `<b>納期:</b> ${dueText}`,
    ],
    code: 200
  });
}
