// api/airtable-update-progress.js  Edge Runtime 版
// 「探す」「仕舞う」の操作に連動して TableJuchu の 進行社内/進行社外(singleSelect) を自動更新する
//
//  POST {  action: 'found' | 'stored' | 'fabric',
//          book, wc            … 単発（探す＝照合一致時／知る＝生地照合一致時）
//          items: [{book,wc,loc?}]  … 複数（仕舞う＝棚登録時）
//          loc がある item は Location（棚番号）と LastSeen（当日）も併せて更新する }
//
//  action → 更新フィールドと値:
//    found  = 抜型状況(複数選択) に 抜型照合済 を追加　＋ 抜型照合(checkbox) → ON
//             ＋ 進行社内 → 抜き作業中（照合した＝これから抜く、の合図）
//    stored = 抜型状況(複数選択) に 抜型を棚に仕舞い完了 を追加（「型まだ仕舞済でない」は除去）
//             ＋ 抜型仕舞済(checkbox) → ON
//    fabric = 進行社内 → 生地照合済　＋ 生地照合(checkbox) → ON
//             ＋ 進行社外が空白のときだけ → シート材料入荷済（値があれば触らない）
//             同一 Book/WorkCord の受注が複数あっても1行だけ更新する（pickOne）。
//             伝票済の行は除き、未照合 → 納期が近い → 作成が古い の順で選ぶ。
//             選んだ行は targets で返す（画面で品名・数量・納期を表示するため）。
//
//  matched=0 は「Airtable に（未完了の）受注が無い」。画面側で警告を出す。
//
//  2026-08-07: found/stored の書き込み先を 進行社内/進行社外 から 抜型状況 へ移した。
//  進行社外に入れていたころは、受領伝票発行可能になった後で「仕舞う」を実行すると
//  進行社外を上書きし、伝票が発行対象から永久に外れていた（Automation 5 は設定しか
//  しないので戻らない）。Airtable 側でも 進行社内/進行社外 から該当の選択肢を削除済み。
//  抜型状況は複数選択なので、照合済と仕舞い完了は同時に持てる。上書きせず追加する。
//
//  選択肢が Airtable 側に無くても typecast:true で自動作成される。
//  裏を返すと、書く値を間違えると選択肢が勝手に増える。ラベルは Airtable の
//  抜型状況(fldQBOQKnKS2TIx3s)の選択肢名と一致させること。
export const config = { runtime: 'edge' };

