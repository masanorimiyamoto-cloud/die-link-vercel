// api/_process.js
// 工程完了画面（public/process.html）のサーバー処理。先頭が _ なので単独の関数にはならず、
// api/airtable-update-progress.js から呼ばれる（Vercel Hobby の関数数を増やさないため）。
//
//   action=orders   { book, wc }                 … その品番の受注一覧（ログイン不要の読み取り）
//   action=view     { view }                     … 作業リスト。Airtable のビューをそのまま読む（ログイン必須）
//                   絞り込みと並び順はビュー側の設定が効くので、条件を変えたいときは Airtable でビューを直す。
//   action=complete { id, step, variant, force } … 工程完了を記録（ログイン必須）
//   action=undo     { id, step, prev, prevRecord } … 直前の完了記録を取り消す（本人か管理者）
//   action=ndate    { id, ndate }                … 納期（Ndate）を変える（ログイン必須）
//   action=paper    { id, paper }                … 紙入荷日（シート・機械貼材料の入荷日）を入れる／消す（ログイン必須）
//   action=room     { id, room, on }             … Room（複数選択）に応援先を足す／外す（ログイン必須）
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
const WORKLOG_API      = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${process.env.WORKLOG_TABLE_ID || 'tblQFZ7QEuRaBW4oj'}`;

const F = {
  book: 'Book', wc: 'WorkCord', item: 'ItemName', amount: 'NAmount', ndate: 'Ndate',
  progIn: '進行社内', progOut: '進行社外', group: '進行社内グループ', kotei: '工程(自動)', archived: 'アーカイブ済',
  memo: '連絡事項', image: '画像', paper: '紙入荷日',
  amountPrev: 'NAmount_Prev', amtLog: '数量変更記録', slipId: '伝票ID', die: '抜型状況', room: 'Room',
  ndateLog: '納期変更記録', printed: '工程表印刷日時',
};

// ---- Room（作業する部屋。複数選択）----
// 選択肢は Airtable のフィールド設定をそのまま使う（スキーマを読む）。読めないとき（PAT に
// schema.bases:read が無い等）だけ下の一覧を使う。2026-10-06 時点の Airtable の選択肢と同じ並び（17個）。
// 普段の部屋は 工程(自動) のタグ（|機械貼| など）で分かるので、画面ではそれを明るい枠にする。
// 急ぎで別の部屋に応援を頼むときに、その部屋を Room に足す。
// 2026-10-06 Room の 花 を「手貼(花 神)」に改名し 神 を廃止。タグは今も 花 なので対応表で結ぶ。
// ここに無い部屋は、部屋名とタグ名が同じ（機械貼・CAD など）。
// 2026-10-23 工程(自動) に #福祉 → 福祉 を追加。Room の選択肢名は「福祉　内職」（全角スペース入り）
const ROOM_TAG = { '手貼(花 神)': '花', '福祉　内職': '福祉' };
const ROOM_FALLBACK = [
  ['機械貼', 'blueLight2'], ['手貼(花 神)', 'pinkBright'], ['2F_小', 'yellowLight2'], ['オートン', 'cyanLight2'],
  ['たおしM判', 'tealLight2'], ['たおしK判', 'redLight2'], ['CAD', 'orangeLight2'], ['プレ', 'redLight2'],
  ['箔焼印', 'grayLight2'], ['金', 'blueLight2'], ['Nao', 'tealLight2'],
  ['福祉　内職', 'yellowLight2'], ['断裁ステッチ', 'grayLight2'], ['トヤマ(貼)', 'yellowLight2'],
  ['プレ(折のみ）', 'greenLight2'], ['CAD(折）', 'redLight2'], ['CAD(包装検品）', 'orangeLight2'],
].map(([name, color]) => ({ name, color }));
const ROOM_CACHE_MS = 10 * 10 * 1000;
let roomCache = null; // { at, list }
async function roomChoices() {
  if (roomCache && Date.now() - roomCache.at < ROOM_CACHE_MS) return roomCache.list;
  let list = ROOM_FALLBACK;
  try {
    const j = await airtable(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`);
    const t = (j.tables || []).find(x => x.id === TABLE || x.name === TABLE);
    const fld = t?.fields?.find(x => x.name === F.room);
    const ch = fld?.options?.choices;
    if (Array.isArray(ch) && ch.length) list = ch.map(c => ({ name: c.name, color: c.color || '' }));
  } catch { /* 読めなければ控えの一覧 */ }
  list = list.map(r => ({ ...r, tag: ROOM_TAG[r.name] || r.name }));
  roomCache = { at: Date.now(), list };
  return list;
}

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
  // 2026-10-04 (神)/(花)貼り完了 は作業者の名前入りだったので「手貼り完了」に統一（誰が押したかは記録で分かる）
  { key: 'tebari', value: '手貼り完了',           tag: '花' },
  { key: 'kikai',  value: '機械貼完了',           tag: '機械貼' },
  { key: 'seal',   value: 'シール貼完了' },
  { key: 'finish', value: '仕上がりました' },
  // 2026-10-27 Airtable に合わせる: 半製品あり → 抜き半製品あり（記録欄も改名）。貼り材料入りました は選択肢が無くなったのでボタンも外す
  { key: 'hansei', value: '抜き半製品あり',     group: 'status' },
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

