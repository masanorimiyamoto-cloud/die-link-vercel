// pages/api/die-check.js
export const config = { runtime: 'edge' };

/* ===========================================================
   セキュア版 die-check：URL直叩きを禁止し、社内ページ → POST のみ許可
   - GETクエリ (?book=&wc= / ?recordId=) は受け付けません（405/400）
   - 同一オリジン + CSRF（Cookie xcsrf とヘッダ X-CSRF の一致）を検証
   - 事前に /api/session などで xcsrf Cookie を発行してください
     （フロントで X-CSRF ヘッダにも同値を付けて POST する）
   =========================================================== */

/* =========================
   環境変数（必須）
   =========================
   - AIRTABLE_TOKEN       : Airtable Personal Access Token
   - GS_SPREADSHEET_ID    : Google Sheets の ID（/d/<ここ>/edit）
   - GS_WORKSHEET_NAME    : ワークシート名（例: wsTableCD）
   - GOOGLE_SA_JSON       : サービスアカウントの JSON 全文
    - DRIVE_FOLDER_ID      : Google Driveの図面フォルダID (die_master)
   ========================= */

// ===== Airtable 設定（受注・添付）=====
const AIRTABLE_BASE  = 'appwAnJP9OOZ3MVF5';
const TABLE_NAME     = 'TableJuchu';
const BOOK_FIELD     = 'Book';
const WORKCORD_FIELD = 'WorkCord';
const WORKCORD_IS_NUMBER = true;

const FIELD_DATE     = 'Ndate';
const FIELD_ITEM     = 'ItemName';
const FIELD_QTY      = 'NAmount';
const FIELD_KNAME    = 'Kname';
const FIELD_MATERIAL = 'Material';
const FIELD_PAPER    = 'Paper_Size';
const FIELD_CUT      = 'Cut_Size';
const FIELD_ATTACH   = '画像';

const TOKEN = process.env.AIRTABLE_TOKEN;

// ===== Google Sheets 設定（抜型の基本情報・ロケーション）=====
const GS_SPREADSHEET_ID = process.env.GS_SPREADSHEET_ID || '';
const GS_WORKSHEET_NAME = process.env.GS_WORKSHEET_NAME || 'wsTableCD';
const SA_JSON = process.env.GOOGLE_SA_JSON || '';

/* ------------------------------
   ユーティリティ
-------------------------------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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
function renderHTML({ ok, title, html = '', code = 200 }) {
  const color = ok ? '#0a0' : '#c00';
  const body  = `<!doctype html><meta charset="utf-8">
  <body style="font-family:system-ui;padding:24px;line-height:1.6">
    <h1 style="color:${color};font-size:24px;margin:0 0 12px">${title}</h1>
    ${html}
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
      <a href="/scan-multi.html" style="background:#0a0;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px">QRを再スキャン</a>
      <button onclick="if(document.referrer){history.back()}else{location.href='/scan-multi.html'}"
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
function parseCookies(req) {
  const h = req.headers.get('cookie') || '';
  const out = {};
  h.split(';').forEach(kv => {
    const [k, ...vs] = kv.split('=');
    if (!k) return;
    out[k.trim()] = decodeURIComponent((vs.join('=') || '').trim());
  });
  return out;
}
function sameOrigin(req) {
  // 自ドメインのみ許可（プレビュー/本番どちらでも有効）
  const selfOrigin = new URL(req.url).origin;
  const origin  = req.headers.get('origin')  || '';
  const referer = req.headers.get('referer') || '';
  return (origin.startsWith(selfOrigin) || referer.startsWith(selfOrigin));
}

/* ------------------------------
   Airtable helpers
-------------------------------- */
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
  const wcExpr  = WORKCORD_IS_NUMBER ? wc : `'${String(wc).replace(/'/g, "\\'")}'`;
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