const AIRTABLE_PAT     = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appwAnJP9OOZ3MVF5';
const TABLE_ID         = process.env.TABLE_ID || '';
const AIRTABLE_TABLE   = process.env.AIRTABLE_TABLE || 'TableJuchu';
const TABLE_PATH       = encodeURIComponent(TABLE_ID || AIRTABLE_TABLE);
const API              = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_PATH}`;

const FIELD_BOOK     = process.env.FIELD_BOOK     || 'Book';
const FIELD_WC       = process.env.FIELD_WC       || 'WorkCord';   // number型
const FIELD_PROGRESS_OUT = process.env.FIELD_PROGRESS    || '進行社外'; // fabric で空白時のみ書く
const FIELD_PROGRESS_IN  = process.env.FIELD_PROGRESS_IN || '進行社内'; // fabric（生地照合）用
const FIELD_DIE_STATUS   = process.env.FIELD_DIE_STATUS  || '抜型状況'; // found / stored 用（複数選択）
const FIELD_ARCHIVED = process.env.FIELD_ARCHIVED || 'アーカイブ済';
const FIELD_LOCATION = process.env.FIELD_LOCATION || 'Location';
const FIELD_LASTSEEN = process.env.FIELD_LASTSEEN || 'LastSeen';
const FIELD_CHECK_DIE    = process.env.FIELD_CHECK_DIE    || '抜型照合'; // checkbox
const FIELD_CHECK_FABRIC = process.env.FIELD_CHECK_FABRIC || '生地照合'; // checkbox
const FIELD_CHECK_STORED = process.env.FIELD_CHECK_STORED || '抜型仕舞済'; // checkbox
const FIELD_ITEMNAME = process.env.FIELD_ITEMNAME || 'ItemName';
const FIELD_NAMOUNT  = process.env.FIELD_NAMOUNT  || 'NAmount';
const FIELD_NDATE    = process.env.FIELD_NDATE    || 'Ndate';

// Edge Runtime は UTC のため JST の「今日」を自前で算出
function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const STATUS_LABELS = {
  found:  process.env.PROGRESS_LABEL_FOUND  || '抜型照合済',
  stored: process.env.PROGRESS_LABEL_STORED || '抜型を棚に仕舞い完了',
  fabric: process.env.PROGRESS_LABEL_FABRIC || '生地照合済',
};
// action ごとの更新先フィールド（found/stored は抜型状況、fabric は進行社内）
const ACTION_FIELDS = {
  found:  FIELD_DIE_STATUS,
  stored: FIELD_DIE_STATUS,
  fabric: FIELD_PROGRESS_IN,
};
// 複数選択フィールドへ書く action。既存の選択を消さないよう「追加」で更新する。
const MULTI_ACTIONS = new Set(['found', 'stored']);
// 追加する値と同時に持つと矛盾する選択肢。追加時にこれらは取り除く。
// 「抜型を棚に仕舞い完了」と「型まだ仕舞済でない」の共存はあり得ないため。
const STATUS_CONFLICTS = {
  stored: [process.env.PROGRESS_LABEL_NOT_STORED || '型まだ仕舞済でない'],
};
// action ごとに併せて 進行社内(singleSelect) へ入れる値。抜型を照合した＝これから抜く、
// という現場の合図なので found のときだけ「抜き作業中」を立てる。
// 進行社内は「今どの工程か」の目安フィールドなので上書きしてよい（設計方針）。
const ACTION_PROGRESS_IN = {
  found: process.env.PROGRESS_IN_LABEL_FOUND || '抜き作業中',
};
// action ごとに 進行社外(singleSelect) が「空白のときだけ」入れる値。
// 進行社外は伝票発行の判定に使うので、既に値があれば絶対に上書きしない（8/7 の事故の再発防止）。
const ACTION_PROGRESS_OUT_IF_EMPTY = {
  fabric: process.env.PROGRESS_OUT_LABEL_FABRIC || 'シート材料入荷済',
};
// action ごとに併せてチェックする checkbox フィールド（進行が後工程で上書きされても照合履歴が残る）
const ACTION_CHECKBOX = {
  found:  FIELD_CHECK_DIE,
  fabric: FIELD_CHECK_FABRIC,
  stored: FIELD_CHECK_STORED,
};
// 同一 Book/WorkCord の受注が複数あるとき、全行ではなく1行だけ更新する action。
// 生地は受注（ロット）ごとの現物なので、1回の照合で別受注まで照合済にしない（2026-09-24 Ta/3693 の件）。
// 抜型（found/stored）は受注間で共通の型なので従来どおり全行を更新する。
const PICK_ONE_ACTIONS = new Set(['fabric']);
// 伝票まで済んだ受注は生地照合の対象外（進行社外がこれらの行は候補から外す）
const DONE_PROGRESS_OUT = new Set(
  (process.env.PROGRESS_OUT_DONE_LABELS || '完納済,完納（数量訂正）,伝票取消,伝票出力済')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// PICK_ONE の選び方: 未照合を優先 → 納期が近い順（空は最後）→ 作成が古い順
function pickOne(records, checkField) {
  const cands = records.filter(r =>
    !DONE_PROGRESS_OUT.has(String(r.fields?.[FIELD_PROGRESS_OUT] || '').trim()));
  if (!cands.length) return { picked: null, candidates: 0 };
  cands.sort((a, b) => {
    const ca = checkField && a.fields?.[checkField] === true ? 1 : 0;
    const cb = checkField && b.fields?.[checkField] === true ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const da = a.fields?.[FIELD_NDATE] || '9999-12-31';
    const db = b.fields?.[FIELD_NDATE] || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return String(a.createdTime || '').localeCompare(String(b.createdTime || ''));
  });
  return { picked: cands[0], candidates: cands.length };
}

// 画面で「どの受注を更新したか」を確かめられるよう返す要約
function describe(rec) {
  const f = rec.fields || {};
  return {
    id: rec.id,
    itemName: f[FIELD_ITEMNAME] || '',
    namount: f[FIELD_NAMOUNT] ?? null,
    ndate: f[FIELD_NDATE] || '',
  };
}

// フィールドに何が入っていても抜型ステータスで上書きする（ユーザー要望）

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-csrf',
    'content-type': 'application/json; charset=utf-8',
  };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: corsHeaders() });
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
  const selfOrigin = new URL(req.url).origin;
  const origin  = req.headers.get('origin')  || '';
  const referer = req.headers.get('referer') || '';
  return (origin.startsWith(selfOrigin) || referer.startsWith(selfOrigin));
}

// --- fetch with retry (429/5xx) ---
async function fetchWithRetry(input, init = {}) {
  const attempt = (init._attempt ?? 0) + 1;
  const r = await fetch(input, init);
  if (r.ok) return r;
  const retryable = r.status === 429 || (r.status >= 500 && r.status < 600);
  if (!retryable || attempt >= 6) return r;
  const base = 300 * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 120);
  const wait = Math.min(4000, base + jitter);
  await new Promise(res => setTimeout(res, wait));
  return fetchWithRetry(input, { ...init, _attempt: attempt });
}

// --- Airtable: Book+WorkCord で該当レコード（進行フィールドの現在値つき）を取得 ---
async function fetchRecords(book, wc, fields) {
  const esc = (s) => String(s).replace(/'/g, "\\'");
  const n = Number(wc);
  const wcExpr = Number.isFinite(n) ? String(n) : `'${esc(wc)}'`; // WorkCordはnumber型なので数値比較
  const formula =
    `AND({${FIELD_BOOK}}='${esc(book)}',{${FIELD_WC}}=${wcExpr},{${FIELD_ARCHIVED}}!=TRUE())`;

  const records = [];
  let offset;
  while (true) {
    const url = new URL(API);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('pageSize', '100');
    for (const f of fields) url.searchParams.append('fields[]', f);
    if (offset) url.searchParams.set('offset', offset);

    const r = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`list ${r.status}: ${txt}`);
    const j = JSON.parse(txt);
    (j.records || []).forEach(rec => records.push(rec));
    offset = j.offset;
    if (!offset) break;
  }
  return { records, formula };
}

// --- Airtable: batch patch (10件ずつ・typecastで選択肢を自動作成) ---
// 複数選択の追加はレコードごとに現在値へ足すため、fields はレコード単位で渡す。
async function batchUpdate(updates) {
  let updated = 0;
  for (let i = 0; i < updates.length; i += 10) {
    const slice = updates.slice(i, i + 10);
    const payload = { records: slice.map(u => ({ id: u.id, fields: u.fields })), typecast: true };

    await new Promise(res => setTimeout(res, 180));

    const r = await fetchWithRetry(API, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`patch ${r.status}: ${txt}`);
    const j = JSON.parse(txt);
    updated += (j.records || []).length;
  }
  return updated;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405);
  }
  if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID) {
    return json({ ok: false, error: 'Airtable credentials missing' }, 500);
  }

  // 同一オリジン + CSRF（/api/session が発行する xcsrf Cookie とヘッダの一致）
  if (!sameOrigin(req)) {
    return json({ ok: false, error: 'Origin/Referer 不一致' }, 403);
  }
  const cookies = parseCookies(req);
  const csrfCookie = cookies['xcsrf'] || '';
  const csrfHeader = req.headers.get('x-csrf') || '';
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return json({ ok: false, error: 'CSRF 検証NG' }, 403);
  }

  try {
    let body = {};
    try { body = await req.json(); } catch {}

    const action = String(body?.action || '').trim();
    const status = STATUS_LABELS[action];
    const progressField = ACTION_FIELDS[action];
    const checkField = ACTION_CHECKBOX[action] || '';
    const isMulti = MULTI_ACTIONS.has(action);
    const conflicts = STATUS_CONFLICTS[action] || [];
    const progressInLabel = ACTION_PROGRESS_IN[action] || '';
    const progressOutLabel = ACTION_PROGRESS_OUT_IF_EMPTY[action] || '';
    const pickOneMode = PICK_ONE_ACTIONS.has(action);
    // 現在値の比較に使うので、書き込むフィールドは全部取っておく（重複は除く）
    // pickOne では選定と画面表示用に 進行社外/品名/数量/納期 も取る
    const wantFields = Array.from(new Set(
      [progressField, checkField,
       progressInLabel ? FIELD_PROGRESS_IN : '',
       (progressOutLabel || pickOneMode) ? FIELD_PROGRESS_OUT : '',
       ...(pickOneMode ? [FIELD_ITEMNAME, FIELD_NAMOUNT, FIELD_NDATE] : [])].filter(Boolean)
    ));
    if (!status) {
      return json({ ok: false, error: `action は ${Object.keys(STATUS_LABELS).join(' / ')} を指定してください` }, 400);
    }

    // 単発 {book,wc} と 複数 {items:[...]} の両対応
    let items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length && (body?.book || body?.wc)) items = [{ book: body.book, wc: body.wc }];
    items = items
      .map(it => ({
        book: String(it?.book || '').trim(),
        wc: String(it?.wc || '').trim(),
        loc: String(it?.loc || '').trim(),
      }))
      .filter(it => it.book && it.wc);
    // 同一(book,wc)はユニーク化
    items = Array.from(new Map(items.map(it => [`${it.book}:::${it.wc}`, it])).values());
    if (!items.length) return json({ ok: false, error: 'no items (book/wc)' }, 400);

    let totalMatched = 0;
    let totalUpdated = 0;
    const skippedDetails = [];
    const targets = [];      // pickOne で選んだ行（画面表示用）
    let candidates = 0;      // pickOne の候補（未完了の受注）件数

    for (const it of items) {
      let records = [];
      try {
        const r = await fetchRecords(it.book, it.wc, wantFields);
        records = r.records;
        if (records.length === 0) {
          skippedDetails.push(`{${it.book}/${it.wc}}: 0 matches`);
          continue;
        }
      } catch (err) {
        skippedDetails.push(`{${it.book}/${it.wc}}: ERROR (${String(err?.message || err).slice(0, 200)})`);
        continue;
      }
      if (pickOneMode) {
        const p = pickOne(records, checkField);
        candidates += p.candidates;
        if (!p.picked) {
          skippedDetails.push(`{${it.book}/${it.wc}}: no open order (${records.length} done)`);
          continue;
        }
        const d = describe(p.picked);
        d.alreadyDone = checkField ? p.picked.fields?.[checkField] === true : false;
        targets.push(d);
        records = [p.picked];
      }
      totalMatched += records.length;

      // loc があれば Location（棚番号）と LastSeen（当日）も併せて更新
      const common = {};
      if (checkField) common[checkField] = true; // 照合済みチェック（進行が後で変わっても残る）
      if (progressInLabel) common[FIELD_PROGRESS_IN] = progressInLabel; // 例: found → 抜き作業中
      if (it.loc) {
        common[FIELD_LOCATION] = it.loc;
        common[FIELD_LASTSEEN] = todayJST();
      }

      const updates = [];
      for (const rec of records) {
        const raw = rec.fields?.[progressField];
        const checked = checkField ? rec.fields?.[checkField] === true : true;
        const progInOk = !progressInLabel
          || String(rec.fields?.[FIELD_PROGRESS_IN] || '').trim() === progressInLabel;
        // 進行社外は空白のときだけ埋める（レコードごとに判定）
        const fillOut = !!progressOutLabel && !String(rec.fields?.[FIELD_PROGRESS_OUT] || '').trim();
        const extra = fillOut ? { [FIELD_PROGRESS_OUT]: progressOutLabel } : {};

        if (isMulti) {
          // 複数選択。PATCH は配列ごと置き換わるので、現在値に足してから書く。
          const cur = Array.isArray(raw) ? raw.map(v => String(v).trim()).filter(Boolean) : [];
          const kept = conflicts.length ? cur.filter(v => !conflicts.includes(v)) : cur;
          const hasConflict = kept.length !== cur.length;
          const has = kept.includes(status);
          // 既に入っていても、棚番号の付け替え／矛盾する選択肢の除去があれば更新する
          if (has && checked && !it.loc && !hasConflict && progInOk && !fillOut) continue;
          const merged = has ? kept : [...kept, status];
          updates.push({ id: rec.id, fields: { ...common, ...extra, [progressField]: merged } });
        } else {
          const cur = String(raw || '').trim();
          if (cur === status && checked && !it.loc && progInOk && !fillOut) continue;
          updates.push({ id: rec.id, fields: { ...common, ...extra, [progressField]: status } });
        }
      }
      if (!updates.length) continue;

      totalUpdated += await batchUpdate(updates);
      await new Promise(r => setTimeout(r, 140));
    }

    return json({
      ok: true,
      action,
      status,
      progressIn: progressInLabel || null,   // 併せて入れた 進行社内 の値（無ければ null）
      progressOutIfEmpty: progressOutLabel || null, // 進行社外が空白の行にだけ入れた値
      targets,      // pickOne で選んだ受注（品名・数量・納期・既に照合済か）
      candidates,   // pickOne の候補数（2以上なら同品番の未完了受注が複数あった）
      matched: totalMatched,
      updated: totalUpdated,
      skippedDetails,
    }, 200);

  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