export const PROCESS_ACTIONS = new Set(['orders', 'view', 'viewImages', 'complete', 'undo', 'cancel', 'amount', 'ndate', 'paper', 'room', 'stock']);

// 作業リストに出すビュー。key は画面との識別子。ビューIDは Airtable の URL の viw... の部分。
// sources が複数なら、それぞれのビューを読んで1つの一覧にまとめ、納期順に並べる。
// steps はそのビューの行で必ず進行札に出す工程。関数にすると行ごとに決められる（タグの無い 神 など）。
// 2026-10-03 ユーザーが Airtable 側でビューを整理（オートン未完了・神・たおしK判 を削除し統合）。
const hasTag = (row, tag) => String(row.kotei || '').includes('|' + tag + '|');
export const VIEWS = {
  // mine: この一覧を見る人にとっての「自分の工程」。どれかが済んでいれば行を青枠＋「済」にする（2026-10-17）
  // mineValues: 旧い選択肢名など、進行社内がこの値なら済とみなすもの
  //   抜き半製品あり は抜いた半製品が既にあるので、オートン・たおしの抜きは済とみなす（2026-10-27）
  // readyOut: 進行社外がこの値（材料の入荷）なら、前の工程が済んだのと同じく「取り掛かれます」（緑枠）にする（2026-10-22）
  cad:    { label: 'CAD',          mine: ['cad'], sources: [{ id: 'viwIPW4eEsp6mo271', steps: ['cad'] }] },
  // お守箔焼印は 生地カット → 抜き → 仕上がり。抜きの種類は品名タグから出る
  omamori: { label: 'お守箔焼印',   mine: ['finish'], sources: [{ id: 'viw2WoKluKqUBPwwk', steps: ['kiji', 'finish'] }] },
  auton:   { label: 'オートン抜き', mine: ['o'], mineValues: ['抜き半製品あり'], readyOut: ['シート材料入荷済', '在庫シート利用'], sources: [{ id: 'viwAy9jACXxhh37NH', steps: ['o'] }] },       // Grid オートン抜き
  kikai:   { label: '機械貼',       mine: ['kikai'], readyOut: ['機械貼材料入荷済'], sources: [{ id: 'viwq39cjz5wcriCaO', steps: ['kikai'] }] },   // Grid 機械貼
  // たおしは品名タグ（#tk / #tm）で M判・K判 が分かるので指定しない
  taoshi:  { label: 'たおし抜き',   mine: ['tk', 'tm'], mineValues: ['抜き半製品あり'], readyOut: ['シート材料入荷済', '在庫シート利用'], sources: [{ id: 'viwdwd47psKdZPYAN', steps: [] }] },          // Grid たおし抜き(M判K判)
  // 花はタグ（#h）があるが 神 にはタグが無い。花タグが無ければ 神 とみなす
  // 2026-10-05 ビューが作り直されてIDが変わった（旧 viw2w8DzG6PNmJ3Iy は VIEW_ID_NOT_FOUND）
  tebari:  { label: '手貼り',       mine: ['tebari'], mineValues: ['(神)貼り完了', '(花)貼り完了'], sources: [{ id: 'viwK1jk2LXPw45fU9', steps: ['tebari'] }] }, // Grid 手貼り（花 神)
  f2:      { label: '2F 小',        mine: ['finish', 'seal'], sources: [{ id: 'viwwv6PpN5jJInPuK', steps: [] }] },          // Grid 2F_小
  // 以下は 進行社内 に専用の選択肢が無い。自分の工程は 仕上がりました（2F 小・Nao は シール貼完了 も）で見る（2026-10-17 ユーザー指定）
  nao:     { label: 'Nao',          mine: ['finish', 'seal'], sources: [{ id: 'viwONbEg5wUbGjKhf', steps: [] }] },          // Grid Nao
  dansai:  { label: '断裁ステッチ', mine: ['finish'], sources: [{ id: 'viwo8sSBLMF1H2cKr', steps: [] }] },          // Grid 断裁ステッチ
  pre:     { label: 'プレ',         mine: ['finish'], sources: [{ id: 'viwfoMBJi9LeTlENl', steps: [] }] },          // Grid プレ
  // 2026-10-05 全件のビュー。絞り込みが無く9割がアーカイブ済で、500件の上限で途中が切れるため
  // アーカイブ済だけはここで外す（Grid view は他でも使うので Airtable 側は変えない）
  all:     { label: '全件',         sources: [{ id: 'viwQW1JdhvjK5hbwF', steps: [], formula: 'NOT({アーカイブ済})' }] }, // Grid view
  // keepOrder: 画面で納品日順に並べ替えず、ビューの並び（Recent は 最終更新 の新しい順 Z→A）のまま出す（2026-10-29 ユーザー指定）
  recent:  { label: 'Recent 1day',  keepOrder: true, sources: [{ id: 'viwgFO3k8bRAhJVNw', steps: [] }] },          // Grid Recent 1day
  fax:     { label: 'Fax',          sources: [{ id: 'viwvqPJgm9s9BAlvR', steps: [] }] },          // Grid FromFAX 承認待ち
};
const DEFAULT_VIEW = 'cad';
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
    paper: f[F.paper] || '',
    die: Array.isArray(f[F.die]) ? f[F.die].map(String) : [],   // 抜型状況（複数選択）
    room: Array.isArray(f[F.room]) ? f[F.room].map(String) : [], // Room（複数選択）
    printedAt: String(f[F.printed] || ''), // 工程表印刷日時（YYYY-MM-DD HH:MM）。作業リストの社内の流れの最初に出す
    // 数量を画面で変えた履歴の最後の行（「1000→1020 佐藤 …」）から元の数量を出す
    amountFrom: (() => { const m = /^(\d+|空白)→/.exec(String(f[F.amtLog] || '').trim()); return m ? m[1] : ''; })(),
    amountLog: String(f[F.amtLog] || '').trim().split('\n').pop() || '',
    // 納期も同じ（「2026-10-08→2026-10-10 佐藤 …」）
    ndateFrom: (() => { const m = /^(\d{4}-\d\d-\d\d|空白)→/.exec(String(f[F.ndateLog] || '').trim()); return m ? m[1] : ''; })(),
    ndateLog: String(f[F.ndateLog] || '').trim().split('\n').pop() || '',
    // 伝票を出した後は数量を変えられない（画面でボタンを出さないため）
    amountLocked: !!f[F.slipId] || ['伝票出力済', '完納済', '完納（数量訂正）', '伝票取消'].includes(String(f[F.progOut] || '')),
    // 画像（添付）。Airtable の URL は数時間で切れるので保存せず、その都度の一覧で返す
    images: imagesOf(f),
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
  if (action === 'view') return view(body, who.user);
  if (action === 'viewImages') return viewImages(body);
  if (action === 'complete') return complete(body, who.user);
  if (action === 'undo') return undo(body, who.user);
  if (action === 'cancel') return cancel(body, who.user);
  if (action === 'amount') return changeAmount(body, who.user);
  if (action === 'ndate') return changeNdate(body, who.user);
  if (action === 'paper') return changePaper(body, who.user);
  if (action === 'room') return setRoom(body, who.user);
  if (action === 'stock') return setStock(body, who.user);
  return json({ ok: false, error: 'unknown action' }, 400);
}

