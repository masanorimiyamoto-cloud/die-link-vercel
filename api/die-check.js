// pages/api/die-check.js
export const config = { runtime: 'edge' };

/** ===== 設定 ===== */
const AIRTABLE_BASE  = 'appwAnJP9OOZ3MVF5'; // ← あなたの app...
const TABLE_NAME     = 'TableJuchu';        // ← あなたのテーブル名

// 照合キー
const BOOK_FIELD     = 'Book';
const WORKCORD_FIELD = 'WorkCord';
const WORKCORD_IS_NUMBER = true; // WorkCord が数値なら true, 文字列なら false

// 取得して並べたいフィールド（今回の要件）
const FIELD_DATE = 'Ndate';
const FIELD_ITEM = 'ItemName';
const FIELD_QTY  = 'NAmount';

const TOKEN = process.env.AIRTABLE_TOKEN;

/** ===== ユーティリティ ===== */
function renderHTML({ ok, title, html = '', code = 200 }) {
  const color = ok ? '#0a0' : '#c00';
  const body  = `<!doctype html><meta charset="utf-8">
  <body style="font-family:system-ui;padding:24px;line-height:1.6">
    <h1 style="color:${color};font-size:24px;margin:0 0 12px">${title}</h1>
    ${html}
    <p style="margin-top:16px"><a href="javascript:history.back()">← 戻る</a></p>
  </body>`;
  return new Response(body, { status: code, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function renderJSON(payload, code = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: code, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function parseQty(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function byDateAsc(a, b) {
  const da = a._dateMs ?? Number.POSITIVE_INFINITY;
  const db = b._dateMs ?? Number.POSITIVE_INFINITY;
  return da - db;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

/** ===== Airtable helpers ===== */
async function fetchRecordById(recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}/${encodeURIComponent(recordId)}?fields[]=${encodeURIComponent(FIELD_DATE)}&fields[]=${encodeURIComponent(FIELD_ITEM)}&fields[]=${encodeURIComponent(FIELD_QTY)}&fields[]=${encodeURIComponent(BOOK_FIELD)}&fields[]=${encodeURIComponent(WORKCORD_FIELD)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (r.status === 200) return r.json();
  return null;
}

async function fetchByBookAndWcAll(book, wc, limit = 100) {
  const wcExpr  = WORKCORD_IS_NUMBER ? wc : `'${wc.replace(/'/g, "\\'")}'`;
  const formula = `AND({${BOOK_FIELD}}='${book.replace(/'/g, "\\'")}',{${WORKCORD_FIELD}}=${wcExpr})`;

  // fields[] で必要最小限だけ取得
  const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}&fields[]=${encodeURIComponent(FIELD_DATE)}&fields[]=${encodeURIComponent(FIELD_ITEM)}&fields[]=${encodeURIComponent(FIELD_QTY)}&fields[]=${encodeURIComponent(BOOK_FIELD)}&fields[]=${encodeURIComponent(WORKCORD_FIELD)}&pageSize=100`;

  let results = [];
  let offset;
  while (results.length < limit) {
    const url = baseUrl + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.status !== 200) {
      const text = await r.text();
      throw new Error(`Airtable API エラー: HTTP ${r.status} / ${text.slice(0, 300)}`);
    }
    const j = await r.json();
    results = results.concat(j.records || []);
    if (!j.offset) break;
    offset = j.offset;
  }
  if (results.length > limit) results.length = limit;
  return results;
}

/** ===== 変換共通 ===== */
function mapRecord(rec) {
  const f = rec.fields || {};
  const rawDate = f[FIELD_DATE];
  const dateMs = rawDate ? Date.parse(rawDate) : NaN;

  return {
    id: rec.id,
    book: f[BOOK_FIELD] ?? null,
    workcord: f[WORKCORD_FIELD] ?? null,
    itemName: f[FIELD_ITEM] ?? null,
    amount: parseQty(f[FIELD_QTY]),
    ndate: rawDate ? fmtDate(rawDate) : null,
    _dateMs: Number.isFinite(dateMs) ? dateMs : undefined,
  };
}

/** ===== Handler ===== */
export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const wantJSON = (searchParams.get('json') || '') === '1';
    const limit = Math.max(1, Math.min(1000, Number(searchParams.get('limit') || 100)));

    if (!TOKEN) {
      const msg = 'サーバ設定エラー：AIRTABLE_TOKEN が未設定です（Vercel の環境変数に追加して再デプロイ）。';
      return wantJSON ? renderJSON({ ok: false, error: msg }, 500)
                      : renderHTML({ ok: false, title: 'NG', html: `<pre>${escapeHtml(msg)}</pre>`, code: 500 });
    }

    // 1) recordId 指定（単票表示）
    const recId = (searchParams.get('recordId') || '').trim();
    if (recId) {
      const rec = await fetchRecordById(recId);
      if (!rec) {
        const msg = `指定のレコードが見つかりません：${recId}`;
        return wantJSON ? renderJSON({ ok: false, error: msg }, 404)
                        : renderHTML({ ok: false, title: '該当なし', html: `<pre>${escapeHtml(msg)}</pre>`, code: 404 });
      }
      const row = mapRecord(rec);
      if (wantJSON) return renderJSON({ ok: true, hits: [row] }, 200);

      const html = `
        <div><b>Record ID:</b> ${escapeHtml(row.id)}</div>
        <div><b>${escapeHtml(BOOK_FIELD)}:</b> ${escapeHtml(row.book ?? '')}</div>
        <div><b>${escapeHtml(WORKCORD_FIELD)}:</b> ${escapeHtml(row.workcord ?? '')}</div>
        <div><b>${escapeHtml(FIELD_ITEM)}:</b> ${escapeHtml(row.itemName ?? '')}</div>
        <div><b>${escapeHtml(FIELD_QTY)}:</b> ${row.amount ?? ''}</div>
        <div><b>${escapeHtml(FIELD_DATE)}:</b> ${escapeHtml(row.ndate ?? '')}</div>
        <hr style="margin:16px 0">
        <div style="font-weight:bold;color:#0a0">下記の受注がありこの抜型は正しいと思われます。</div>
      `;
      return renderHTML({ ok: true, title: '照合結果', html, code: 200 });
    }

    // 2) book & wc 指定（複数可 → 納期昇順）
    const book = (searchParams.get('book') || '').trim();
    const wc   = (searchParams.get('wc')   || '').trim();
    if (!book || !wc) {
      const msg = 'パラメータ不足：?book=〇〇&wc=□□  または  ?recordId=recXXXX を指定してください。';
      return wantJSON ? renderJSON({ ok: false, error: msg }, 400)
                      : renderHTML({ ok: false, title: 'NG', html: `<pre>${escapeHtml(msg)}</pre>`, code: 400 });
    }

    const recs = await fetchByBookAndWcAll(book, wc, limit);
    if (recs.length === 0) {
      const msg = `該当なし：${BOOK_FIELD}='${book}' / ${WORKCORD_FIELD}='${wc}'`;
      return wantJSON ? renderJSON({ ok: false, error: msg }, 404)
                      : renderHTML({ ok: false, title: '該当なし', html: `<pre>${escapeHtml(msg)}</pre>`, code: 404 });
    }

    const rows = recs.map(mapRecord).sort(byDateAsc);

    if (wantJSON) {
      return renderJSON({
        ok: true,
        count: rows.length,
        book,
        workcord: wc,
        hits: rows
      }, 200);
    }

    const tableRows = rows.map(r => `
      <tr>
        <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(r.ndate ?? '')}</td>
        <td style="padding:6px 8px">${escapeHtml(r.itemName ?? '')}</td>
        <td style="padding:6px 8px;text-align:right">${r.amount ?? ''}</td>
        <td style="padding:6px 8px;white-space:nowrap;font-family:ui-monospace,monospace">${escapeHtml(r.id)}</td>
      </tr>
    `).join('');

    const html = `
      <div style="margin-bottom:8px">
        <b>${escapeHtml(BOOK_FIELD)}:</b> ${escapeHtml(book)}　
        <b>${escapeHtml(WORKCORD_FIELD)}:</b> ${escapeHtml(wc)}
      </div>
      <div style="margin:10px 0 6px;color:#0a0;font-weight:bold">この抜型は正しいです（${rows.length}件ヒット）</div>
      <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:15px">
        <thead style="background:#f7f7f7">
          <tr>
            <th style="padding:8px 10px">納期 (${escapeHtml(FIELD_DATE)})</th>
            <th style="padding:8px 10px">品名 (${escapeHtml(FIELD_ITEM)})</th>
            <th style="padding:8px 10px">数量 (${escapeHtml(FIELD_QTY)})</th>
            <th style="padding:6px 8px">Record ID</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    `;
    return renderHTML({ ok: true, title: '照合結果（納期が早い順）', html, code: 200 });

  } catch (e) {
    const msg = `関数内エラー：${String(e?.message || e)}`;
    return renderHTML({ ok: false, title: 'NG', html: `<pre>${escapeHtml(msg)}</pre>`, code: 500 });
  }
}
