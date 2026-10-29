// api/_incentive.js
// インセンティブ用の「日付 × 社員番号 × 工程 → 件数」を TableWorkLog から作り、TableIncentiveDaily に書く（2026-10-28）。
// 給料計算（Booksky_net）はこの表を 社員番号と日付の範囲（社員20日締め／パート月末締め）で合計する。
//
// 数え方:
//  ・工程完了／工程取消／工程完了取消 は 受注ID＋工程 ごとに時刻順に並べ、最後が「完了」ならその完了をした人に1件、
//    最後が取消なら0件（押し間違いの取消、別の人がやり直した場合はやり直した人に付く）。
//  ・状況報告／状況報告取消（工程カードの「シート材料入荷済」。2026-10-29）も同じく 受注ID＋工程 の最後の状態で数える。
//  ・探す（抜型照合）・仕舞う（抜型仕舞い）・知る（生地照合）は、実績対象 が付いた行を1件ずつ数える（取消は無い）。
//  ・社員番号が無いログ（10/7 以前）は数えない。対象は 2026-10-08（日本時間）以降。
//  ・日付は記録した時刻の日本時間の日。
// 実行: 毎晩の Vercel Cron（vercel.json）と、管理者が /api/session?action=incentive を開いたとき。
//  直近45日を作り直す（翌日以降の取消も反映するため）。&full=1 で 10/8 から全部作り直す。
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

export async function runIncentive({ full = false } = {}) {
  const from = full ? START_DATE : [START_DATE, daysAgoJST(WINDOW_DAYS)].sort().pop();
  // 取消の相手（その前の完了）を見落とさないよう、ログは常に START_DATE の前日から読む
  const logs = await readAll(WORKLOG,
    `AND(IS_AFTER({${WL.at}}, '2026-10-07T00:00:00.000Z'), OR({${WL.credit}}, ${CANCEL_ACTIONS.map(a => `{${WL.action}}='${a}'`).join(', ')}))`,
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