// 画像（添付）の URL。Airtable の URL は数時間で切れるので保存せず、その都度返す
function imagesOf(f) {
  return (Array.isArray(f[F.image]) ? f[F.image] : []).map(a => ({
    thumb: a.thumbnails?.large?.url || a.url,
    full: a.thumbnails?.full?.url || a.url,
    name: a.filename || '', isImage: String(a.type || '').startsWith('image/'),
  }));
}

const LIST_FIELDS = [F.book, F.wc, F.item, F.amount, F.ndate, F.progIn, F.progOut, F.group, F.kotei, F.memo, F.image, F.paper, F.amtLog, F.slipId, F.die, F.room, F.ndateLog, F.printed, ...RECORD_FIELDS];

// formula を渡すと、ビューの条件に加えて Airtable の filterByFormula でも絞る
// 作業リストは まず画像なしで返して早く出し、画像は viewImages で後から足す（2026-10-20 初回表示が遅い対策）
// 画像の添付は1件ごとに大きさ違いの長い URL が3つ付き、一覧の通信量の大半を占めていた
const LIST_FIELDS_LITE = LIST_FIELDS.filter(x => x !== F.image);
const IMG_CACHE_MS = 5 * 60 * 1000; // 画像の URL は数時間有効。図面は滅多に変わらないので5分使い回す
const imgCache = new Map();         // key -> { at, images }

