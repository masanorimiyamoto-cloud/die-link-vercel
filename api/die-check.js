// pages/api/die-check.js
export const config = { runtime: 'edge' };

/** ===== 設定 ===== */
const AIRTABLE_BASE  = 'appwAnJP9OOZ3MVF5';
const TABLE_NAME     = 'TableJuchu';

// 照合キー
const BOOK_FIELD     = 'Book';
const WORKCORD_FIELD = 'WorkCord';
const WORKCORD_IS_NUMBER = true;

// 表示＆取得フィールド
const FIELD_DATE = 'Ndate';
const FIELD_ITEM = 'ItemName';
const FIELD_QTY  = 'NAmount';
const FIELD_KNAME = 'Kname';
const FIELD_MATERIAL  = 'Material';
const FIELD_PAPER     = 'Paper_Size';
const FIELD_CUT       = 'Cut_Size';
const FIELD_ATTACH    = '画像';

const TOKEN = process.env.AIRTABLE_TOKEN;

/** ===== ユーティリティ ===== */
function renderHTML({ ok, title, html = '', code = 200 }) {
  const color = ok ? '#0a0' : '#c00';
  const body  = `<!doctype html><meta charset="utf-8">
  <body style="font-family:system-ui;padding:24px;line-height:1.6">
    <h1 style="color:${color};font-size:24px;margin:0 0 12px">${title}</h1>
    ${html}
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
      <a href="/api/scan" style="background:#0a0;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px">QRを再スキャン</a>
      <button onclick="if(document.referrer){history.back()}else{location.href='/api/scan'}"
        style="padding:10px 14px;border-radius:8px;border:1px solid #ccc;background:#f7f7f7;cursor:pointer">
        戻る
      </button>
    </div>
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
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

/** ===== Airtable helpers ===== */
function fieldsQuery() {
  const f = [
    FIELD_DATE, FIELD_ITEM, FIELD_QTY,
    FIELD_KNAME, FIELD_MATERIAL, FIELD_PAPER, FIELD_CUT,
    FIELD_ATTACH,
    BOOK_FIELD, WORKCORD_FIELD
  ];
  return f.map(x => `fields[]=${encodeURIComponent(x)}`).join('&');
}

async function fetchRecordById(recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}/${encodeURIComponent(recordId)}?${fieldsQuery()}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (r.status === 200) return r.json();
  return null;
}

async function fetchByBookAndWcAll(book, wc, limit = 100) {
  const wcExpr  = WORKCORD_IS_NUMBER ? wc : `'${String(wc).replace(/'/g, "\\'")}'`;
  const formula = `AND({${BOOK_FIELD}}='${String(book).replace(/'/g, "\\'")}',{${WORKCORD_FIELD}}=${wcExpr})`;
  const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}&${fieldsQuery()}&pageSize=100`;

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

/** ===== 1回だけ定義する mapRecord（添付も含む） ===== */
function mapRecord(rec) {
  const f = rec.fields || {};
  const rawDate = f[FIELD_DATE];
  const dateMs = rawDate ? Date.parse(rawDate) : NaN;

  // 添付：使いやすい形へ
  const atts = Array.isArray(f[FIELD_ATTACH]) ? f[FIELD_ATTACH] : [];
  const attachments = atts.map(a => ({
    url: a.url,
    filename: a.filename,
    size: a.size,
    type: a.type,
    width: a.width,
    height: a.height,
    thumbnails: a.thumbnails || null
  }));

  return {
    id: rec.id,
    book: f[BOOK_FIELD] ?? null,
    workcord: f[WORKCORD_FIELD] ?? null,
    kname: f[FIELD_KNAME] ?? null,
    itemName: f[FIELD_ITEM] ?? null,
    amount: parseQty(f[FIELD_QTY]),
    material: f[FIELD_MATERIAL] ?? null,
    paperSize: f[FIELD_PAPER] ?? null,
    cutSize: f[FIELD_CUT] ?? null,
    attachments,
    ndate: rawDate ? fmtDate(rawDate) : null,
    _dateMs: Number.isFinite(dateMs) ? dateMs : undefined,
  };
}

/** ===== 添付HTML ===== */
function renderAttachmentsHTML(attachments) {
  if (!attachments || !attachments.length) return '<span style="color:#666">（添付なし）</span>';
  // 先頭3件を軽く表示（画像はサムネ、非画像はファイル名リンク）
  const items = attachments.slice(0, 3).map(a => {
    const isImg = String(a.type || '').startsWith('image/');
    const thumbUrl = (a.thumbnails && (a.thumbnails.small?.url || a.thumbnails.large?.url)) || a.url;
    if (isImg) {
      return `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"
                 style="display:inline-block;margin:2px">
                <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(a.filename||'')}"
                     loading="lazy" referrerpolicy="no-referrer"
                     style="height:72px;max-width:120px;object-fit:contain;border:1px solid #eee;border-radius:4px">
              </a>`;
    }
    return `<div><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
              ${escapeHtml(a.filename || '添付')}
            </a></div>`;
  }).join('');
  const more = attachments.length > 3 ? `<div style="color:#666">…他 ${attachments.length-3} 件</div>` : '';
  return `<div style="display:flex;align-items:flex-start;flex-wrap:wrap;gap:4px">${items}${more}</div>`;
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
        <div><b>Kname:</b> ${escapeHtml(row.kname ?? '')}</div>
        <div><b>${escapeHtml(BOOK_FIELD)}:</b> ${escapeHtml(row.book ?? '')}</div>
        <div><b>${escapeHtml(WORKCORD_FIELD)}:</b> ${escapeHtml(row.workcord ?? '')}</div>
        <div><b>${escapeHtml(FIELD_ITEM)}:</b> ${escapeHtml(row.itemName ?? '')}</div>
        <div><b>${escapeHtml(FIELD_QTY)}:</b> ${row.amount ?? ''}</div>
        <div><b>${escapeHtml(FIELD_DATE)}:</b> ${escapeHtml(row.ndate ?? '')}</div>
        <div style="margin-top:8px"><b>${escapeHtml(FIELD_MATERIAL)}:</b> ${escapeHtml(row.material ?? '')}</div>
        <div><b>${escapeHtml(FIELD_PAPER)}:</b> ${escapeHtml(row.paperSize ?? '')}</div>
        <div><b>${escapeHtml(FIELD_CUT)}:</b> ${escapeHtml(row.cutSize ?? '')}</div>

        <div style="margin-top:10px"><b>${escapeHtml(FIELD_ATTACH)}:</b></div>
        ${renderAttachmentsHTML(row.attachments)}

        <hr style="margin:16px 0">
        <div style="font-weight:bold;color:#0a0">この抜型を使用する注文があります。</div>
      `;
      return renderHTML({ ok: true, title: '照合結果（単票）', html, code: 200 });
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

    // 一覧：画像列を追加（先頭サムネ + 件数）
    const tableRows = rows.map(r => {
      let attachCell = '（添付なし）';
      if (r.attachments && r.attachments.length) {
        const a = r.attachments[0];
        const isImg = String(a.type||'').startsWith('image/');
        const thumb = (a.thumbnails && (a.thumbnails.small?.url || a.thumbnails.large?.url)) || a.url;
        attachCell = isImg
          ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
               <img src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"
                    style="height:40px;max-width:80px;object-fit:contain;border:1px solid #eee;border-radius:3px">
             </a>`
          : `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
               ${escapeHtml(a.filename || '添付')}
             </a>`;
        if (r.attachments.length > 1) attachCell += ` <span style="color:#666">(+${r.attachments.length-1})</span>`;
      }

      return `
        <tr>
          <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(r.ndate ?? '')}</td>
          <td style="padding:6px 8px">${escapeHtml(r.itemName ?? '')}</td>
          <td style="padding:6px 8px;text-align:right">${r.amount ?? ''}</td>
          <td style="padding:6px 8px">${escapeHtml(r.material ?? '')}</td>
          <td style="padding:6px 8px">${escapeHtml(r.paperSize ?? '')}</td>
          <td style="padding:6px 8px">${escapeHtml(r.cutSize ?? '')}</td>
          <td style="padding:6px 8px">${attachCell}</td>
          <td style="padding:6px 8px">${escapeHtml(r.kname ?? '')}</td>
        </tr>
      `;
    }).join('');

    const html = `
      <div style="margin-bottom:8px">
        <b>${escapeHtml(BOOK_FIELD)}:</b> ${escapeHtml(book)}　
        <b>${escapeHtml(WORKCORD_FIELD)}:</b> ${escapeHtml(wc)}
      </div>
      <div style="margin:10px 0 6px;color:#0a0;font-weight:bold">この抜型を使用する受注があります（${rows.length}件ヒット）</div>
      <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:15px">
        <thead style="background:#f7f7f7">
          <tr>
            <th style="padding:6px 8px">納期 (${escapeHtml(FIELD_DATE)})</th>
            <th style="padding:6px 8px">品名 (${escapeHtml(FIELD_ITEM)})</th>
            <th style="padding:6px 8px">数量 (${escapeHtml(FIELD_QTY)})</th>
            <th style="padding:6px 8px">Material</th>
            <th style="padding:6px 8px">Paper_Size</th>
            <th style="padding:6px 8px">Cut_Size</th>
            <th style="padding:6px 8px">画像</th>
            <th style="padding:6px 8px">Kname</th>
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
