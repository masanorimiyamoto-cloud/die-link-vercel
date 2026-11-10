// api/_incentive.js
// インセンティブ用の「日付 × 社員番号 × 工程 → 件数」を TableWorkLog から作り、TableIncentiveDaily に書く（2026-10-28）。
// 給料計算（Booksky_net）はこの表を 社員番号と日付の範囲（社員20日締め／パート月末締め）で合計する。
//
// 数え方:
//  ・工程完了／工程取消／工程完了取消 は 受注ID＋工程 ごとに時刻順に並べ、最後が「完了」ならその完了をした人に1件、
//    最後が取消なら0件（押し間違いの取消、別の人がやり直した場合はやり直した人に付く）。
//  ・状況報告／状況報告取消（工程カードの「シート材料入荷済」「機械貼材料入荷済」。2026-10-29）も同じく 受注ID＋工程 の最後の状態で数える。
//  ・探す（抜型照合）・仕舞う（抜型仕舞い）・知る（生地照合）は、実績対象 が付いた行を1件ずつ数える（取消は無い）。
//  ・社員番号が無いログ（10/7 以前）は数えない。対象は 2026-10-08（日本時間）以降。
//  ・日付は記録した時刻の日本時間の日。
// 実行: 毎晩の Vercel Cron（vercel.json）と、管理者が /api/session?action=incentive を開いたとき。
//  直近45日を作り直す（翌日以降の取消も反映するため）。作業ログもその45日分だけ読む（logsSince）。
//  &full=1 で 10/8 から全部作り直す（ログも全部読む）。
// 欄はすべてフィールドIDで読み書きする（10/4 に欄名の変更でログが捨てられた教訓）。

const AIRTABLE_PAT     = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appwAnJP9OOZ3MVF5';
const WORKLOG = process.env.WORKLOG_TABLE_ID || 'tblQFZ7QEuRaBW4oj';
const DAILY   = process.env.INCENTIVE_TABLE_ID || 'tblaO7MWgAW0VvCwU';

const WL = { at: 'fldal1FMiPlRVn9BF', no: 'fldmjyRUDyPPaFFnb', name: 'fldEBJAH0707h1ity', action: 'fldHbWQ5VemkIPMmS',
  step: 'flds9HiDR5e1eiFGf', orderId: 'fldOfsIbZmKNfeik8', credit: 'fldIHadyI8FqyEqQ5' };
const D = { key: 'fldCqMq8twEDgwn3a', date: 'fld9QfTWCVyARS1KA', no: 'fldZOZLQTiElEHx7D', name: 'fldOV7V9IWzGDGfSL',
  step: 'fldcYOdk3kKZ4E56t', count: 'fldqLboYbHkmWrVqN', updated: 'fldukDQM6sXoQlDlb' };

export const START_DATE = '2026-10-08';     // 社員番号がログに残り始めた翌日
const WINDOW_DAYS = 45;
// 取り消しのある操作。受注ID＋工程 ごとに最後の操作が DONE_ACTIONS（実績対象つき）なら1件
const PROCESS_ACTIONS = new Set(['工程完了', '工程取消', '工程完了取消', '状況報告', '状況報告取消']);
const DONE_ACTIONS = new Set(['工程完了', '状況報告']);
const CANCEL_ACTIONS = [...PROCESS_ACTIONS].filter(a => !DONE_ACTIONS.has(a));

const jstDate = (iso) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);
const daysAgoJST = (n) => new Date(Date.now() + 9 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function airtable(url, init = {}) {
  if (!AIRTABLE_PAT) throw new Error('AIRTABLE_PAT is missing');
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' }, cache: 'no-store' });
    if (r.ok) return r.json();
    if (!(r.status === 429 || r.status >= 500) || attempt >= 4) throw new Error(`airtable ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await sleep(400 * 2 ** (attempt - 1));
  }
}

async function readAll(table, formula, fields) {
  const out = []; let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}`);
    u.searchParams.set('pageSize', '100'); u.searchParams.set('returnFieldsByFieldId', 'true');
    if (formula) u.searchParams.set('filterByFormula', formula);
    for (const f of fields) u.searchParams.append('fields[]', f);
    if (offset) u.searchParams.set('offset', offset);
    const j = await airtable(u);
    out.push(...(j.records || [])); offset = j.offset;
    if (offset) await sleep(210);
  } while (offset);
  return out;
}