async function readView(viewId, formula = '', fields = LIST_FIELDS, map = describe) {
  const rows = [];
  let offset;
  do {
    const url = new URL(API);
    url.searchParams.set('view', viewId);
    if (formula) url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('pageSize', '100');
    for (const f of fields) url.searchParams.append('fields[]', f);
    if (offset) url.searchParams.set('offset', offset);
    const j = await airtable(url);
    (j.records || []).forEach(r => rows.push(map(r)));
    offset = j.offset;
  } while (offset && rows.length < 500);
  return rows;
}

async function view(body, user) {
  // 古い画面が覚えているキー（以前の tm など）でも止めずに既定の一覧を返す
  const key = VIEWS[String(body?.view || '')] ? String(body.view) : DEFAULT_VIEW;
  const v = VIEWS[key];
  const lite = !!body?.lite;               // 画像なし（作業リストの最初の表示用）
  const ck = key + (lite ? '|lite' : '');
  const roomsP = roomChoices();            // 部屋の選択肢は一覧と並べて読む（以前は一覧の後に順番に読んでいた）
  const c = viewCache.get(ck);
  if (c && Date.now() - c.at < VIEW_CACHE_MS && !body?.refresh) {
    return json({ ok: true, view: key, rows: c.rows, steps: publicSteps(), views: publicViews(), rooms: await roomsP, cachedAt: c.at });
  }
  const byId = new Map();
  for (const src of v.sources) {
    let got;
    try { got = await readView(src.id, src.formula, lite ? LIST_FIELDS_LITE : LIST_FIELDS); }
    catch (e) {
      // Airtable でビューを消したり作り直したりすると ID が変わる。何が起きたか画面で分かるようにする
      const gone = /airtable (404|422)/.test(String(e?.message || ''));
      return json({ ok: false, error: gone
        ? `「${v.label}」の Airtable ビューが見つかりません。ビューを削除・作り直した場合は管理者に連絡してください。`
        : `「${v.label}」を読み込めませんでした（${String(e?.message || e).slice(0, 80)}）` }, gone ? 404 : 502);
    }
    for (const r of got) {
      const steps = typeof src.steps === 'function' ? src.steps(r) : src.steps;
      const cur = byId.get(r.id);
      if (cur) cur.extra = [...new Set([...cur.extra, ...steps])];
      else byId.set(r.id, { ...r, extra: [...steps] });
    }
  }
  let rows = [...byId.values()];
  await autoSheetWait(rows, user);
  // 1つのビューならビューの並び順のまま。複数をまとめたときは納期順（空は最後）
  if (v.sources.length > 1) rows.sort((a, b) => String(a.ndate || '9999').localeCompare(String(b.ndate || '9999')));
  const at = Date.now();
  viewCache.set(ck, { at, rows });
  return json({ ok: true, view: key, rows, steps: publicSteps(), views: publicViews(), rooms: await roomsP, cachedAt: at });
}

// ---- 進行社外が空白のシート待ち → 「シート手配待ち」（2026-10-29）----
// オートン・たおしの抜きはシートが要る。進行社外が空白のままだと、後の部屋の一覧で「オートン抜き待ち」と出て
// シートが揃っているように見えてしまう（ユーザー指摘）。作業リストを読んだときに、まだ何も済んでいない行
// （進行社内が空白か工程表発行済で、工程の記録も無い）の空白を シート手配待ち にする。
// 在庫のシートを使うなら、工程カードの「在庫シート利用」で変える（シート手配待ちからも変えられる）
// 紙入荷日が入っていて今日（日本時間）以前なら、シート手配待ちではなく シート材料入荷済 にする（ユーザー指定）。
// シート手配待ち・シート手配済み のまま紙入荷日を迎えたものは、Airtable のオートメーション（毎日11:00）が入荷済にする
const SHEET_WAIT = 'シート手配待ち';
const SHEET_ARRIVED = 'シート材料入荷済';
const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const SHEET_TAGS = ['オートン', 'たおしK判', 'たおしM判'];
const needsSheetWait = (r) => !r.progOut && !r.closed && SHEET_TAGS.some(t => hasTag(r, t))
  && ['', '工程表発行済'].includes(r.progIn) && !Object.keys(r.done).length;
