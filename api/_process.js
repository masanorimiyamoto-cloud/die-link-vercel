// api/_process.js
// 工程完了画面（public/process.html）のサーバー処理。先頭が _ なので単独の関数にはならず、
// api/airtable-update-progress.js から呼ばれる（Vercel Hobby の関数数を増やさないため）。
//
//   action=orders   { book, wc }                 … その品番の受注一覧（ログイン不要の読み取り）
//   action=view     { view }                     … 作業リスト。Airtable のビューをそのまま読む（ログイン必須）
//                   絞り込みと並び順はビュー側の設定が効くので、条件を変えたいときは Airtable でビューを直す。
//   action=complete { id, step, variant, force } … 工程完了を記録（ログイン必須）
//   action=undo     { id, step, prev, prevRecord } … 直前の完了記録を取り消す（本人か管理者）
//
// 完了の記録は2か所に書く:
//   進行社内      … 既存の選択肢（オートン抜き完了 など）。進行社内グループの計算式や
//                   Automation がこの値を前提にしているので、今までの手入力と同じ値を入れる。
//   ○○完了記録   … 「氏名 YYYY-MM-DD HH:MM」。誰がいつ終えたかを受注表で見るため。
// typecast は使わない。選択肢名を間違えたときに勝手に選択肢が増えないよう、エラーで止める。
import { writeWorkLog, ROLE_ADMIN } from './_auth.js';