function mapRecord(rec) {
  const f = rec.fields || {};
  const rawDate = f[FIELD_DATE];
  const dateMs = rawDate ? Date.parse(rawDate) : NaN;

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

function renderAttachmentsHTML(attachments) {
  if (!attachments || !attachments.length) return '<span style="color:#666">（添付なし）</span>';
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
  const more = attachments.length > 3 ? `<div style="color:#666">…他 ${attachments.length-1} 件</div>` : '';
  return `<div style="display:flex;align-items:flex-start;flex-wrap:wrap;gap:4px">${items}${more}</div>`;
}

/* ------------------------------
   Google Sheets helpers
   - wsTableCD のヘッダは以下想定：
     A:WorkCord B:ItemName C:BookName D:Kname E:Material F:Paper_Size G:Cut_Size
     H:Location I:LastSeen J:Ndate
-------------------------------- */

// base64url utils（Edge Runtime互換：Bufferなし）
function bytesToBase64Url(bytes) {
  let bin = '';
  const len = bytes.length;
  for (let i = 0; i < len; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function utf8ToBase64Url(str) {
  const enc = new TextEncoder();
  return bytesToBase64Url(enc.encode(str));
}

async function getGoogleAccessToken() {
  if (!SA_JSON) throw new Error('GOOGLE_SA_JSON が未設定です');
  const svc = JSON.parse(SA_JSON);
  const email = svc.client_email;
  const keyPem = svc.private_key;

  const now = Math.floor(Date.now()/1000);
  const claim = {
    iss: email,
    // 🔽 [修正] Driveの読み取り権限 (drive.readonly) をスコープに追加
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const headerB64 = utf8ToBase64Url('{"alg":"RS256","typ":"JWT"}');
  const payloadB64 = utf8ToBase64Url(JSON.stringify(claim));
  const unsigned = `${headerB64}.${payloadB64}`;

  const pkcs8 = pemToArrayBuffer(keyPem);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const signatureB64 = bytesToBase64Url(new Uint8Array(sigBuf));
  const jwt = `${unsigned}.${signatureB64}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'content-type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  if (r.status !== 200) throw new Error(`Google token error ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i=0;i<raw.length;i++) view[i] = raw.charCodeAt(i);
  return buf;
}

async function fetchSheetRowByBookWc(book, wc) {
  if (!GS_SPREADSHEET_ID) throw new Error('GS_SPREADSHEET_ID が未設定です');
  const token = await getGoogleAccessToken();
  const range = encodeURIComponent(`${GS_WORKSHEET_NAME}!A1:Z10000`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GS_SPREADSHEET_ID}/values/${range}`;
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${token}` } });
  if (r.status !== 200) throw new Error(`Sheets API ${r.status} ${await r.text()}`);
  const j = await r.json();
  const rows = j.values || [];
  if (!rows.length) return null;

  const hdr = rows[0];
  const idx = Object.fromEntries(hdr.map((h,i)=>[h,i]));
  const get = (row, name)=> (idx[name]!=null && idx[name] < row.length) ? row[idx[name]] : '';

  const normWC = (v)=>{ const n=Number(v); return Number.isFinite(n)?String(n):String(v||'').trim(); };
  const wantBook = String(book||'').trim();

  for (const row of rows.slice(1)) {
    const rcWc   = normWC(get(row,'WorkCord'));
    const rcBook = String(get(row,'BookName')||'').trim();
    if (rcWc === normWC(wc) && rcBook === wantBook) {
      return {
        WorkCord : rcWc,
        BookName : rcBook,
        ItemName : get(row,'WorkName'),
        Kname    : get(row,'Kname'),
        Material : get(row,'Material'),
        Paper_Size: get(row,'Paper_Size'),
        Cut_Size : get(row,'Cut_Size'),
        Location : get(row,'Location'),
        LastSeen : get(row,'LastSeen'),
        Ndate    : get(row,'Ndate'),
      };
    }
  }
  return null;
}

/* ------------------------------
   Google Drive helpers (★★ 追加 ★★)
-------------------------------- */
async function fetchDrawingLinkFromDrive(book, wc) {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    console.warn('環境変数 DRIVE_FOLDER_ID が未設定のため Drive 検索をスキップします');
    return null;
  }
  if (!book || !wc) return null;

  try {
    const token = await getGoogleAccessToken();
    
    // 検索ファイル名 (例: "Ta-2356")
    // 拡張子は検索に含めません
    const searchName = `${book}-${wc}`;

    // 検索クエリ:
    // 1. 指定のフォルダ (die_master) の中にあり
    // 2. ファイル名に "Ta-2356" を含み
    // 3. ゴミ箱に入っていない
    const q = `'${folderId}' in parents and name contains '${searchName}' and trashed = false`;

    const params = new URLSearchParams({
      q: q,
      fields: 'files(id, name, webViewLink)', // 閲覧リンク, ファイル名, ID
      pageSize: 1, // 1件見つかればOK
      orderBy: 'name', // 安定した結果を得るため
    });

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (r.status !== 200) {
      throw new Error(`Google Drive API エラー ${r.status}: ${await r.text()}`);
    }

    const j = await r.json();
    if (j.files && j.files.length > 0) {
      // 見つかったファイルの閲覧リンク (webViewLink) を返す
      return j.files[0].webViewLink;
    }
    
    // 見つからなかった場合
    return null;

  } catch (e) {
    console.error('Google Drive 検索エラー:', e.message);
    return null; // エラー時もメイン処理は続行
  }
}