async function autoSheetWait(rows, user) {
  const today = todayJST();
  const need = rows.filter(needsSheetWait).map(r => ({ r,
    to: /^\d{4}-\d\d-\d\d$/.test(r.paper) && r.paper <= today ? SHEET_ARRIVED : SHEET_WAIT }));
  for (let i = 0; i < need.length; i += 10) {
    const part = need.slice(i, i + 10);
    try {
      await airtable(API, { method: 'PATCH', body: JSON.stringify({ records: part.map(x => ({ id: x.r.id, fields: { [F.progOut]: x.to } })) }) });
    } catch { return; } // 書けなくても一覧は出す（次に開いたときにまた試す）
    for (const x of part) x.r.progOut = x.to;
    viewCache.clear();
    await writeWorkLog(user, part.map(({ r, to }) => ({ recordIds: [r.id], book: r.book, wc: r.wc, action: '進行社外変更',
      detail: to === SHEET_ARRIVED ? `${to}（自動。進行社外が空白で、紙入荷日 ${r.paper} を過ぎていたため）` : `${to}（自動。進行社外が空白だったため）` })));
  }
}

// 作業リストの画像だけ（{ 受注ID: [画像…] }）。画面は一覧を出した後にこれで縮小画像を足す
async function viewImages(body) {
  const key = VIEWS[String(body?.view || '')] ? String(body.view) : DEFAULT_VIEW;
  const v = VIEWS[key];
  const c = imgCache.get(key);
  if (c && Date.now() - c.at < IMG_CACHE_MS) return json({ ok: true, view: key, images: c.images });
  const images = {};
  try {
    for (const src of v.sources) {
      const got = await readView(src.id, src.formula, [F.image], r => ({ id: r.id, images: imagesOf(r.fields || {}) }));
      for (const r of got) if (r.images.length) images[r.id] = r.images;
    }
  } catch (e) {
    return json({ ok: false, error: '画像を読み込めませんでした' }, 502);
  }
  imgCache.set(key, { at: Date.now(), images });
  return json({ ok: true, view: key, images });
}

export function publicViews() {
  return Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, mine: v.mine || [], mineValues: v.mineValues || [], readyOut: v.readyOut || [], keepOrder: !!v.keepOrder }));
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
  return json({ ok: true, orders: list, steps: publicSteps(), rooms: await roomChoices() });
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
    action: '工程完了', step: r.variant.value, credit: true, recordIds: [rec.id], book: before.book, wc: before.wc,
    detail: `${r.variant.value}（前の進行社内: ${before.progIn || '空白'}）${prevRecord ? ` 上書き前: ${prevRecord}` : ''}`,
  });
  return json({ ok: true, id: rec.id, value: r.variant.value, stamp, prev: before.progIn, prevRecord });
}

// ---- 工程ボタンをもう一度押したときの取り消し ----
// 記録欄を空にし、進行社内がこの工程の値のままなら「この工程を記録する直前の値」へ戻す。
// 直前の値は作業ログ（工程完了の行の「前の進行社内: ○○」）から探す。見つからなければ空白にする。
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function findPrevProgIn(rec, value) {
  const f = rec.fields || {};
  const target = `OR({受注ID}='${esc(rec.id)}',AND({受注ID}='',{Book}='${esc(f[F.book] || '')}',{WorkCord}='${esc(f[F.wc] ?? '')}'))`;
  const url = new URL(WORKLOG_API);
  url.searchParams.set('filterByFormula', `AND({操作}='工程完了',FIND('${esc(value)}（',{内容})=1,${target})`);
  url.searchParams.set('sort[0][field]', '日時');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('maxRecords', '1');
  try {
    const j = await airtable(url);
    const d = j.records?.[0]?.fields?.['内容'] || '';
    const m = /前の進行社内: (.+?)）/.exec(d);
    if (!m) return '';
    return m[1] === '空白' || m[1] === value ? '' : m[1];
  } catch { return ''; }
}

async function cancel(body, user) {
  const r = resolveStep(body?.step, body?.variant);
  if (!r) return json({ ok: false, error: '工程の指定が正しくありません' }, 400);
  const rec = await getRecord(body?.id);
  if (!rec) return json({ ok: false, error: '受注が見つかりません' }, 404);
  const cur = rec.fields?.[r.step.field] || '';
  const progIn = rec.fields?.[F.progIn] || '';
  if (!cur && progIn !== r.variant.value) {
    return json({ ok: false, error: 'この工程はもう記録されていません（誰かが先に取り消した可能性があります）', stale: true }, 409);
  }
  // 他人の記録は本人か管理者だけが取り消せる。記録者が無いもの（Airtable で直接入れた進行社内、
  // またはオートメーションが「Airtable 日時」と書いたもの）は誰でも可
  const unowned = !cur || String(cur).startsWith('Airtable ');
  if (!unowned && user.role !== ROLE_ADMIN && !String(cur).startsWith(`${user.name} `)) {
    return json({ ok: false, error: `${cur.split(' ')[0]} さんの記録なので取り消せません。本人か管理者に頼んでください` }, 403);
  }
  const fields = { [r.step.field]: null };
  let restored = null;
  if (progIn === r.variant.value) { restored = await findPrevProgIn(rec, r.variant.value); fields[F.progIn] = restored || null; }
  await airtable(API, { method: 'PATCH', body: JSON.stringify({ records: [{ id: rec.id, fields }] }) });
  viewCache.clear();
  await writeWorkLog(user, {
    action: '工程取消', step: r.variant.value, recordIds: [rec.id], book: rec.fields?.[F.book] || '', wc: rec.fields?.[F.wc] ?? '',
    detail: `${r.variant.value} を取り消し${cur ? `（記録: ${cur}）` : ''}。進行社内は ${restored === null ? 'そのまま' : (restored || '空白') + ' に戻した'}`,
  });
  return json({ ok: true, progIn: restored === null ? progIn : restored });
}