// 作業ログから 日付|社員番号|工程 → 件数 を数える（純粋な計算。テストしやすいよう分けてある）
export function countDaily(logs) {
  const lines = logs.map(r => ({ id: r.id, ...Object.fromEntries(Object.entries(WL).map(([k, f]) => [k, r.fields?.[f]])) }))
    .filter(x => x.at && Number.isFinite(Number(x.no)))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const winners = [];             // 数える行（完了の最後の状態／照合・仕舞い）
  const last = new Map();         // 受注ID|工程 → 最後の完了（取消なら null）
  for (const x of lines) {
    if (PROCESS_ACTIONS.has(x.action)) {
      if (!x.orderId || !x.step) continue;
      const k = `${x.orderId}|${x.step}`;
      last.set(k, DONE_ACTIONS.has(x.action) && x.credit ? x : null);
    } else if (x.credit && x.step) {
      winners.push(x);            // 抜型照合・抜型仕舞い・生地照合（新しく済んだときだけ実績対象が付いている）
    }
  }
  for (const v of last.values()) if (v) winners.push(v);
  const counts = new Map();
  for (const x of winners) {
    const date = jstDate(x.at);
    if (date < START_DATE) continue;
    const key = `${date}|${Number(x.no)}|${x.step}`;
    const c = counts.get(key) || { key, date, no: Number(x.no), name: x.name || '', step: x.step, count: 0 };
    c.count += 1; c.name = x.name || c.name;
    counts.set(key, c);
  }
  return counts;
}

// 作業ログをどの時刻より後から読むか（from は日本時間の日付）。
// 以前は毎回 10/7 から全部読んでいたので、ログが増えるほど遅くなり、いずれ関数の時間切れで集計が止まる（2026-11-10）。
// 書くのは from 以降の日付の行だけで、その行は from より前のログに左右されない:
//  ・照合・仕舞いは1行ずつ数える（他の行と無関係）
//  ・完了／取消は 受注ID＋工程 の「最後の1行」だけで決まる。最後の行が from 以降ならそれより前の行は結果に効かず、
//    最後の行が from より前ならその完了は from より前の日付なので、もともと書く対象に入らない
// なので from の日本時間 0:00 から読めば、全部読んだときと同じ結果になる（境目のずれに備えて1日前から読む）。
// from より前の日付の行は今までどおり直さない（45日より前の完了を取り消したときは &full=1 で作り直す）
export function logsSince(from) {
  return new Date(Date.parse(`${from}T00:00:00+09:00`) - 86400000).toISOString();
}