const AIRTABLE_PAT     = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appwAnJP9OOZ3MVF5';
const TABLE            = process.env.TABLE_ID || process.env.AIRTABLE_TABLE || 'TableJuchu';
const API              = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}`;

const F = {
  book: 'Book', wc: 'WorkCord', item: 'ItemName', amount: 'NAmount', ndate: 'Ndate',
  progIn: '進行社内', progOut: '進行社外', group: '進行社内グループ', kotei: '工程(自動)', archived: 'アーカイブ済',
  memo: '連絡事項',
};

// 工程ボタン＝進行社内の選択肢。名前は Airtable の選択肢名と完全一致させる（2026-10-03 統一）。
// 記録欄の名前は「選択肢名＋記録」。tag は 工程(自動) に含まれていればおすすめとして目立たせる。
// group: 'status' は完了ではない状況（材料入荷など）。画面では下に分けて出す。
// create: true は 進行社内 にまだ無い選択肢。初回だけ typecast で作らせる。
// 工程表発行済・抜き作業中・生地照合済 は印刷や照合の画面が自動で入れるので、ボタンにしない。
const CHOICES = [
  { key: 'kiji',   value: '生地カット終了', create: true },
  { key: 'o',      value: 'オートン抜き完了',     tag: 'オートン' },
  { key: 'tk',     value: '(K判)たおし抜き完了',  tag: 'たおしK判' },
  { key: 'tm',     value: '(M判)たおし抜き完了',  tag: 'たおしM判' },
  { key: 'cad',    value: 'CADカット完了',        tag: 'CAD' },
  { key: 'kami',   value: '(神)貼り完了' },
  { key: 'hana',   value: '(花)貼り完了',         tag: '花' },
  { key: 'kikai',  value: '機械貼完了',           tag: '機械貼' },
  { key: 'seal',   value: 'シール貼完了' },
  { key: 'finish', value: '仕上がりました' },
  { key: 'zairyo', value: '貼り材料入りました', group: 'status' },
  { key: 'hansei', value: '半製品あり',         group: 'status' },
  { key: 'zaiko',  value: '製品在庫から',       group: 'status' },
];
// 以前の形（工程の中に種類 variants）を保ったまま、1工程1種類で表す。画面とAPIの作りを変えずに済む。
export const STEPS = Object.fromEntries(CHOICES.map(c => [c.key, {
  label: c.value, field: c.value + '記録', group: c.group || 'done',
  variants: [{ key: '-', label: c.value, value: c.value, tag: c.tag, create: !!c.create }],
}]));
const RECORD_FIELDS = Object.values(STEPS).map(s => s.field);
// 受注の行き先がもう決まっているもの（画面では閉じた受注として薄く出す）
const CLOSED_OUT = new Set(['完納済', '完納（数量訂正）', '伝票取消', '一旦キャンセルです']);

export const PROCESS_ACTIONS = new Set(['orders', 'view', 'complete', 'undo']);

// 作業リストに出すビュー。key は画面との識別子。増やすときはここに足すだけ（ビューIDは Airtable の URL の viw... の部分）。
// quick は一覧の各行に並べる完了ボタン。step は STEPS の key、variant は種類の key（抜きの o / tk / tm など）。
// variant を省いた種類のある工程（抜き）は、押すと種類を選ぶ画面になる。label を省くと「工程名＋完了」。
export const VIEWS = {
  cad:     { id: 'viwIPW4eEsp6mo271', label: 'CAD',        quick: [{ step: 'cad' }] },
  // お守箔焼印は 生地カット → 抜き → 仕上がり。抜きの種類は品名タグから出る（2026-10-03 ユーザー確認）
  omamori: { id: 'viw2WoKluKqUBPwwk', label: 'お守箔焼印', quick: [{ step: 'kiji' }, { step: 'finish' }] },
  tm:      { id: 'viwdwd47psKdZPYAN', label: 'たおしM判',  quick: [{ step: 'tm' }] },
};
const VIEW_CACHE_MS = 20 * 1000; // 何人も開くので20秒は使い回す。完了を書いたら捨てる
const viewCache = new Map();     // key -> { at, rows }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Edge は UTC なので JST を自前で作る
function nowJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

async function airtable(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
      cache: 'no-store',
    });
    if (r.ok) return r.json();
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt >= 4) throw new Error(`airtable ${r.status}: ${(await r.text()).slice(0, 300)}`);
    await new Promise(res => setTimeout(res, 300 * 2 ** (attempt - 1)));
  }
}

function describe(rec) {
  const f = rec.fields || {};
  const done = {};
  for (const [key, s] of Object.entries(STEPS)) if (f[s.field]) done[key] = f[s.field];
  return {
    id: rec.id,
    book: f[F.book] || '', wc: f[F.wc] ?? '',
    item: f[F.item] || '', amount: f[F.amount] ?? null, ndate: f[F.ndate] || '',
    progIn: f[F.progIn] || '', progOut: f[F.progOut] || '', group: f[F.group] || '',
    kotei: f[F.kotei] || '',
    memo: f[F.memo] || '',
    closed: CLOSED_OUT.has(String(f[F.progOut] || '')),
    done,
  };
}

async function getRecord(id) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(id || ''))) return null;
  try { return await airtable(`${API}/${id}`); } catch { return null; }
}

function resolveStep(step, variant) {
  const s = STEPS[step];
  if (!s) return null;
  const v = s.variants.length === 1 ? s.variants[0] : s.variants.find(x => x.key === variant);
  return v ? { step: s, variant: v } : null;
}

export async function handleProcess(action, body, who) {
  if (action === 'orders') return orders(body);
  if (!who) return json({ ok: false, error: 'ログインしてください', needLogin: true }, 401);
  if (action === 'view') return view(body);
  if (action === 'complete') return complete(body, who.user);
  if (action === 'undo') return undo(body, who.user);
  return json({ ok: false, error: 'unknown action' }, 400);
}

const LIST_FIELDS = [F.book, F.wc, F.item, F.amount, F.ndate, F.progIn, F.progOut, F.group, F.kotei, F.memo, ...RECORD_FIELDS];

async function view(body) {
  const key = String(body?.view || '');
  const v = VIEWS[key];
  if (!v) return json({ ok: false, error: '作業リストの指定が正しくありません' }, 400);
  const c = viewCache.get(key);
  if (c && Date.now() - c.at < VIEW_CACHE_MS && !body?.refresh) {
    return json({ ok: true, rows: c.rows, steps: publicSteps(), views: publicViews(), cachedAt: c.at });
  }
  const rows = [];
  let offset;
  do {
    const url = new URL(API);
    url.searchParams.set('view', v.id);
    url.searchParams.set('pageSize', '100');
    for (const f of LIST_FIELDS) url.searchParams.append('fields[]', f);
    if (offset) url.searchParams.set('offset', offset);
    const j = await airtable(url);
    (j.records || []).forEach(r => rows.push(describe(r)));
    offset = j.offset;
  } while (offset && rows.length < 500);
  const at = Date.now();
  viewCache.set(key, { at, rows });
  return json({ ok: true, rows, steps: publicSteps(), views: publicViews(), cachedAt: at });
}

export function publicViews() {
  return Object.entries(VIEWS).map(([key, v]) => ({
    key, label: v.label,
    quick: (v.quick || []).map(q => ({ step: q.step, variant: q.variant || '', label: q.label || '' })),
  }));
}

async function orders(body) {
  const book = String(body?.book || '').trim();
  const wc = String(body?.wc || '').trim();
  if (!book || !wc) return json({ ok: false, error: '品番（Book と WorkCord）を指定してください' }, 400);
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const n = Number(wc);
  const wcExpr = Number.isFinite(n) ? String(n) : `'${esc(wc)}'`;
  const url = new URL(API);
  url.searchParams.set('filterByFormula', `AND({${F.book}}='${esc(book)}',{${F.wc}}=${wcExpr},{${F.archived}}!=TRUE())`);
  url.searchParams.set('pageSize', '50');
  for (const f of LIST_FIELDS) url.searchParams.append('fields[]', f);
  const j = await airtable(url);
  const list = (j.records || []).map(describe).sort((a, b) =>
    (a.closed - b.closed) || String(a.ndate || '9999').localeCompare(String(b.ndate || '9999')));
  return json({ ok: true, orders: list, steps: publicSteps() });
}

export function publicSteps() {
  return Object.entries(STEPS).map(([key, s]) => ({
    key, label: s.label, group: s.group,
    variants: s.variants.map(v => ({ key: v.key, label: v.label, value: v.value, tag: v.tag || '' })),
  }));
}

async function complete(body, user) {
  const r = resolveStep(body?.step, body?.variant);
  if (!r) return json({ ok: false, error: '工程の指定が正しくありません' }, 400);
  const rec = await getRecord(body?.id);
  if (!rec) return json({ ok: false, error: '受注が見つかりません' }, 404);
  const before = describe(rec);
  const prevRecord = rec.fields?.[r.step.field] || '';
  if (prevRecord && !body?.force) {
    return json({ ok: false, conflict: true, error: `この工程は「${prevRecord}」で記録済みです`, existing: prevRecord }, 409);
  }

  const stamp = `${user.name} ${nowJST()}`;
  viewCache.clear();
  await airtable(API, {
    method: 'PATCH',
    body: JSON.stringify({
      records: [{ id: rec.id, fields: { [F.progIn]: r.variant.value, [r.step.field]: stamp } }],
      ...(r.variant.create ? { typecast: true } : {}),
    }),
  });
  await writeWorkLog(user, {
    action: '工程完了', recordIds: [rec.id], book: before.book, wc: before.wc,
    detail: `${r.variant.value}（前の進行社内: ${before.progIn || '空白'}）${prevRecord ? ` 上書き前: ${prevRecord}` : ''}`,
  });
  return json({ ok: true, id: rec.id, value: r.variant.value, stamp, prev: before.progIn, prevRecord });
}

async function undo(body, user) {
  const r = resolveStep(body?.step, body?.variant);
  if (!r) return json({ ok: false, error: '工程の指定が正しくありません' }, 400);
  const rec = await getRecord(body?.id);
  if (!rec) return json({ ok: false, error: '受注が見つかりません' }, 404);
  const cur = rec.fields?.[r.step.field] || '';
  // 他人の記録を消せないようにする（管理者は可）
  if (user.role !== ROLE_ADMIN && !String(cur).startsWith(`${user.name} `)) {
    return json({ ok: false, error: '自分が記録したものだけ取り消せます' }, 403);
  }
  const fields = { [r.step.field]: String(body?.prevRecord || '') || null };
  // 進行社内は、自分が入れた値のままのときだけ元に戻す（その後に誰かが進めていたら触らない）
  if ((rec.fields?.[F.progIn] || '') === r.variant.value) fields[F.progIn] = String(body?.prev || '') || null;
  await airtable(API, { method: 'PATCH', body: JSON.stringify({ records: [{ id: rec.id, fields }] }) });
  viewCache.clear();
  await writeWorkLog(user, {
    action: '工程完了取消', recordIds: [rec.id], book: rec.fields?.[F.book] || '', wc: rec.fields?.[F.wc] ?? '',
    detail: `${r.variant.value} を取り消し（進行社内を ${F.progIn in fields ? (body?.prev || '空白') : 'そのまま'} に）`,
  });
  return json({ ok: true });
}