// ---- 仕上がり数量（NAmount）の変更 ----
// 作業者が仕上がった実数に直す。受領伝票はこの数量で出るので、伝票を出す前に直す運用。
// ・NAmount_Prev も同じ値に書く（正規の書き手。書かないと「数量異常」の桁違い判定と
//   Excel への差分プルの保留に引っかかる。memory/namount-baseline-design.md）
// ・整数だけ。1504 が 1.504 に化けた事故（2026-09-01）の再発防止
// ・今の数量の10倍以上/10分の1以下は打ち間違いとして弾く（数量異常の判定と同じ基準）
// ・伝票発行後は変えない。発行後の訂正は受領伝票の照合（UpdatedBySlip）で行う
const SLIP_DONE_OUT = new Set(['伝票出力済', '完納済', '完納（数量訂正）', '伝票取消']);
async function changeAmount(body, user) {
  const rec = await getRecord(body?.id);
  if (!rec) return json({ ok: false, error: '受注が見つかりません' }, 404);
  const f = rec.fields || {};
  const raw = String(body?.amount ?? '').trim().replace(/[,，\s]/g, '');
  if (!/^\d+$/.test(raw)) return json({ ok: false, error: '数量は整数で入れてください（小数・記号は不可）' }, 400);
  const next = Number(raw);
  if (!Number.isSafeInteger(next) || next <= 0) return json({ ok: false, error: '数量は1以上の整数で入れてください' }, 400);
  if (f[F.slipId] || SLIP_DONE_OUT.has(String(f[F.progOut] || ''))) {
    return json({ ok: false, error: '受領伝票を発行した後なので、ここでは数量を変えられません。伝票の照合で訂正してください' }, 409);
  }
  const cur = Number(f[F.amount]);
  if (Number.isFinite(cur) && cur === next) return json({ ok: true, amount: next, unchanged: true });
  if (Number.isFinite(cur) && cur > 0 && (next >= cur * 10 || next * 10 <= cur)) {
    return json({ ok: false, error: `今の数量 ${cur.toLocaleString('ja-JP')} と桁が違います。打ち間違いでなければ事務所に頼んでください` }, 400);
  }
  const line = `${Number.isFinite(cur) ? cur : '空白'}→${next} ${user.name} ${nowJST()}`;
  const log = String(f[F.amtLog] || '').trim();
  await airtable(API, {
    method: 'PATCH',
    body: JSON.stringify({ records: [{ id: rec.id, fields: {
      [F.amount]: next, [F.amountPrev]: next, [F.amtLog]: log ? `${log}\n${line}` : line,
    } }] }),
  });
  viewCache.clear();
  await writeWorkLog(user, {
    action: '数量変更', recordIds: [rec.id], book: f[F.book] || '', wc: f[F.wc] ?? '', detail: line,
  });
  return json({ ok: true, amount: next, line });
}

// ---- 納期（Ndate）の変更 ----
// 差分プル（Airtable_Fetch.py）が Excel の E列へ戻す。伝票発行後は Excel 側も E列を戻さないので、
// 数量と同じく発行前だけ変えられるようにする（発行後の訂正は受領伝票の照合で行う）。
// 日付の打ち間違い（年違いなど）を弾くため、今日の前後1年の外は受けない。
async function changeNdate(body, user) {
  const rec = await getRecord(body?.id);
  if (!rec) return json({ ok: false, error: '受注が見つかりません' }, 404);
  const f = rec.fields || {};
  const next = String(body?.ndate ?? '').trim();
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(next);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return json({ ok: false, error: '納期の日付が正しくありません' }, 400);
  const today = Date.parse(nowJST().slice(0, 10) + 'T00:00:00Z');
  if (Math.abs(d.getTime() - today) > 366 * 86400000) return json({ ok: false, error: '納期は今日の前後1年の中で入れてください' }, 400);
  if (f[F.slipId] || SLIP_DONE_OUT.has(String(f[F.progOut] || ''))) {
    return json({ ok: false, error: '受領伝票を発行した後なので、ここでは納期を変えられません。伝票の照合で訂正してください' }, 409);
  }
  const cur = String(f[F.ndate] || '');
  if (cur === next) return json({ ok: true, ndate: next, unchanged: true });
  const line = `${cur || '空白'}→${next} ${user.name} ${nowJST()}`;
  const log = String(f[F.ndateLog] || '').trim();
  await airtable(API, {
    method: 'PATCH',
    body: JSON.stringify({ records: [{ id: rec.id, fields: { [F.ndate]: next, [F.ndateLog]: log ? `${log}\n${line}` : line } }] }),
  });
  viewCache.clear();
  await writeWorkLog(user, {
    action: '納期変更', recordIds: [rec.id], book: f[F.book] || '', wc: f[F.wc] ?? '', detail: line,
  });
  return json({ ok: true, ndate: next, line });
}