export async function runIncentive({ full = false } = {}) {
  const from = full ? START_DATE : [START_DATE, daysAgoJST(WINDOW_DAYS)].sort().pop();
  const logs = await readAll(WORKLOG,
    `AND(IS_AFTER({${WL.at}}, '${logsSince(from)}'), OR({${WL.credit}}, ${CANCEL_ACTIONS.map(a => `{${WL.action}}='${a}'`).join(', ')}))`,
    Object.values(WL));
  const counts = countDaily(logs);
  const want = [...counts.values()].filter(c => c.date >= from);

  const existing = await readAll(DAILY, `NOT(IS_BEFORE({${D.date}}, '${from}'))`, [D.key, D.count]);
  const have = new Map(existing.map(r => [r.fields?.[D.key], { id: r.id, count: Number(r.fields?.[D.count] || 0) }]));
  const now = new Date().toISOString();

  const upserts = want.filter(c => have.get(c.key)?.count !== c.count).map(c => ({ fields: {
    [D.key]: c.key, [D.date]: c.date, [D.no]: c.no, [D.name]: c.name, [D.step]: c.step, [D.count]: c.count, [D.updated]: now,
  } }));
  const wantKeys = new Set(want.map(c => c.key));
  const zeros = [...have.entries()].filter(([k, v]) => !wantKeys.has(k) && v.count !== 0)
    .map(([, v]) => ({ id: v.id, fields: { [D.count]: 0, [D.updated]: now } }));

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${DAILY}`;
  for (let i = 0; i < upserts.length; i += 10) {
    await airtable(url, { method: 'PATCH', body: JSON.stringify({ performUpsert: { fieldsToMergeOn: [D.key] }, records: upserts.slice(i, i + 10) }) });
    await sleep(220);
  }
  for (let i = 0; i < zeros.length; i += 10) {
    await airtable(url, { method: 'PATCH', body: JSON.stringify({ records: zeros.slice(i, i + 10) }) });
    await sleep(220);
  }
  return { from, logs: logs.length, rows: want.length, written: upserts.length, zeroed: zeros.length,
    total: want.reduce((s, c) => s + c.count, 0) };
}

// ---- 本人の実績（2026-11-08）----
// 工程画面・照合画面のログイン帯に「今日 ○件・今月 ○件」を出す（今は本人が自分の件数を知る方法が無いため）。数え方は countDaily と同じ。
// 今日と昨日は作業ログから数える（毎晩の集計は 23:50 なので、今日と昨日の最後の分はまだ日別の表に無い）。
// 一昨日以前（今月の1日から）は TableIncentiveDaily から読む。
// API の回数を抑えるため、作業ログの集計は全員分をまとめて2分使い回し、日別の表は本人・日付ごとにその日の間使い回す。
// fresh（本人が記録した直後）は、集計が20秒より古ければ読み直す
const LIVE_CACHE_MS = 2 * 60 * 1000;
const LIVE_FRESH_MS = 20 * 1000;
let liveCache = null;           // { at, today, counts }
const pastCache = new Map();    // `${社員番号}|${今日}` → [{ date, step, count }]

// live（countDaily の結果）と past（日別の表の行）から本人の 今日・昨日・今月 をまとめる（純粋な計算）
export function summarizeMine(no, live, past, today, yesterday) {
  const monthFrom = today.slice(0, 8) + '01';
  const rows = [
    ...past.filter(r => r.date >= monthFrom && r.date < yesterday),
    ...[...live.values()].filter(c => c.no === no && (c.date === today || c.date === yesterday)),
  ].filter(r => r.count > 0);
  const sum = (list) => {
    const by = new Map();
    for (const r of list) by.set(r.step, (by.get(r.step) || 0) + r.count);
    const steps = [...by].map(([step, count]) => ({ step, count })).sort((a, b) => b.count - a.count || a.step.localeCompare(b.step));
    return { total: steps.reduce((s, x) => s + x.count, 0), steps };
  };
  return {
    today: { date: today, ...sum(rows.filter(r => r.date === today)) },
    yesterday: { date: yesterday, total: sum(rows.filter(r => r.date === yesterday)).total },
    month: { from: monthFrom, ...sum(rows.filter(r => r.date >= monthFrom)) },
  };
}

export async function myStats(no, { fresh = false } = {}) {
  const today = daysAgoJST(0), yesterday = daysAgoJST(1);
  const age = liveCache && liveCache.today === today ? Date.now() - liveCache.at : Infinity;
  if (age > (fresh ? LIVE_FRESH_MS : LIVE_CACHE_MS)) {
    // 昨日の日本時間 0:00 から（取り消しの相手を見るため、昨日の分も読む）
    const since = new Date(Date.parse(`${yesterday}T00:00:00+09:00`) - 1000).toISOString();
    const logs = await readAll(WORKLOG,
      `AND(IS_AFTER({${WL.at}}, '${since}'), OR({${WL.credit}}, ${CANCEL_ACTIONS.map(a => `{${WL.action}}='${a}'`).join(', ')}))`,
      Object.values(WL));
    liveCache = { at: Date.now(), today, counts: countDaily(logs) };
  }
  const pk = `${no}|${today}`;
  let past = pastCache.get(pk);
  if (!past) {
    const monthFrom = today.slice(0, 8) + '01';
    past = monthFrom >= yesterday ? [] : (await readAll(DAILY,
      `AND({${D.no}}=${no}, NOT(IS_BEFORE({${D.date}}, '${monthFrom}')), IS_BEFORE({${D.date}}, '${yesterday}'), {${D.count}}>0)`,
      [D.date, D.step, D.count])).map(r => ({ date: String(r.fields?.[D.date] || ''), step: String(r.fields?.[D.step] || ''), count: Number(r.fields?.[D.count] || 0) }));
    if (pastCache.size > 300) pastCache.clear();
    pastCache.set(pk, past);
  }
  return summarizeMine(no, liveCache.counts, past, today, yesterday);
}