/* ------------------------------
   本体：POST + 同一オリジン + CSRF検証
-------------------------------- */
export default async function handler(req) {
  try {
    // 1) メソッド & トークン
    if (req.method !== 'POST') {
      return renderHTML({ ok:false, title:'NG', html:'<pre>POSTのみ許可</pre>', code:405 });
    }
    if (!TOKEN) {
      const msg = 'AIRTABLE_TOKEN が未設定です（Vercel 環境変数）。';
      return renderHTML({ ok:false, title:'NG', html:`<pre>${escapeHtml(msg)}</pre>`, code:500 });
    }

    // 2) 同一オリジン & CSRF 検証
    if (!sameOrigin(req)) {
      return renderHTML({ ok:false, title:'NG', html:'<pre>Origin/Referer 不一致</pre>', code:403 });
    }
    const cookies = parseCookies(req);
    const csrfCookie = cookies['xcsrf'] || '';
    const csrfHeader = req.headers.get('x-csrf') || '';
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      return renderHTML({ ok:false, title:'NG', html:'<pre>CSRF 検証NG</pre>', code:403 });
    }

    // 3) JSON ボディ
    let body = {};
    try { body = await req.json(); } catch {}
    const wantJSON = body?.json === 1 || body?.json === true;
    const limit = Math.max(1, Math.min(1000, Number(body?.limit ?? 100)));

    // 4) recordId 指定（単票）
    const recId = (body?.recordId || '').trim();
    if (recId) {
      const rec = await fetchRecordById(recId);
      if (!rec) {
        const msg = `指定のレコードが見つかりません：${recId}`;
        return wantJSON ? renderJSON({ ok:false, error: msg }, 404)
                        : renderHTML({ ok:false, title:'該当なし', html:`<pre>${escapeHtml(msg)}</pre>`, code:404 });
      }
      const row = mapRecord(rec);

      // 可能なら Google Sheets 情報も付与
      let gs = null;
      let driveLink = null; // (単票でもDrive検索を追加)
      if (row.book && row.workcord != null) {
        try { gs = await fetchSheetRowByBookWc(row.book, row.workcord); } catch {}
        if (process.env.DRIVE_FOLDER_ID) {
          try { driveLink = await fetchDrawingLinkFromDrive(row.book, row.workcord); } catch {}
        }
      }

      if (wantJSON) return renderJSON({ ok:true, hits:[row], gs, drawingLink: driveLink }, 200);

      const gsHtml = gs ? `
        <h3 style="margin:14px 0 6px">Google Sheets 情報</h3>
        <div><b>Location:</b> ${escapeHtml(gs.Location || '')}</div>
        <div><b>LastSeen:</b> ${escapeHtml(gs.LastSeen || '')}</div>
        <div><b>ItemName:</b> ${escapeHtml(gs.ItemName || '')}</div>
        <div><b>Kname:</b> ${escapeHtml(gs.Kname || '')}</div>
        <div><b>Material:</b> ${escapeHtml(gs.Material || '')}</div>
        <div><b>Paper_Size:</b> ${escapeHtml(gs.Paper_Size || '')}</div>
        <div><b>Cut_Size:</b> ${escapeHtml(gs.Cut_Size || '')}</div>
      ` : `<div style="color:#666">（Google Sheets に一致行なし）</div>`;

      // (単票用 Drive HTML)
      const driveHtml = driveLink ? `
        <h3 style="margin:14px 0 6px">Google Drive マスター図面</h3>
        <a href="${escapeHtml(driveLink)}" target="_blank" rel="noopener noreferrer" style="font-weight:bold;color:#005a9c;">
          マスター図面を開く (Drive)
        </a>
      ` : '';

      const html = `
        <div><b>Kname:</b> ${escapeHtml(row.kname ?? '')}</div>
        <div><b>${escapeHtml(BOOK_FIELD)}:</b> ${escapeHtml(row.book ?? '')}</div>
        <div><b>${escapeHtml(WORKCORD_FIELD)}:</b> ${escapeHtml(row.workcord ?? '')}</div>
        <div><b>${escapeHtml(FIELD_ITEM)}:</b> ${escapeHtml(row.itemName ?? '')}</div>
        <div><b>${escapeHtml(FIELD_QTY)}:</b> ${row.amount ?? ''}</div>
        <div><b>${escapeHtml(FIELD_DATE)}:</b> ${escapeHtml(row.ndate ?? '')}</div>
        <div style="margin-top:10px"><b>${escapeHtml(FIELD_MATERIAL)}:</b> ${escapeHtml(row.material ?? '')}</div>
        <div><b>${escapeHtml(FIELD_PAPER)}:</b> ${escapeHtml(row.paperSize ?? '')}</div>
        <div><b>${escapeHtml(FIELD_CUT)}:</b> ${escapeHtml(row.cutSize ?? '')}</div>
        <div style="margin-top:10px"><b>${escapeHtml(FIELD_ATTACH)}:</b></div>
        ${renderAttachmentsHTML(row.attachments)}
        <hr style="margin:16px 0">
        ${gsHtml}
        ${driveHtml}         <hr style="margin:16px 0">
        <div style="font-weight:bold;color:#0a0">この抜型を使用する注文があります。</div>
      `;
      return renderHTML({ ok:true, title:'照合結果（単票）', html, code:200 });
    }

    // 5) book & wc 指定（複数行 → 納期昇順）
    const book = (body?.book || '').trim();
    const wc   = (body?.wc   || '').trim();
    if (!book || !wc) {
      const msg = 'パラメータ不足：{ book, wc } または { recordId } をJSONでPOSTしてください。';
      return wantJSON ? renderJSON({ ok:false, error: msg }, 400)
                      : renderHTML({ ok:false, title:'NG', html:`<pre>${escapeHtml(msg)}</pre>`, code:400 });
    }

    // Google Sheets 基本情報
    let gsRow = null;
    try { gsRow = await fetchSheetRowByBookWc(book, wc); } catch {}

    // 🔽 [ここから変更] 🔽
    // Google Drive マスター図面
    let driveLink = null;
    if (process.env.DRIVE_FOLDER_ID) { // DriveのIDが設定されている場合のみ実行
      try { driveLink = await fetchDrawingLinkFromDrive(book, wc); } catch {}
    }
    // 🔼 [ここまで変更] 🔼

    // Airtable 受注
    const recs = await fetchByBookAndWcAll(book, wc, limit);
    if (recs.length === 0) {

      // 🔽 [ここから変更] 🔽
      // DriveリンクのHTMLを生成
      const driveHtml = driveLink
        ? `<div style="margin:12px 0;padding:10px;border:1px solid #1c7ed6;border-radius:8px;background:#f0f8ff">
             <div style="font-weight:700;margin-bottom:6px">Google Drive マスター図面</div>
             <a href="${escapeHtml(driveLink)}" target="_blank" rel="noopener noreferrer" style="font-weight:bold;color:#005a9c;">
               マスター図面を開く (Drive)
             </a>
           </div>`
        : '';

      if (gsRow || driveLink) { // [修正] gsRow または driveLink があれば
        const htmlGs = `
          <div style="margin-bottom:8px">
            <b>${escapeHtml(BOOK_FIELD)}:</b> ${escapeHtml(book)}　
            <b>${escapeHtml(WORKCORD_FIELD)}:</b> ${escapeHtml(wc)}
          </div>
          ${gsRow ? `
          <div style="margin:6px 0 12px;padding:10px;border:1px solid #eee;border-radius:8px;background:#fafcff">
            <div style="font-weight:700;margin-bottom:6px">Google Sheets 情報（wsTableCD）</div>
            <div><b>ItemName:</b> ${escapeHtml(gsRow.ItemName || '')}</div>
            <div><b>Kname:</b> ${escapeHtml(gsRow.Kname || '')}</div>
            <div><b>Material:</b> ${escapeHtml(gsRow.Material || '')}</div>
            <div><b>Paper_Size:</b> ${escapeHtml(gsRow.Paper_Size || '')}</div>
            <div><b>Cut_Size:</b> ${escapeHtml(gsRow.Cut_Size || '')}</div>
            <div><b>Location:</b> ${escapeHtml(gsRow.Location || '')}</div>
            <div><b>LastSeen:</b> ${escapeHtml(gsRow.LastSeen || '')}</div>
            <div><b>Ndate:</b> ${escapeHtml(gsRow.Ndate || '')}</div>
          </div>
        ` : ''}

        ${driveHtml}           
          <div style="color:#b36; font-weight:700; margin-top: 12px;">
            この抜型に紐づく受注は見つかりませんでした（Airtable 0件）。
          </div>
        `;
        return wantJSON
          ? renderJSON({ ok:true, count:0, book, workcord: wc, gs: gsRow, hits: [], drawingLink: driveLink }, 200) // [修正] driveLink を追加
          : renderHTML({ ok:true, title:'受注なし（マスター情報あり）', html: htmlGs, code:200 }); // [修正] タイトル変更
      }
      // 🔼 [ここまで変更] 🔼


      const msg = `該当なし：${BOOK_FIELD}='${book}' / ${WORKCORD_FIELD}='${wc}'`;
      return wantJSON
        ? renderJSON({ ok:false, error: msg, gs: null, drawingLink: null }, 404) // [修正] driveLink を追加
        : renderHTML({ ok:false, title:'該当なし', html:`<pre>${escapeHtml(msg)}</pre><div style="color:#666;margin-top:6px">（Google Sheets / Drive でも一致行なし）</div>`, code:404 }); // [修正] メッセージ変更
    }

    const rows = recs.map(mapRecord).sort(byDateAsc);

    if (wantJSON) {
      return renderJSON({
        ok: true,
        count: rows.length,
        book,
        workcord: wc,
        gs: gsRow || null,
        drawingLink: driveLink, // 👈 [追加]
        hits: rows
      }, 200);
    }

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
  S       <td style="padding:6px 8px">${escapeHtml(r.kname ?? '')}</td>
        </tr>
      `;
    }).join('');

    const gsHtml = gsRow ? `
      <div style="margin:6px 0 12px;padding:8px;border:1px solid #eee;border-radius:8px;background:#fafcff">
        <div style="font-weight:700;margin-bottom:6px">Google Sheets 情報（wsTableCD）</div>
        <div><b>ItemName:</b> ${escapeHtml(gsRow.ItemName || '')}</div>
        <div><b>Kname:</b> ${escapeHtml(gsRow.Kname || '')}</div>
        <div><b>Material:</b> ${escapeHtml(gsRow.Material || '')}</div>
        <div><b>Paper_Size:</b> ${escapeHtml(gsRow.Paper_Size || '')}</div>
        <div><b>Cut_Size:</b> ${escapeHtml(gsRow.Cut_Size || '')}</div>
        <div><b>Location:</b> ${escapeHtml(gsRow.Location || '')}</div>
        <div><b>LastSeen:</b> ${escapeHtml(gsRow.LastSeen || '')}</div>
      </div>
    ` : `<div style="color:#666;margin:6px 0 12px">（Google Sheets に一致行なし）</div>`;

    // 🔽 [ここから追加] 🔽
    const driveHtml = driveLink
      ? `<div style="margin:12px 0;padding:8px;border:1px solid #1c7ed6;border-radius:8px;background:#f0f8ff">
           <div style="font-weight:700;margin-bottom:6px">Google Drive マスター図面</div>
           <a href="${escapeHtml(driveLink)}" target="_blank" rel="noopener noreferrer" style="font-weight:bold;color:#005a9c;">
             マスター図面を開く (Drive)
           </a>
         </div>`
      : '';
    // 🔼 [ここまで追加] 🔼

    const html = `
      <div style="margin-bottom:8px">
        <b>${escapeHtml(BOOK_FIELD)}:</b> ${escapeHtml(book)}{
        <b>${escapeHtml(WORKCORD_FIELD)}:</b> ${escapeHtml(wc)}
      </div>
      ${gsHtml}
      ${driveHtml}       <div style="margin:10px 0 6px;color:#0a0;font-weight:bold">この抜型を使用する受注があります（${rows.length}件ヒット）</div>
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
    return renderHTML({ ok:true, title:'照合結果（納期が早い順）', html, code:200 });

  } catch (e) {
    const msg = `関数内エラー：${String(e?.message || e)}`;
    return renderHTML({ ok:false, title:'NG', html:`<pre>${escapeHtml(msg)}</pre>`, code:500 });
  }
}