// ---- 紙入荷日の入力（2026-10-29）----
// シートの入荷日（自社手配・先方支給）と機械貼材料の入荷日を兼ねる1つの欄。今まで Airtable の直打ちだけだった。
// 空にして消すこともできる。納期と同じく伝票発行後は変えない・今日の前後1年の外は打ち間違いとして弾く。
// 欄に履歴は無いので、作業ログ（紙入荷日変更）にだけ残す。インセンティブには数えない
async function changePaper(body, user) {
  const rec = await getRecord(body?.id);
  if (!rec) return json({ ok: false, error: '受注が見つかりません' }, 404);
  const f = rec.fields || {};
  const next = String(body?.paper ?? '').trim();
  if (next) {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(next);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return json({ ok: false, error: '紙入荷日の日付が正しくありません' }, 400);
    const today = Date.parse(nowJST().slice(0, 10) + 'T00:00:00Z');
    if (Math.abs(d.getTime() - today) > 366 * 86400000) return json({ ok: false, error: '紙入荷日は今日の前後1年の中で入れてください' }, 400);
  }
  if (f[F.slipId] || SLIP_DONE_OUT.has(String(f[F.progOut] || ''))) {
    return json({ ok: false, error: '受領伝票を発行した後なので、ここでは紙入荷日を変えられません' }, 409);
  }
  const cur = String(f[F.paper] || '');
  if (cur === next) return json({ ok: true, paper: next, unchanged: true });
  await airtable(API, { method: 'PATCH', body: JSON.stringify({ records: [{ id: rec.id, fields: { [F.paper]: next || null } }] }) });
  viewCache.clear();
  await writeWorkLog(user, {
    action: '紙入荷日変更', recordIds: [rec.id], book: f[F.book] || '', wc: f[F.wc] ?? '', detail: `${cur || '空白'}→${next || '空白'}`,
  });
  return json({ ok: true, paper: next });
}

// ---- Room に応援先を足す／外す ----
// 複数選択なので、今の値を読んでから1つだけ足す／外す（他の人が入れた部屋は残す）。
// typecast は使わない。選択肢に無い名前はここで弾き、Airtable に勝手に選択肢を増やさない。
async function setRoom(body, user) {
  const room = String(body?.room || '');
  const rooms = await roomChoices();
  if (!rooms.some(r => r.name === room)) return json({ ok: false, error: `Room に「${room}」という選択肢がありません` }, 400);
  const rec = await getRecord(body?.id);
  if (!rec) return json({ ok: false, error: '受注が見つかりません' }, 404);
  const f = rec.fields || {};
  const cur = Array.isArray(f[F.room]) ? f[F.room].map(String) : [];
  const on = !!body?.on;
  if (on === cur.includes(room)) return json({ ok: true, room: cur, unchanged: true });
  const next = on ? [...cur, room] : cur.filter(r => r !== room);
  await airtable(API, { method: 'PATCH', body: JSON.stringify({ records: [{ id: rec.id, fields: { [F.room]: next } }] }) });
  viewCache.clear();
  await writeWorkLog(user, {
    action: 'Room変更', recordIds: [rec.id], book: f[F.book] || '', wc: f[F.wc] ?? '',
    detail: `${room} を${on ? '追加' : '外した'}（Room: ${cur.join('、') || '空白'} → ${next.join('、') || '空白'}）`,
  });
  return json({ ok: true, room: next });
}

// ---- 進行社外「在庫シート利用」「シート材料入荷済」（2026-10-23 / 10-29）----
// 工程カードの「状況」から入れる。進行社外は伝票発行の判定に使うので、生地照合（airtable-update-progress.js の fabric）と
// 同じく、空白か材料待ち（シート手配待ち／シート手配済み）のときだけ書く。受領伝票発行可能・伝票出力済・完納済・
// 納期変更 などは上書きしない（8/7 の事故の再発防止）。選択肢は既にあるので typecast は使わない。
// on=false は取り消し: 進行社外がその値のままなら、入れる前の値（作業ログの「前の進行社外: ○○」）へ戻す
// シート材料入荷済・機械貼材料入荷済（2026-10-29）は入荷を人が確かめた報告なので、作業ログを「状況報告」（実績対象）で残しインセンティブに数える。
// 取り消しは「状況報告取消」で、_incentive.js が 受注ID＋工程 の最後の状態で数え直す（工程完了と同じ）。
// 在庫シート利用 は数えない（進行社外変更）。
const STOCK_OUT = '在庫シート利用';
const ARRIVED_OUTS = new Set(['シート材料入荷済', '機械貼材料入荷済']);
const OUT_BUTTONS = new Set([STOCK_OUT, ...ARRIVED_OUTS]);
// 2026-10-29 Airtable の選択肢 シート手配必要 が シート手配待ち に変わったので合わせる
const STOCK_REPLACEABLE = new Set(['', 'シート手配待ち', 'シート手配済み']);
async function findPrevOut(rec, out) {
  const f = rec.fields || {};
  const target = `OR({受注ID}='${esc(rec.id)}',AND({受注ID}='',{Book}='${esc(f[F.book] || '')}',{WorkCord}='${esc(f[F.wc] ?? '')}'))`;
  const url = new URL(WORKLOG_API);
  url.searchParams.set('filterByFormula', `AND(OR({操作}='進行社外変更',{操作}='状況報告'),FIND('${esc(out)}（',{内容})=1,${target})`);
  url.searchParams.set('sort[0][field]', '日時');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('maxRecords', '1');
  try {
    const j = await airtable(url);
    const m = /前の進行社外: (.+?)）/.exec(j.records?.[0]?.fields?.['内容'] || '');
    // 戻すのは材料待ちの値だけ（ログが読めない・想定外の値なら空白に戻す）
    return m && STOCK_REPLACEABLE.has(m[1]) ? m[1] : '';
  } catch { return ''; }
}
async function setStock(body, user) {
  const rec = await getRecord(body?.id);
  if (!rec) return json({ ok: false, error: '受注が見つかりません' }, 404);
  const f = rec.fields || {};
  const cur = String(f[F.progOut] || '').trim();
  const out = body?.out === undefined ? STOCK_OUT : String(body.out);
  if (!OUT_BUTTONS.has(out)) return json({ ok: false, error: '進行社外の指定が正しくありません' }, 400);
  const report = ARRIVED_OUTS.has(out);
  const base = { recordIds: [rec.id], book: f[F.book] || '', wc: f[F.wc] ?? '' };
  if (body?.on !== false) {
    if (cur === out) return json({ ok: true, progOut: cur, unchanged: true });
    if (!STOCK_REPLACEABLE.has(cur)) {
      return json({ ok: false, error: `進行社外が「${cur}」なので、${out}には変えられません` }, 409);
    }
    await airtable(API, { method: 'PATCH', body: JSON.stringify({ records: [{ id: rec.id, fields: { [F.progOut]: out } }] }) });
    viewCache.clear();
    const detail = `${out}（前の進行社外: ${cur || '空白'}）`;
    await writeWorkLog(user, report ? { ...base, action: '状況報告', step: out, credit: true, detail }
      : { ...base, action: '進行社外変更', detail });
    return json({ ok: true, progOut: out, prev: cur });
  }
  if (cur !== out) {
    return json({ ok: false, error: `進行社外はもう${out}ではありません（誰かが先に変えた可能性があります）`, stale: true }, 409);
  }
  const prev = await findPrevOut(rec, out);
  await airtable(API, { method: 'PATCH', body: JSON.stringify({ records: [{ id: rec.id, fields: { [F.progOut]: prev || null } }] }) });
  viewCache.clear();
  const detail = `${out} を取り消し。進行社外は ${prev || '空白'} に戻した`;
  await writeWorkLog(user, report ? { ...base, action: '状況報告取消', step: out, detail }
    : { ...base, action: '進行社外変更', detail });
  return json({ ok: true, progOut: prev });
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
    action: '工程完了取消', step: r.variant.value, recordIds: [rec.id], book: rec.fields?.[F.book] || '', wc: rec.fields?.[F.wc] ?? '',
    detail: `${r.variant.value} を取り消し（進行社内を ${F.progIn in fields ? (body?.prev || '空白') : 'そのまま'} に）`,
  });
  return json({ ok: true });
}
