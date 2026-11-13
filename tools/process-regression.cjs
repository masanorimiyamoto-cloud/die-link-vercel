// tools/process-regression.cjs
// public/process.html の一覧読み込み・書き込み結果の扱いの回帰テスト（2026-10-23 再レビュー R1〜R5）。
// 関数をページから抜き出し、DOM・通信・認証はすべて作り物で動かす。本番の API・Airtable には触れない。
// 実行: node tools/process-regression.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
// ログインの署名（api/_auth.js）は読み込み時にこの値を読むので、どのテストより先に入れておく（試験用。本番の値ではない）
process.env.SESSION_SECRET = 'TEST_ONLY_SESSION_SECRET_0123456789abcdef';

// PROCESS_HTML で別の版を指定できる（修正前の版で落ちることの確認用）
const source = fs.readFileSync(process.env.PROCESS_HTML || path.join(__dirname, '..', 'public', 'process.html'), 'utf8');
function extract(name) {
  const m = source.match(new RegExp('^  (?:async )?function ' + name + '\\([^]*?^  }', 'm'));
  if (!m) throw new Error('関数が見つかりません: ' + name);
  return m[0];
}
const line = (re) => { const m = source.match(re); if (!m) throw new Error('見つかりません: ' + re); return m[0]; };

function elem() {
  return { hidden: true, textContent: '', className: '', disabled: false, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {} }, scrollIntoView() {}, focus() {}, querySelectorAll: () => [] };
}
// loadView とその周り（canAutoLoad・showListMsg）を、作り物の画面で動かす
function listEnv(api) {
  const nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, elem()); return nodes.get(id); };
  $('viewer').hidden = true;
  const env = {
    $, api, nodes, renders: 0,
    S: { mode: 'list', sel: null, view: 'kikai', views: [], orders: [], filter: 'all', listAt: 0, listFail: false },
    document: { hidden: false, querySelector: () => null },
    FILTERS: [['all', 'すべて'], ['ready', '着手可'], ['wait', '待ち'], ['done', '自工程済']],
    imgById: new Map(), store: { set() {} }, shownSig: '', writing: 0,
    seen: { update() {}, leave() {} }, // Recent 1day の変化の印（RC1 で別に確かめる）
    rowsSig: (rows) => JSON.stringify(rows),
    say: (el, text, cls = '') => { el.textContent = text || ''; el.className = 'msg ' + cls; },
    renderChips() {}, updateListHead() {}, loadImages() {}, showFresh() {}, refreshUpd() {},
  };
  env.renderList = function () { env.renders++; env.S.shown = env.S.orders.length; env.showListMsg(); };
  vm.createContext(env);
  vm.runInContext([
    line(/^  const detailOpen = .*$/m), line(/^  const canAutoLoad = .*$/m),
    'let listGen = 0, listBusy = 0;', extract('loadView'), extract('showListMsg'),
    'globalThis.loadView = loadView; globalThis.canAutoLoad = canAutoLoad; globalThis.showListMsg = showListMsg;',
    'globalThis.bumpGen = () => { listGen++; listBusy = 0; };',
  ].join('\n'), env);
  return env;
}
const views = [{ key: 'kikai', label: '機械貼' }, { key: 'taoshi', label: 'たおし抜き' }];
const ok = (view, rows, cachedAt) => ({ ok: true, view, views, steps: [], rooms: [], rows, cachedAt });
function deferredApi() {
  const q = [];
  const api = (body) => new Promise((resolve) => q.push({ body, resolve }));
  return { q, api };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- R1 ----
test('R1 カードを閉じた後は、行の選択表示が残っていても自動の読み直しが動く', async () => {
  const e = listEnv(async () => ok('kikai', [], 1));
  e.$('stepCard').hidden = false; e.S.sel = 'recA';
  assert.equal(e.canAutoLoad(), false, 'カードを開いている間は止める');
  e.$('stepCard').hidden = true; // backToRow / 一覧へ戻る はカードを閉じ、S.sel は残す
  assert.equal(e.S.sel, 'recA');
  assert.equal(e.canAutoLoad(), true);
});
test('R1 書き込み中・画像の全画面表示中・画面が隠れている間は自動の読み直しをしない', async () => {
  const e = listEnv(async () => ok('kikai', [], 1));
  e.$('stepCard').hidden = true;
  vm.runInContext('writing = 1', e); assert.equal(e.canAutoLoad(), false); vm.runInContext('writing = 0', e);
  e.$('viewer').hidden = false; assert.equal(e.canAutoLoad(), false); e.$('viewer').hidden = true;
  e.document.hidden = true; assert.equal(e.canAutoLoad(), false); e.document.hidden = false;
  assert.equal(e.canAutoLoad(), true);
});
test('R1 自動の読み直しの途中でカードを開いたら、その結果は画面に使わない', async () => {
  const d = deferredApi(); const e = listEnv(d.api);
  e.$('stepCard').hidden = true;
  const p = e.loadView('kikai', false, true);
  e.$('stepCard').hidden = false;
  d.q[0].resolve(ok('kikai', [{ id: 'new' }], 5));
  assert.equal(await p, false);
  assert.deepEqual(e.S.orders, []);
});

// ---- R2 ----
test('R2 機械貼→たおし抜き と続けて押し、応答が逆順でも たおし抜き のまま', async () => {
  const d = deferredApi(); const e = listEnv(d.api);
  const a = e.loadView('kikai'); const b = e.loadView('taoshi');
  d.q[1].resolve(ok('taoshi', [{ id: 'T' }], 2)); assert.equal(await b, true);
  d.q[0].resolve(ok('kikai', [{ id: 'K' }], 1)); assert.equal(await a, false);
  assert.equal(e.S.view, 'taoshi');
  assert.equal(e.S.orders[0].id, 'T');
  assert.equal(e.S.listAt, 2);
});
test('R2 同じリストで、先に始めた自動の読み直しが手動の更新より後に返っても古い内容・時刻に戻らない', async () => {
  const d = deferredApi(); const e = listEnv(d.api);
  e.$('stepCard').hidden = true;
  const old = e.loadView('kikai', false, true);
  const fresh = e.loadView('kikai', true, false);
  d.q[1].resolve(ok('kikai', [{ id: 'new' }], 2000)); assert.equal(await fresh, true);
  d.q[0].resolve(ok('kikai', [{ id: 'old' }], 1000)); assert.equal(await old, false);
  assert.equal(e.S.orders[0].id, 'new');
  assert.equal(e.S.listAt, 2000);
});
test('R2 手動の読み込み中は自動の読み直しを重ねない', async () => {
  const d = deferredApi(); const e = listEnv(d.api);
  e.$('stepCard').hidden = true;
  const manual = e.loadView('kikai', true, false);
  assert.equal(await e.loadView('kikai', false, true), false);
  assert.equal(d.q.length, 1, '自動の要求は送らない');
  d.q[0].resolve(ok('kikai', [{ id: 'M' }], 3)); assert.equal(await manual, true);
});
test('R2 古い要求の失敗は、新しい成功の表示を「更新失敗」に変えない', async () => {
  const d = deferredApi(); const e = listEnv(d.api);
  const a = e.loadView('kikai'); const b = e.loadView('kikai', true);
  d.q[1].resolve(ok('kikai', [{ id: 'N' }], 9)); await b;
  d.q[0].resolve({ ok: false, error: 'mock 502' }); assert.equal(await a, false);
  assert.equal(e.S.listFail, false);
  assert.equal(e.$('listRetry').hidden, true);
  assert.equal(e.S.orders[0].id, 'N');
});
test('R2 品番で探すに切り替えた後の一覧の応答は、画面の状態を書き換えない', async () => {
  const d = deferredApi(); const e = listEnv(d.api);
  e.S.orders = [{ id: 'F' }];
  const p = e.loadView('kikai');
  e.S.mode = 'find'; e.bumpGen(); // setMode('find') と同じ
  d.q[0].resolve(ok('kikai', [{ id: 'K' }], 1)); assert.equal(await p, false);
  assert.equal(e.S.orders[0].id, 'F');
  assert.equal(e.S.listFail, false);
});

// ---- R4 ----
test('R4 読み込み失敗のあと同じ内容で自動の読み直しが成功したら、本文の失敗の案内も消える', async () => {
  let reply = { ok: false, error: 'mock 502' };
  const e = listEnv(async () => reply);
  e.$('stepCard').hidden = true;
  e.S.listAt = 1000; e.S.orders = [{ id: 'A' }]; e.S.shown = 1;
  e.shownSig = JSON.stringify([{ id: 'A', images: [] }]); // loadView は images を付けてから比べる
  assert.equal(await e.loadView('kikai', true, false), false);
  assert.match(e.$('listMsg').className, /err/);
  assert.equal(e.$('listRetry').hidden, false);
  reply = ok('kikai', [{ id: 'A' }], 2000);
  assert.equal(await e.loadView('kikai', false, true), true);
  assert.equal(e.renders, 0, '同じ内容なので行は作り直さない');
  assert.equal(e.S.listFail, false);
  assert.equal(e.$('listRetry').hidden, true);
  assert.doesNotMatch(e.$('listMsg').className, /err/);
  assert.equal(e.$('listMsg').textContent, '1件');
});
test('R4 失敗の案内でなければ、同じ内容の自動の読み直しでは本文の案内（記録しました等）を消さない', async () => {
  const e = listEnv(async () => ok('kikai', [{ id: 'A' }], 2));
  e.$('stepCard').hidden = true; e.S.listAt = 1; e.S.orders = [{ id: 'A' }];
  e.shownSig = JSON.stringify([{ id: 'A', images: [] }]); // loadView は images を付けてから比べる
  e.say(e.$('listMsg'), '機械貼完了 を記録しました', 'ok');
  await e.loadView('kikai', false, true);
  assert.equal(e.$('listMsg').textContent, '機械貼完了 を記録しました');
});

// ---- R3 ----
function apiEnv(fetchImpl, extra = {}) {
  const env = { fetch: fetchImpl, DLAuth: { csrf: async () => 'MOCK', loginUrl: () => '/login' }, location: { replace() {} },
    AbortController, setTimeout, clearTimeout, ...extra };
  vm.createContext(env);
  vm.runInContext(extract('api') + '\n' + line(/^  const outcomeUnknown = .*$/m) + '\nglobalThis.api = api; globalThis.outcomeUnknown = outcomeUnknown;', env);
  return env;
}
const res = (status, text) => ({ status, text: async () => { if (text instanceof Error) throw text; return text; } });
test('R3 送れなかった・本文が途中で切れた・壊れた JSON は、どれも「結果不明」', async () => {
  const cases = [
    apiEnv(async () => { throw new TypeError('Failed to fetch'); }),
    apiEnv(async () => res(200, new TypeError('network error while reading body'))),
    apiEnv(async () => res(200, '{"ok":true,"stamp":"佐')),
    apiEnv(async () => res(502, '<html>Bad Gateway</html>')),
  ];
  for (const env of cases) {
    const j = await env.api({ action: 'complete' });
    assert.equal(j.ok, false); assert.equal(j.unknown, true);
    assert.equal(env.outcomeUnknown(j, () => true), true);
  }
});
// 2026-11-11 納期の保存で画面が何分も固まった件。応答が来ないまま止まった通信を待ち続けない
test('R3 応答が来ないまま止まった通信は30秒で打ち切り、「結果不明」として返す（送り直さない）', async () => {
  const waits = [];
  const soon = { setTimeout: (fn, ms) => { waits.push(ms); return setTimeout(fn, 5); } }; // 試験では30秒を5ミリ秒に縮める
  // 送ったきり応答が来ない
  let sends = 0, aborted = false;
  const a = apiEnv((url, init) => { sends++; init.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); }, soon);
  const j = await a.api({ action: 'ndate' });
  assert.deepEqual(waits, [30000]);
  assert.equal(j.ok, false); assert.equal(j.unknown, true); assert.equal(j.timeout, true);
  assert.equal(a.outcomeUnknown(j, () => true), true);
  assert.equal(aborted, true, '止まった通信は中断する');
  assert.equal(sends, 1);
  // 応答の頭は来たが本文が来ない／送る前の CSRF の取得で止まった
  const b = apiEnv(async () => ({ status: 200, text: () => new Promise(() => {}) }), soon);
  assert.equal((await b.api({ action: 'ndate' })).unknown, true);
  const c = apiEnv(async () => { throw new Error('送ってはいけない'); }, { ...soon, DLAuth: { csrf: () => new Promise(() => {}), loginUrl: () => '/login' } });
  assert.equal((await c.api({ action: 'ndate' })).unknown, true);
});
test('R3 時間内に返った応答はそのまま使い、待ち時間のタイマーを残さない', async () => {
  let cleared = 0;
  const env = apiEnv(async () => res(200, JSON.stringify({ ok: true, ndate: '2026-11-13' })), { clearTimeout: (t) => { cleared++; clearTimeout(t); } });
  const j = await env.api({ action: 'ndate' });
  assert.equal(j.ok, true); assert.equal(j.ndate, '2026-11-13'); assert.equal(j.unknown, undefined);
  assert.equal(cleared, 1);
});
test('R3 サーバーが JSON で返した拒否は「結果不明」にせず、理由をそのまま出す', async () => {
  const env = apiEnv(async () => res(400, JSON.stringify({ ok: false, error: '数量は整数で入れてください' })));
  const j = await env.api({ action: 'amount' });
  assert.equal(j.unknown, undefined);
  assert.equal(env.outcomeUnknown(j, () => true), false);
  assert.equal(j.error, '数量は整数で入れてください');
});
test('R3 成功と言いながら必要な値が欠けている応答は「結果不明」（画面の値を壊さない）', async () => {
  const env = apiEnv(async () => res(200, JSON.stringify({ ok: true })));
  const j = await env.api({ action: 'complete' });
  assert.equal(env.outcomeUnknown(j, (x) => !!x.stamp && !!x.value), true);
  assert.equal(env.outcomeUnknown({ ok: true, amount: 5 }, (x) => Number.isFinite(x.amount)), false);
});
test('R3 書き込みは1回だけ送る（結果不明でも送り直さない）', async () => {
  let sends = 0;
  const env = apiEnv(async () => { sends++; throw new TypeError('Failed to fetch'); });
  await env.api({ action: 'complete' });
  assert.equal(sends, 1);
});
test('R3 完了・取消・数量・納期・紙入荷日・Room・在庫シート利用 の書き込みは、どれも結果不明の扱い（markUnsure）を通る', async () => {
  for (const [fn, key] of [['saveComplete', 'complete'], ['cancelStep', 'cancel'], ['amountEditor', 'amount'], ['ndateEditor', 'ndate'], ['paperEditor', 'paper'], ['toggleRoom', 'room'], ['setStockOut', 'stock']]) {
    const body = extract(fn);
    assert.match(body, new RegExp(`write\\(\\{ action: '${key}'`), `${fn} は write() で送る`);
    assert.match(body, /outcomeUnknown\(j, /, `${fn} は結果不明を見分ける`);
    assert.match(body, /markUnsure\(o, /, `${fn} は結果不明を案内する`);
  }
});

// ---- R5 ----
function detailEnv(loadOk, rowsAfter) {
  const nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, elem()); return nodes.get(id); };
  const env = { $, nodes, steps: 0, orders: 0,
    S: { mode: 'list', sel: 'recA', view: 'kikai', orders: [{ id: 'recA', done: {} }], unsure: { id: 'recA', what: '記録' } },
    say: (el, text, cls = '') => { el.textContent = text || ''; el.className = 'msg ' + cls; },
    document: { querySelector: () => null },
  };
  env.renderSteps = () => { env.steps++; };
  env.renderOrders = () => { env.orders++; };
  env.loadView = async () => { if (loadOk) env.S.orders = rowsAfter; return loadOk; };
  vm.createContext(env);
  vm.runInContext(line(/^  const current = .*$/m) + '\n' + extract('syncDetail') + '\nglobalThis.syncDetail = syncDetail;', env);
  // 「記録の状態を確認」ボタンの処理（$('unsureBtn').onclick = async () => {...};）を取り出して動かす
  const click = source.match(/\$\('unsureBtn'\)\.onclick = (async \(\) => \{[^]*?\n  \});/)[1];
  vm.runInContext('globalThis.reloadFind = async () => false; globalThis.checkState = ' + click + ';', env);
  $('stepCard').hidden = false;
  return env;
}
test('R5 結果不明→サーバーでは完了済み→「記録の状態を確認」で、開いている受注のカードも済に作り直す', async () => {
  const e = detailEnv(true, [{ id: 'recA', done: { kikai: 'テスト 2026-10-23 12:00' } }]);
  await e.checkState();
  assert.equal(e.steps, 1, 'カードを作り直す');
  assert.equal(e.S.unsure, null, '確認できたので止めを外す');
  assert.ok(e.S.orders[0].done.kikai);
  assert.equal(e.$('stepCard').hidden, false);
  assert.match(e.$('stepMsg').className, /ok/);
});
test('R5 状態の確認で受注が一覧から外れていたら、カードを閉じて知らせる', async () => {
  const e = detailEnv(true, []);
  await e.checkState();
  assert.equal(e.$('stepCard').hidden, true);
  assert.equal(e.S.sel, null);
  assert.match(e.$('listMsg').textContent, /外れました/);
});
test('R5 読み込みに失敗したら「確認できた」ことにしない', async () => {
  const e = detailEnv(false, null);
  await e.checkState();
  assert.equal(e.steps, 0);
  assert.deepEqual(e.S.unsure, { id: 'recA', what: '記録' });
  assert.match(e.$('stepMsg').className, /err/);
});
test('R5 一覧の「更新」は、読めたときだけ開いている受注のカードも合わせる', async () => {
  assert.match(extract('renderChips'), /if \(await loadView\(S\.view, true\)\) syncDetail\(/);
});
test('R5 自動の読み直しはカードを作り直さない（入力中の数量・納期を消さない）', async () => {
  assert.doesNotMatch(extract('loadView'), /syncDetail|renderSteps/);
});

// ---- 2026-11-03 作業共有画面の改善（docs/claude-process-ui-implementation.md）----
// 判定の関数をページから抜き出し、サーバーの定義（publicViews / publicSteps と同じ形）で動かす
const P6 = { cad: ['cad'], omamori: ['finish'], auton: ['o'], kikai: ['kikai'], taoshi: ['tk', 'tm'], tebari: ['tebari'], f2: ['finish', 'seal'], nao: ['finish', 'seal'], dansai: ['finish'], pre: ['finish'] };
const V6 = [...Object.entries(P6).map(([key, mine]) => ({ key, label: key, mine,
  mineValues: { auton: ['抜き半製品あり'], taoshi: ['抜き半製品あり'], tebari: ['(神)貼り完了', '(花)貼り完了'] }[key] || [] })),
  { key: 'all', label: '全件', mine: [], mineValues: [] }];
const ST6 = [['kiji', '生地カット終了'], ['o', 'オートン抜き完了', 'オートン'], ['tk', '(K判)たおし抜き完了', 'たおしK判'], ['tm', '(M判)たおし抜き完了', 'たおしM判'],
  ['cad', 'CADカット完了', 'CAD'], ['tebari', '手貼り完了', '花'], ['kikai', '機械貼完了', '機械貼'], ['seal', 'シール貼完了'], ['finish', '仕上がりました'],
  ['hansei', '抜き半製品あり', '', 'status'], ['zaiko', '製品在庫から', '', 'status']]
  .map(([key, label, tag = '', group = 'done']) => ({ key, label, group, variants: [{ key: '-', label, value: label, tag }] }));
function planEnv() {
  const env = { S: { steps: ST6, views: V6, rooms: [] } };
  vm.createContext(env);
  vm.runInContext([
    line(/^  const ITEM_TAG = \{[^]*?\};.*$/m), line(/^  const VIEW_TAG = .*$/m), line(/^  const hasMine = .*$/m), line(/^  const hasTag = .*$/m),
    line(/^  const roomLabel = .*$/m), line(/^  const stampTime = .*$/m), line(/^  const shortStamp = .*$/m), line(/^  const PRIMARY = .*$/m),
    line(/^  const AMT_LOG = .*$/m), line(/^  const NDATE_LOG = .*$/m),
    ...['itemTagInfo', 'itemTags', 'doneSteps', 'mineDone', 'viewTags', 'tagDone', 'primaryPlan', 'nextGuide', 'recTime', 'logTime', 'latestChanges', 'fmtChange'].map(extract),
    'Object.assign(globalThis, { itemTagInfo, itemTags, primaryPlan, nextGuide, recTime, latestChanges, fmtChange });',
  ].join('\n'), env);
  return env;
}
const ord = (p) => ({ id: 'recT', item: '', kotei: '', progIn: '', progOut: '', group: '', closed: false, done: {}, amount: 100, ndate: '', ...p });
const view = (k) => V6.find(v => v.key === k);
const keys = (e, o, k) => e.primaryPlan(o, k ? view(k) : null).keys.join(',');

test('N1 主操作: 機械貼は機械貼完了。お守箔焼印・断裁・プレ・全件・検索は選ばせる', () => {
  const e = planEnv();
  assert.equal(keys(e, ord({ kotei: '|機械貼|' }), 'kikai'), 'kikai');
  for (const k of ['omamori', 'dansai', 'pre', 'all', null]) assert.equal(keys(e, ord({ kotei: '|オートン|' }), k), '', String(k));
});
test('N1 主操作: CAD は CADカット完了 と 仕上がりました の2つ', () => {
  const e = planEnv();
  assert.equal(keys(e, ord({ kotei: '|CAD|' }), 'cad'), 'cad,finish');
});
test('N1 主操作: たおしは K判・M判 の片方だけなら確定、両方・なしは2つ（自動で選ばない）', () => {
  const e = planEnv();
  assert.equal(keys(e, ord({ kotei: '|たおしK判|' }), 'taoshi'), 'tk');
  assert.equal(keys(e, ord({ kotei: '|たおしM判|' }), 'taoshi'), 'tm');
  assert.equal(keys(e, ord({ kotei: '|たおしK判|たおしM判|' }), 'taoshi'), 'tk,tm');
  assert.equal(keys(e, ord({ kotei: '' }), 'taoshi'), 'tk,tm');
});
test('N1 主操作: Nao・2F 小は シール貼・仕上がり を両方。片方済なら済扱いで主ボタンは出さない', () => {
  const e = planEnv();
  assert.equal(keys(e, ord({}), 'nao'), 'seal,finish');
  const p = e.primaryPlan(ord({ done: { seal: '高橋 2026-11-02 16:20' }, progIn: 'シール貼完了' }), view('f2'));
  assert.equal(p.keys.length, 0); assert.ok(p.md);
});
test('N1 主操作: 閉じた受注・抜き半製品あり・旧手貼り名・最終 は完了ボタンを出さず、記録者を作らない', () => {
  const e = planEnv();
  assert.equal(e.primaryPlan(ord({ closed: true, progOut: '伝票取消' }), view('kikai')).keys.length, 0);
  const h = e.primaryPlan(ord({ progIn: '抜き半製品あり' }), view('auton'));
  assert.equal(h.md.label, '抜き半製品あり'); assert.equal(h.md.who, '');
  assert.equal(e.primaryPlan(ord({ progIn: '(花)貼り完了' }), view('tebari')).md.who, '');
  assert.equal(e.primaryPlan(ord({ group: '最終', progIn: '仕上がりました' }), view('auton')).md.who, '仕上がり済');
});
test('N2 工程順: itemTags の結果・順序は品名タグ優先のまま（#o#nao#ki）', () => {
  const e = planEnv();
  assert.deepEqual([...e.itemTags(ord({ item: 'X #o#nao#ki', kotei: '|オートン|機械貼|Nao|' }))], ['オートン', 'Nao', '機械貼']);
  assert.deepEqual([...e.itemTags(ord({ item: 'X #o', kotei: '|オートン|福祉|' }))], ['オートン', '福祉']);
});
test('N2 残工程: 品名で説明できるときだけ → で並べ、補ったタグ・未対応タグ・タグなし・検索は断定しない', () => {
  const e = planEnv();
  const g = e.nextGuide(ord({ item: 'X #o#nao#ki', kotei: '|オートン|機械貼|Nao|', done: { o: '佐藤 2026-11-01 10:00' }, progIn: 'オートン抜き完了' }), view('kikai'));
  assert.equal(g.kind, 'order'); assert.match(g.text, /Nao → 機械貼/); assert.match(g.next, /次の工程候補：Nao/);
  const m = e.nextGuide(ord({ item: 'X #o', kotei: '|オートン|福祉|' }), view('auton'));
  assert.equal(m.kind, 'maybe'); assert.doesNotMatch(m.text, /→/);
  assert.equal(e.nextGuide(ord({ item: 'X', kotei: '' }), view('kikai')).kind, 'none');
  assert.equal(e.nextGuide(ord({ item: 'X #ki', kotei: '|機械貼|' }), null).kind, 'nodata');
});
test('N2 残工程が空: 仕上がり・最終・閉じた・それ以外 を言い分け、全作業完了とは言わない', () => {
  const e = planEnv();
  assert.equal(e.nextGuide(ord({ done: { finish: 'a 2026-11-01 10:00' } }), view('kikai')).text, '仕上がりの記録があります');
  assert.equal(e.nextGuide(ord({ group: '最終' }), view('kikai')).text, '現在は仕上がり済の扱いです');
  assert.match(e.nextGuide(ord({ closed: true, progOut: '伝票取消' }), view('kikai')).text, /伝票取消/);
  assert.match(e.nextGuide(ord({ item: 'X #ki', kotei: '|機械貼|', done: { kikai: 'a 2026-11-01 10:00' } }), view('kikai')).text, /表示できる残工程はありません/);
});
test('N3 最新の記録: 一番新しい項目だけ。同時刻は両方。不正・日付だけ・現在値と違うログは使わない', () => {
  const e = planEnv();
  const a = e.latestChanges(ord({ done: { o: '佐藤 2026-11-02 10:15' }, amount: 1200, amountLog: '1000→1200 田中 2026-11-03 14:32', printedAt: '2026-11-01 09:00' }));
  assert.deepEqual([...a.keys], ['amount']); assert.equal(e.fmtChange(a.t), '11/3 14:32');
  const b = e.latestChanges(ord({ done: { kikai: '鈴木 2026-11-03 11:00' }, ndate: '2026-11-10', ndateLog: '2026-11-08→2026-11-10 鈴木 2026-11-03 11:00' }));
  assert.deepEqual([...b.keys].sort(), ['ndate', 'step:kikai']);
  assert.equal(e.latestChanges(ord({ amount: 500, amountLog: '400→450 田中 2026-11-03 09:00', ndate: '2026-11-09',
    ndateLog: '2026-11-07→2026-11-09 田中 2026-13-40 25:99', printedAt: '2026-11-03' })), null);
});
test('N3 日時: タイムゾーン無しは日本時間、Z・オフセットは尊重。納期の日付を変更日時と取り違えない', () => {
  const e = planEnv();
  assert.equal(e.recTime('2026-11-03 14:32'), Date.UTC(2026, 10, 3, 5, 32));
  assert.equal(e.recTime('2026-11-03T05:32:00.000Z'), Date.UTC(2026, 10, 3, 5, 32));
  assert.equal(e.recTime('2026-11-03T14:32+09:00'), Date.UTC(2026, 10, 3, 5, 32));
  assert.equal(e.recTime('2026-11-03'), null);
  assert.equal(e.recTime('2026-02-30 10:00'), null);
  // 納期の変更後の日付（2026-12-31）ではなく、行末の操作日時（日付の境目 00:05 JST = 前日 15:05 UTC）
  const c = e.latestChanges(ord({ ndate: '2026-12-31', ndateLog: '2026-12-01→2026-12-31 田中 2026-11-04 00:05' }));
  assert.equal(c.t, Date.UTC(2026, 10, 3, 15, 5)); assert.equal(e.fmtChange(c.t), '11/4 00:05');
});
test('N4 二重操作: 書き込み中は次の操作を始めない。結果不明の受注・開いていない受注には書かない', async () => {
  const env = { S: { sel: 'recA', unsure: null }, writing: 0, msgs: [], locks: 0,
    $: () => ({}), say: (el, t) => env.msgs.push(t), applyLocks: () => { env.locks++; }, hideToast() {}, updateNav() {} };
  vm.createContext(env);
  vm.runInContext('let op = null, listGen = 0, listBusy = 0, findGen = 0;\n' + extract('runOp') + '\nglobalThis.runOp = runOp; globalThis.opNow = () => op;', env);
  let release; let runs = 0;
  const first = env.runOp({ id: 'recA' }, () => { runs++; return new Promise(r => { release = r; }); });
  assert.equal(env.writing, 1, '書き込み中は自動の読み直しも止まる');
  await env.runOp({ id: 'recA' }, async () => { runs++; });
  assert.equal(runs, 1, '2回目は送らない');
  release(); await first;
  assert.equal(env.opNow(), null); assert.equal(env.writing, 0);
  env.S.unsure = { id: 'recA' }; await env.runOp({ id: 'recA' }, async () => { runs++; }); assert.equal(runs, 1, '結果不明の受注には書かない');
  env.S.unsure = null; env.S.sel = 'recB'; await env.runOp({ id: 'recA' }, async () => { runs++; }); assert.equal(runs, 1, '開いている受注が変わっていたら送らない');
});
test('N4 書き込みの後にボタンを全部有効へ戻さない（もともと押せない・結果不明は止めたまま）', () => {
  for (const fn of ['doComplete', 'cancelStep', 'setStockOut', 'toggleRoom', 'paperEditor']) {
    assert.doesNotMatch(extract(fn), /disabled = false/, `${fn} は無条件に有効化しない`);
    assert.match(extract(fn), /runOp\(o, /, `${fn} は runOp を通す`);
  }
  assert.match(extract('applyLocks'), /b\.dataset\.off === '1'/);
  assert.match(extract('renderSteps'), /applyUnsure\(o\);\s*\/\/[^\n]*\n  }$/, '描画の最後に結果不明の止めを掛ける');
});
test('N5 保存後: 一覧の読み直しに失敗しても complete は送り直さず、保存済みと失敗を両方伝える', async () => {
  const env = { S: { orders: [], views: V6, steps: ST6 }, shown: null, back: null,
    itemShort: (o) => o.item, nextGuide: () => ({ kind: 'order', text: '工程記録から見た残り：A', next: '次の工程候補：A' }) };
  env.backToRow = (id, text, cls, t) => { env.back = { id, cls, t }; };
  vm.createContext(env);
  vm.runInContext(extract('afterComplete') + '\nglobalThis.afterComplete = afterComplete;', env);
  const o = { id: 'recA', book: 'Ko', wc: 1, item: '箱' };
  env.afterComplete(o, '機械貼完了', view('kikai'), false);
  assert.equal(env.back.cls, 'warn'); assert.equal(env.back.t.retry, true);
  assert.match(env.back.t.lines.join('\n'), /保存済み/); assert.match(env.back.t.lines.join('\n'), /一覧の更新に失敗/);
  assert.doesNotMatch(env.back.t.lines.join('\n'), /工程記録から見た残り/, '失敗時は次工程を断定しない');
  env.afterComplete(o, '機械貼完了', view('kikai'), true); // 一覧から外れた
  assert.match(env.back.t.lines.join('\n'), /保存した内容から見た候補/);
  env.S.orders = [o]; env.afterComplete(o, '機械貼完了', view('kikai'), true);
  assert.doesNotMatch(env.back.t.lines.join('\n'), /保存した内容から見た候補/);
  // 完了の送信は saveComplete の write 1回だけ（doComplete・数量確認・afterComplete・一覧の読み直しからは送らない）
  assert.equal((extract('saveComplete').match(/write\(/g) || []).length, 1);
  assert.equal((extract('doComplete').match(/write\(/g) || []).length, 0);
  assert.equal((extract('showAmountCheck').match(/action: 'complete'/g) || []).length, 0);
  assert.doesNotMatch(extract('afterComplete'), /write\(|api\(/);
});

// ---- 2026-11-03 実装後レビュー（docs/claude-process-ui-review.md）----
// 一覧の読み込み（loadView）と書き込み（runOp）を同じ作り物の画面で動かし、応答の順番を入れ替える
function raceEnv() {
  const d = deferredApi();
  const e = listEnv(d.api);
  Object.assign(e, { applyLocks() {}, hideToast() {}, updateNav() {} });
  vm.runInContext([
    'let op = null, findGen = 0;', line(/^  const current = .*$/m), extract('runOp'), extract('patch'),
    'globalThis.runOp = runOp; globalThis.patch = patch; globalThis.current = current;',
  ].join('\n'), e);
  e.$('stepCard').hidden = false;
  e.S.orders = [{ id: 'recA', amount: 100, ndate: '2026-11-06', room: [], done: {} }]; e.S.sel = 'recA';
  return { d, e };
}
for (const [what, apply, check] of [
  ['数量', (x) => { x.amount = 120; }, (o) => o.amount === 120],
  ['納期', (x) => { x.ndate = '2026-11-10'; }, (o) => o.ndate === '2026-11-10'],
  ['Room', (x) => { x.room = ['Nao']; }, (o) => o.room.includes('Nao')],
]) {
  test(`V1 先に始めた一覧の読み込み → ${what}を保存 → 古い一覧の応答 → 保存成功 でも、画面の受注は保存した値`, async () => {
    const { d, e } = raceEnv();
    const o = e.current();
    const load = e.loadView('kikai', true); // 一覧の「更新」（応答を待たせる）
    let release; const saved = new Promise(r => { release = r; });
    const op = e.runOp(o, async () => { await saved; e.patch(o, apply); });
    d.q[0].resolve(ok('kikai', [{ id: 'recA', amount: 100, ndate: '2026-11-06', room: [], done: {} }], 5)); // 保存前の値
    assert.equal(await load, false, '書き込みより前に始めた読み込みは使わない');
    release(); await op;
    assert.ok(check(e.current()), '開いている受注に保存した値が入っている');
  });
}
test('V1 保存の結果は、読み直しで置き換わった今の受注にも入る（操作を始めたときの ID で探す）', async () => {
  const { e } = raceEnv();
  const o = e.current();
  e.S.orders = [{ id: 'recA', amount: 100, done: {} }]; // 読み直しで別のものになった
  e.patch(o, x => { x.amount = 120; });
  assert.equal(o.amount, 120); assert.equal(e.current().amount, 120);
});
test('V1 書き込みの中で始めた一覧の読み直し（完了後の再取得）は使われる', async () => {
  const { d, e } = raceEnv();
  const o = e.current(); let got;
  await e.runOp(o, async () => {
    const p = e.loadView('kikai', true);
    d.q[0].resolve(ok('kikai', [{ id: 'recA', amount: 120, done: {} }], 7));
    got = await p;
  });
  assert.equal(got, true); assert.equal(e.current().amount, 120);
});
test('V1 数量・納期・紙入荷日・Room・材料・完了・取消 は保存の結果を patch で入れる', () => {
  for (const fn of ['amountEditor', 'ndateEditor', 'paperEditor', 'toggleRoom', 'setStockOut', 'saveComplete', 'showAmountCheck', 'cancelStep']) {
    assert.match(extract(fn), /patch\(o, x => /, fn);
  }
  for (const fn of ['search', 'itemSearch', 'reloadFind']) assert.match(extract(fn), /gen !== findGen/, `${fn} は古い応答を捨てる`);
});
// 「一覧だけ読み直す」の処理を取り出して動かす
function toastEnv() {
  const d = deferredApi();
  const nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, elem()); return nodes.get(id); };
  const env = { $, shown: 0, S: { mode: 'list', view: 'kikai', toast: null }, busyNow: () => false, say() {} };
  env.loadView = () => d.api({});
  vm.createContext(env);
  const click = source.match(/\$\('toastRetry'\)\.onclick = (async \(\) => \{[^]*?\n  \});/)[1];
  vm.runInContext([
    'let toastGen = 0;',
    'function showToast(t) { toastGen++; S.toast = t; globalThis.shown++; }',
    'function hideToast() { toastGen++; S.toast = null; }',
    'globalThis.retry = ' + click + ';', 'globalThis.showToast = showToast; globalThis.hideToast = hideToast;',
  ].join('\n'), env);
  env.showToast({ head: 'Ko / 1', lines: ['保存済みです'] }); env.shown = 0;
  return { d, env };
}
for (const [what, act] of [
  ['閉じる', (env) => env.hideToast()],
  ['別の受注を開く', (env) => env.hideToast()], // selectOrder は hideToast を呼ぶ
  ['品番で探すに切り替える', (env) => { env.hideToast(); env.S.mode = 'find'; }],
]) {
  test(`V3 「一覧だけ読み直す」を待つ間に${what}と、遅れて失敗しても前の案内は戻らない`, async () => {
    const { d, env } = toastEnv();
    const p = env.retry();
    act(env);
    d.q[0].resolve(false); await p;
    assert.equal(env.shown, 0); assert.equal(env.S.toast, null);
  });
}
test('V3 待つ間に何もしなければ、失敗はその案内に出し直す', async () => {
  const { d, env } = toastEnv();
  const p = env.retry(); d.q[0].resolve(false); await p;
  assert.equal(env.shown, 1);
});
test('V3 selectOrder・setMode・検索・ビューの切り替え・書き込みの開始は案内を消す', () => {
  for (const fn of ['selectOrder', 'setMode', 'search', 'itemSearch', 'runOp']) assert.match(extract(fn), /hideToast\(\)/, fn);
  assert.match(extract('renderChips'), /hideToast\(\)/);
});
test('V2 補助の工程・種類から記録したときは、押した領域の近くにも結果・失敗の理由を出す', () => {
  assert.match(extract('renderStepLists'), /chooseStep\(s, \(s\.group === 'status' \? status : other\)\.parentNode\)/);
  assert.match(extract('chooseStep'), /doComplete\(s, v, false, near\)/);
  const dc = extract('saveComplete');
  assert.match(dc, /sayAt\(near, '記録しています…'\)/);
  assert.match(dc, /return sayAt\(near, j\.error/);
  assert.match(dc, /\$\('stepMsg'\)\.scrollIntoView/, '先に記録されていたときは案内の位置まで動かす');
});
test('V4 壊れた時差・途中で切れた日時は null。日本時間の既存の書式と正しい時差はそのまま', () => {
  const e = planEnv();
  assert.equal(e.recTime('2026-11-03T14:32:00+99:99'), null);
  assert.equal(e.recTime('2026-11-03T14:32:00+09:xx'), null);
  assert.equal(e.recTime('佐藤 2026-11-03 14:32x'), null);
  assert.equal(e.recTime('佐藤 2026-11-03 14:32'), Date.UTC(2026, 10, 3, 5, 32));
  assert.equal(e.recTime('2026-11-03T14:32:00.000+09:00'), Date.UTC(2026, 10, 3, 5, 32));
  assert.equal(e.recTime('2026-11-03T05:32:00-0000'), Date.UTC(2026, 10, 3, 5, 32));
  assert.equal(e.recTime('2026-11-03T00:32-05:00'), Date.UTC(2026, 10, 3, 5, 32));
});

test('A1 承認済のボタンは新規受注の横。確認してから1件ずつ書き、結果不明は止める。承認済なら押せない印だけ', () => {
  const has = (src, s, msg) => assert.ok(src.includes(s), msg || s);
  const ctl = extract('approveCtl');
  has(extract('renderNewOrder'), 'top.append(open, approveCtl(o, box), delSlot)');
  has(ctl, "b.textContent = '✓ 承認済';");
  has(ctl, "btn.dataset.w = '1';");
  has(ctl, 'if (!confirm(');
  has(ctl, 'await runOp(o, async');
  has(ctl, "write({ action: 'approve', id: o.id })");
  has(ctl, "if (outcomeUnknown(j, x => x.approved === true)) return markUnsure(o, '承認');");
  has(ctl, 'patch(o, x => { x.approved = true; });');
  assert.ok(ctl.indexOf('if (o.approved)') < ctl.indexOf("createElement('button')"), '承認済ならボタンを作らない');
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', '_process.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(api, /PROCESS_ACTIONS = new Set\([^)]*'approve'/);
  const fn = api.slice(api.indexOf('async function approveOrder'), api.indexOf('async function undo'));
  has(fn, 'fields: { [F.approved]: true }', '承認済だけを ON にする');
  has(fn, 'if (f[F.approved]) return json({ ok: true, approved: true, unchanged: true });');
  has(api, 'approved: !!f[F.approved]');
});

// ---- 削除台帳（サーバー）: 偽の Airtable に対して api/_process.js の削除を動かす。本物の Airtable には繋がない ----
async function ledgerEnv(opt = {}) {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const calls = [];
  const orders = new Map(Object.entries(opt.orders || {}));
  const ledger = new Map(); let n = 0;
  for (const r of opt.ledger || []) ledger.set(r.id, r);
  const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
  const ng = (s) => new Response('{"error":"TEST"}', { status: s });
  const fail = opt.fail || {};
  const prevFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); const m = init.method || 'GET';
    if (u.hostname !== 'api.airtable.com') throw new Error('unexpected host ' + u.hostname);
    const parts = u.pathname.split('/'); const table = decodeURIComponent(parts[3] || ''); const rid = parts[4];
    const kind = table === 'TableJuchu' ? 'order' : table === 'tblpQzjyEoYQO9Ala' ? 'ledger' : table === 'tblQFZ7QEuRaBW4oj' ? 'worklog' : 'other:' + table;
    calls.push(`${m} ${kind}${rid ? ' ' + rid : ''}`);
    if (fail[`${m} ${kind}`]) return ng(fail[`${m} ${kind}`]);
    if (kind === 'order') {
      if (m === 'GET') return orders.has(rid) ? ok(orders.get(rid)) : ng(404);
      if (m === 'DELETE') { if (!orders.has(rid)) return ng(404); orders.delete(rid); return ok({ id: rid, deleted: true }); }
    }
    if (kind === 'ledger') {
      if (m === 'GET') { const q = /'(.+)'/.exec(u.searchParams.get('filterByFormula') || '')?.[1]; return ok({ records: [...ledger.values()].filter(r => r.fields['削除要求ID'] === q) }); }
      if (m === 'POST') { const f = JSON.parse(init.body).records[0].fields; const r = { id: 'recLEDGER' + String(++n).padStart(8, '0'), fields: f }; ledger.set(r.id, r); return ok({ records: [r] }); }
      if (m === 'PATCH') { const x = JSON.parse(init.body).records[0]; Object.assign(ledger.get(x.id).fields, x.fields); return ok({ records: [ledger.get(x.id)] }); }
    }
    if (kind === 'worklog') return ok({ records: [] });
    return ng(500);
  };
  const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_process.js')).href);
  const run = async (body) => { try { const r = await mod.handleProcess('delete', body, { user: { id: 'recSTAFF0000000001', no: 9001, name: 'テスト 太郎' } }); return { status: r.status, j: await r.json() }; } finally { /* keep fetch for inspection */ } };
  return { run, calls, orders, ledger, restore: () => { global.fetch = prevFetch; } };
}
const pendingOrder = (id, extra = {}) => ({ id, fields: { Book: 'Ko', WorkCord: 9017, ItemName: '検証新規 #ki', NAmount: 1000, Ndate: '2026-11-06', Add_from_Airtable: true, 承認済: true, 進行社内: '工程表発行済', ...extra } });
const RID = 'recTESTORDER00001', REQ = 'del-11111111-2222-3333-4444-555555555555';

test('L1 削除台帳に書けなければ受注は消さない', async () => {
  const e = await ledgerEnv({ orders: { [RID]: pendingOrder(RID) }, fail: { 'POST ledger': 422 } });
  try {
    const r = await e.run({ id: RID, reqId: REQ });
    assert.equal(r.status, 502); assert.match(r.j.error, /削除台帳に書けなかったので、削除していません/);
    assert.ok(!e.calls.some(c => c.startsWith('DELETE')), e.calls.join(','));
    assert.ok(e.orders.has(RID));
  } finally { e.restore(); }
});
test('L1 順番は 台帳(受付済)→受注の削除→台帳(Airtable削除済)。台帳に RecordID・内容・操作者・理由を残す', async () => {
  const e = await ledgerEnv({ orders: { [RID]: pendingOrder(RID) } });
  try {
    const r = await e.run({ id: RID, reqId: REQ, reason: '打ち間違い' });
    assert.equal(r.j.ok, true); assert.equal(r.j.ledger, 'Airtable削除済'); assert.equal(r.j.ledgerWarn, false);
    const w = e.calls.filter(c => !c.startsWith('GET'));
    assert.deepEqual(w.slice(0, 3), ['POST ledger', `DELETE order ${RID}`, 'PATCH ledger'], w.join(','));
    const f = [...e.ledger.values()][0].fields;
    assert.equal(f['削除要求ID'], REQ); assert.equal(f['受注RecordID'], RID); assert.equal(f['状態'], 'Airtable削除済');
    assert.equal(f['Excel登録前'], true); assert.equal(f['削除理由'], '打ち間違い'); assert.equal(f['操作者'], 'テスト 太郎'); assert.equal(f['社員番号'], 9001);
    assert.equal(f['NAmount'], 1000); assert.equal(f['Ndate'], '2026-11-06'); assert.equal(f['WorkCord'], '9017');
    assert.equal(JSON.parse(f['削除内容']).ItemName, '検証新規 #ki');
    assert.ok(f['受付日時'] && f['Airtable削除日時']);
  } finally { e.restore(); }
});
test('L1 同じ削除要求の送り直しは台帳から続きを処理し、受注を二度消さない・台帳を2行にしない', async () => {
  const e = await ledgerEnv({ orders: {}, ledger: [{ id: 'recLEDGER00000077', fields: { '削除要求ID': REQ, '受注RecordID': RID, '状態': '受付済', 'Excel登録前': true } }] });
  try {
    const r = await e.run({ id: RID, reqId: REQ });
    assert.equal(r.j.ok, true); assert.equal(r.j.ledger, 'Airtable削除済');
    assert.ok(!e.calls.some(c => c.startsWith('DELETE') || c === 'POST ledger'), e.calls.join(','));
    assert.equal(e.ledger.size, 1); assert.equal(e.ledger.get('recLEDGER00000077').fields['状態'], 'Airtable削除済');
    const r2 = await e.run({ id: RID, reqId: REQ });
    assert.equal(r2.j.ok, true); assert.equal(r2.j.again, true);
  } finally { e.restore(); }
});
test('L1 受注を消した後に台帳を更新できなくても成功として返し、台帳は受付済のまま（Excel 同期が続きを処理）', async () => {
  const e = await ledgerEnv({ orders: { [RID]: pendingOrder(RID) }, fail: { 'PATCH ledger': 422 } });
  try {
    const r = await e.run({ id: RID, reqId: REQ });
    assert.equal(r.j.ok, true); assert.equal(r.j.ledgerWarn, true); assert.equal(r.j.ledger, '受付済');
    assert.ok(!e.orders.has(RID)); assert.equal([...e.ledger.values()][0].fields['状態'], '受付済');
  } finally { e.restore(); }
});
test('L1 Excel 登録済の受注も消せる（2026-11-03）。台帳の Excel登録前 は OFF', async () => {
  const e = await ledgerEnv({ orders: { [RID]: pendingOrder(RID, { Add_from_Airtable: false }) } });
  try {
    const r = await e.run({ id: RID, reqId: REQ });
    assert.equal(r.j.ok, true); assert.equal(r.j.pre, false);
    assert.ok(!e.orders.has(RID));
    assert.equal([...e.ledger.values()][0].fields['Excel登録前'], false);
  } finally { e.restore(); }
});
test('L1 受注を読めないとき・工程の記録があるとき・削除要求ID なしは、台帳にも受注にも書かない', async () => {
  for (const [opt, body, st] of [
    [{ orders: { [RID]: pendingOrder(RID) }, fail: { 'GET order': 500 } }, { id: RID, reqId: REQ }, 502],
    [{ orders: { [RID]: pendingOrder(RID, { Add_from_Airtable: false, 進行社内: '機械貼完了' }) } }, { id: RID, reqId: REQ }, 409],
    [{ orders: { [RID]: pendingOrder(RID) } }, { id: RID }, 400],
  ]) {
    const e = await ledgerEnv(opt);
    try {
      const r = await e.run(body);
      assert.equal(r.status, st, JSON.stringify(r.j));
      assert.ok(!e.calls.some(c => !c.startsWith('GET')), e.calls.join(','));
    } finally { e.restore(); }
  }
});
test('L1 画面は削除要求IDを作って送り、結果不明のときは同じIDで送り直す', () => {
  const d = extract('renderDelete');
  assert.ok(d.includes("write({ action: 'delete', id: o.id, reqId: req.reqId, reason: req.reason })"));
  assert.ok(d.includes('S.delPending = req;'), '結果不明なら同じ要求を残す');
  assert.ok(d.includes("let req = S.delPending && S.delPending.id === o.id ? S.delPending : null;"));
  assert.ok(d.includes('Excel 反映待ち'));
});

// 路線便（品名に #路線）: 集荷は納期（着日）の前日、土日は金曜。出荷済は印だけ（2026-11-04）
function rosenEnv(today) {
  const mk = () => ({ className: '', textContent: '', kids: [], classList: { list: [], add(c) { this.list.push(c); } },
    append(...xs) { this.kids.push(...xs); } });
  const env = { document: { createElement: mk }, todayJST: () => today };
  vm.createContext(env);
  vm.runInContext([
    line(/^  const WD = .*$/m), line(/^  const ROSEN_TAG = .*$/m), line(/^  const ROSEN_ROOM = .*$/m), line(/^  const isRosen = .*$/m), line(/^  const SHIPPED_OUT = .*$/m), line(/^  const ROSEN_HOLIDAYS = .*$/m),
    ...['daysFromToday', 'rosenPickup', 'rosenLine'].map(extract),
    'Object.assign(globalThis, { rosenPickup, rosenLine });',
  ].join('\n'), env);
  return env;
}
const rosenText = (s) => s.kids.map(k => typeof k === 'string' ? k : k.textContent).join(' ');
test('RS1 路線便の集荷日は納期の前日。土日・祝日は集荷できないので前の平日（月曜着は金曜）', () => {
  const e = rosenEnv('2026-11-04');
  assert.equal(e.rosenPickup('2026-11-11'), '2026-11-10');
  assert.equal(e.rosenPickup('2026-11-16'), '2026-11-13'); // 月曜着 → 金曜
  assert.equal(e.rosenPickup('2026-11-15'), '2026-11-13'); // 日曜着 → 金曜
  assert.equal(e.rosenPickup('2026-11-14'), '2026-11-13'); // 土曜着 → 金曜
  assert.equal(e.rosenPickup('2026-11-17'), '2026-11-16'); // 火曜着 → 月曜
  assert.equal(e.rosenPickup('2026-11-24'), '2026-11-20'); // 火曜着・月曜(11/23)祝日 → 金曜
  assert.equal(e.rosenPickup('2026-11-04'), '2026-11-02'); // 水曜着・火曜(11/3)祝日 → 月曜
  assert.equal(e.rosenPickup('2027-01-04'), '2026-12-31'); // 1/4(月)着。1/1〜1/3 と土日を越えて 12/31
  assert.equal(e.rosenPickup('2027-01-05'), '2027-01-04'); // 1/4(月) は平日
  assert.equal(e.rosenPickup('2027-05-06'), '2027-04-30'); // 5/3〜5/5 と 5/1・5/2(土日) を越える
  assert.equal(e.rosenPickup('2026-12-01'), '2026-11-30'); // 月をまたぐ
});
test('RS1 路線便の印: 今日・明日・過ぎ を出し、#路線 が無い・納期が空・出荷済は警告しない', () => {
  const e = rosenEnv('2026-11-10');
  const o = (p) => ({ item: 'TP小箱#o#路線', ndate: '2026-11-11', progOut: '', ...p });
  assert.equal(e.rosenLine(o({ item: 'TP小箱#o' })), null);
  assert.equal(e.rosenLine(o({ ndate: '' })), null);
  // Room に 路線便 があれば、品名に #路線 が無くても出す（2026-11-06）
  assert.match(rosenText(e.rosenLine(o({ item: 'TP小箱#o', room: ['オートン', '路線便'] }))), /路線 集荷 11\/10\(火\) 今日集荷/);
  assert.equal(e.rosenLine(o({ item: 'TP小箱#o', room: ['オートン'] })), null);
  let s = e.rosenLine(o());
  assert.match(rosenText(s), /路線 集荷 11\/10\(火\) 今日集荷/); assert.deepEqual(s.classList.list, ['late']);
  s = e.rosenLine(o({ ndate: '2026-11-12' })); assert.match(rosenText(s), /明日集荷/); assert.deepEqual(s.classList.list, ['soon']);
  s = e.rosenLine(o({ ndate: '2026-11-09' })); assert.match(rosenText(s), /集荷日を4日過ぎ/); // 11/9(月)着 → 11/6(金)集荷
  s = e.rosenLine(o({ ndate: '2026-11-09', progOut: '完納済' })); assert.match(rosenText(s), /出荷済/); assert.deepEqual(s.classList.list, []);
  assert.ok(extract('facts').includes('rosenLine(o)'), '数量・納期の表示に集荷日を足す');
});

// ---- CU1 顧客（Kname）の絞り込み 2026-11-05 ----
function custEnv(orders) {
  const mk = (tag) => {
    const el = { tag, hidden: true, textContent: '', id: '', attrs: {}, kids: [], onclick: null,
      append(...xs) { for (const x of xs) this.kids.push(x); },
      setAttribute(k, v) { this.attrs[k] = v; }, focus() {} };
    Object.defineProperty(el, 'textContent', { get() { return el._t ?? el.kids.map(k => typeof k === 'string' ? k : k.textContent).join(''); }, set(v) { el._t = v === '' ? undefined : v; if (v === '') el.kids = []; } });
    return el;
  };
  const nodes = { custChips: mk('div'), custList: mk('div') };
  const env = { S: { orders, cust: null, custOpen: false, view: 'all' }, renders: 0, loads: [], busyNow: () => false,
    loadView: async (k) => { env.loads.push(k); env.S.view = k; env.S.cust = null; env.S.custOpen = false; return true; },
    $: (id) => id === 'custBtn' ? nodes.custChips.kids.find(k => k.id === 'custBtn') : nodes[id],
    document: { createElement: mk }, nodes, scroller: () => ({}) };
  env.renderList = () => { env.renders++; env.renderCust(); };
  env.keepTopRow = (fn) => fn();
  vm.createContext(env);
  vm.runInContext([line(/^  const custOf = .*$/m), line(/^  const custLabel = .*$/m), extract('renderCust'),
    'globalThis.renderCust = renderCust; globalThis.custOf = custOf;'].join('\n'), env);
  return env;
}
test('CU1 顧客別を押すと今のリストの顧客を件数の多い順に出し、選ぶとその顧客に絞る。解除で全件', () => {
  const o = (id, kname) => ({ id, spec: kname == null ? {} : { kname } });
  const e = custEnv([o('a', 'B社'), o('b', 'A社'), o('c', 'B社'), o('d'), o('e', ' A社 '), o('f', 'B社'), o('g', ''), o('h'), o('i')]);
  e.renderCust();
  const chips = e.nodes.custChips, list = e.nodes.custList;
  assert.equal(chips.hidden, false); assert.equal(list.hidden, true, '初めは閉じている');
  const btn = () => chips.kids.find(k => k.id === 'custBtn');
  assert.match(btn().textContent, /顧客別/);
  btn().onclick();
  assert.equal(list.hidden, false);
  assert.deepEqual(list.kids.map(k => k.textContent), ['すべて9', 'B社3', 'A社2', '(顧客名なし)4'], '前後の空白は同じ顧客。名前なしは件数によらず最後');
  list.kids[2].onclick();
  assert.equal(e.S.cust, 'A社'); assert.equal(list.hidden, true, '選んだら閉じる');
  assert.match(btn().textContent, /A社/); assert.equal(btn().attrs['aria-pressed'], 'true');
  const x = chips.kids.find(k => k.textContent === '✕ 解除'); assert.ok(x);
  x.onclick(); assert.equal(e.S.cust, null);
  btn().onclick(); list.kids[3].onclick(); assert.equal(e.S.cust, '', '顧客名なしも選べる');
});
test('CU1 全件以外で顧客別を押すと全件を読んでから顧客を出し、解除で元のリストに戻る。アーカイブ済は数えない', async () => {
  const o = (id, kname, archived) => ({ id, spec: { kname }, archived });
  const e = custEnv([o('a', 'A社'), o('b', 'A社', true), o('c', 'B社')]);
  e.S.view = 'kikai';
  e.renderCust();
  const btn = () => e.nodes.custChips.kids.find(k => k.id === 'custBtn');
  assert.match(btn().textContent, /全件から/);
  await btn().onclick();
  assert.deepEqual(e.loads, ['all'], '全件を読む');
  assert.equal(e.S.custOpen, true, '読んだら顧客を開く');
  assert.deepEqual(e.nodes.custList.kids.map(k => k.textContent), ['すべて3', 'A社1', 'B社1'], 'アーカイブ済は顧客の数に入れない');
  e.nodes.custList.kids[1].onclick();
  assert.equal(e.S.cust, 'A社');
  e.nodes.custChips.kids.find(k => k.textContent === '✕ 解除').onclick();
  assert.deepEqual(e.loads, ['all', 'kikai'], '解除で元のリストに戻る');
});
test('CU1 一覧は顧客で絞ってから状態を数え、件数の案内に顧客名を出す。リストを切り替えたら解除', () => {
  const src = extract('renderList');
  assert.ok(/let base = S\.cust == null \? S\.orders : S\.orders\.filter\(o => !o\.archived && custOf\(o\) === S\.cust\)/.test(src));
  assert.ok(src.includes('base.map(o => [o.id, rowState(o, v)])') && src.includes('renderFilter(counts, base.length)'));
  assert.ok(/S\.filter === 'all' \? base : base\.filter/.test(src));
  const e = listEnv(async () => ok('taoshi', [{ id: 'T' }], 1));
  vm.runInContext(line(/^  const custLabel = .*$/m) + '\nglobalThis.custLabel = custLabel;', e);
  e.S.orders = [{ id: 1 }, { id: 2 }, { id: 3 }]; e.S.listAt = 1; e.S.cust = 'A社'; e.S.shown = 1;
  e.showListMsg(); assert.match(e.$('listMsg').textContent, /「A社」で絞り込み中: 表示1件／全3件/);
  e.S.filter = 'ready'; e.S.shown = 0;
  e.showListMsg(); assert.match(e.$('listMsg').textContent, /「A社」・「着手可」に当たる受注はありません/);
  e.S.filter = 'all'; e.S.custOpen = true;
  return e.loadView('taoshi').then(() => { assert.equal(e.S.cust, null); assert.equal(e.S.custOpen, false); });
});

// ---- AR1 全件にアーカイブ済も出す 2026-11-05（偽の Airtable。本物には繋がない） ----
test('AR1 全件はアーカイブ済も納期の新しい順で後ろに足し、閉じた受注として扱う。アーカイブ済には自動で書かない', async () => {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const calls = []; const prevFetch = global.fetch;
  const rec = (id, f) => ({ id, fields: { Book: 'Ko', WorkCord: 1, NAmount: 10, ...f } });
  const active = [rec('recACTIVE00000002', { ItemName: '進行中B', Ndate: '2026-11-09' }), rec('recACTIVE00000001', { ItemName: '進行中A', Ndate: '2026-11-07' })];
  // アーカイブ済の1件は 進行社外が空・#o・まだ何も済んでいない（シート手配待ちの自動書き込みの条件に当たる形）
  const archived = [rec('recARCHIVE0000001', { ItemName: '古い箱 #o', '工程(自動)': '|オートン|', Ndate: '2026-10-01' }), rec('recARCHIVE0000002', { ItemName: '古い箱2', Ndate: '2026-10-20' })];
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); const m = init.method || 'GET';
    calls.push({ m, u, body: init.body });
    if (u.pathname.includes('/meta/')) return new Response(JSON.stringify({ tables: [] }), { status: 200 });
    if (m !== 'GET') return new Response(JSON.stringify({ records: [] }), { status: 200 });
    const fm = u.searchParams.get('filterByFormula') || '';
    const recs = fm === '{アーカイブ済}' ? archived : fm === 'NOT({アーカイブ済})' ? active : [];
    return new Response(JSON.stringify({ records: recs }), { status: 200 });
  };
  try {
    const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_process.js')).href);
    const r = await mod.handleProcess('view', { view: 'all', refresh: true, lite: true }, { user: { id: 'recSTAFF0000000001', no: 9001, name: 'テスト 太郎' } });
    const j = await r.json();
    assert.equal(j.ok, true, JSON.stringify(j).slice(0, 200));
    assert.deepEqual(j.rows.map(x => x.id), ['recACTIVE00000001', 'recACTIVE00000002', 'recARCHIVE0000002', 'recARCHIVE0000001'], '進行中は納期順、アーカイブ済は後ろに新しい順');
    assert.deepEqual(j.rows.map(x => !!x.archived), [false, false, true, true]);
    assert.ok(j.rows.slice(2).every(x => x.closed), 'アーカイブ済は閉じた受注');
    const arcReq = calls.find(c => c.u.searchParams.get('filterByFormula') === '{アーカイブ済}');
    assert.equal(arcReq.u.searchParams.get('sort[0][field]'), 'Ndate'); assert.equal(arcReq.u.searchParams.get('sort[0][direction]'), 'desc');
    const writes = calls.filter(c => c.m === 'PATCH' && /TableJuchu/.test(c.u.pathname));
    assert.ok(!writes.some(c => String(c.body).includes('recARCHIVE')), 'アーカイブ済に シート手配待ち を書かない');
  } finally { global.fetch = prevFetch; }
  const src = extract('renderList');
  assert.ok(src.includes("(o.archived ? ' closed' : '')") && src.includes("s.textContent = 'アーカイブ済'"), '一覧にアーカイブ済の印');
  assert.ok(src.includes('(!!a.archived - !!b.archived)'), '画面でもアーカイブ済は後ろ');
});

// ---- KC1 工程表のコピー印刷の依頼 2026-11-05（偽の Airtable。本物には繋がない） ----
async function kcEnv(opt = {}) {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const calls = []; const reqs = new Map(); let n = 0;
  for (const r of opt.reqs || []) reqs.set(r.id, r);
  const orders = new Map(Object.entries(opt.orders || {}));
  const prevFetch = global.fetch;
  const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); const m = init.method || 'GET';
    const parts = u.pathname.split('/'); const table = decodeURIComponent(parts[3] || ''); const rid = parts[4];
    const kind = table === 'TableKoteiCopyRequest' || table === 'TableSlipIssueRequest' || table === 'TableLabelPrintRequest' ? 'kc' : table === 'TableJuchu' ? 'order' : table === 'tblQFZ7QEuRaBW4oj' ? 'worklog' : 'other:' + table;
    calls.push(`${m} ${kind}${rid ? ' ' + rid : ''}`);
    if (kind === 'order' && !rid && m === 'GET') {
      if (opt.failList) return new Response('{}', { status: 500 });
      const fm = u.searchParams.get('filterByFormula') || '';
      const eq = (name) => new RegExp(`\\{${name}\\}\\)?='([^']*)'`).exec(fm)?.[1];
      const not = /RECORD_ID\(\)!='([^']+)'/.exec(fm)?.[1];
      const want = { Book: eq('Book'), Kname: eq('Kname'), DeliPlace: eq('DeliPlace'), Ndate: eq('Ndate') };
      const list = [...orders.values()].filter(r => r.id !== not && !r.fields['アーカイブ済'] && Object.entries(want).every(([k, v]) => String(r.fields[k] ?? '').trim() === v));
      return ok({ records: list.sort((a, b) => a.fields.WorkCord - b.fields.WorkCord) });
    }
    if (kind === 'order') return orders.has(rid) ? ok(orders.get(rid)) : new Response('{}', { status: 404 });
    if (kind === 'worklog') return ok({ records: [] });
    if (kind === 'kc') {
      if (m === 'GET') {
        const fm = u.searchParams.get('filterByFormula') || '';
        const q = /\{依頼ID\}='([^']+)'/.exec(fm)?.[1];
        const recs = [...fm.matchAll(/\{受注RecordID\}='([^']+)'/g)].map(x => x[1]);
        const pre = /FIND\('([^']+)',\{依頼ID\}\)=1/.exec(fm)?.[1];
        const openOnly = fm.includes("{状態}='依頼済'");
        let list = [...reqs.values()];
        if (q) list = list.filter(r => r.fields['依頼ID'] === q);
        if (pre) list = list.filter(r => r.fields['依頼ID'].startsWith(pre));
        if (recs.length) list = list.filter(r => recs.includes(r.fields['受注RecordID']));
        if (openOnly) list = list.filter(r => ['依頼済', '印刷中', '発行中'].includes(r.fields['状態']));
        return ok({ records: list });
      }
      if (m === 'POST') {
        const made = JSON.parse(init.body).records.map(x => ({ id: 'recKC' + String(++n).padStart(12, '0'), fields: x.fields }));
        if (made.length > 10) return new Response('{}', { status: 422 }); // Airtable は1回10行まで
        for (const r of made) reqs.set(r.id, r);
        return ok({ records: made });
      }
    }
    return new Response('{}', { status: 500 });
  };
  const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_process.js')).href);
  const who = { user: { id: 'recSTAFF0000000001', no: 9001, name: 'テスト 太郎' } };
  const run = async (action, body) => { const r = await mod.handleProcess(action, body, who); return { status: r.status, j: await r.json() }; };
  return { run, calls, reqs, restore: () => { global.fetch = prevFetch; } };
}
const KREC = 'recKOTEICOPY00001', KREQ = 'kc-11111111-2222-3333-4444-555555555555';
const korder = { id: KREC, fields: { Book: 'Ta', WorkCord: 3666, ItemName: '検証箱 #o', NAmount: 100, Ndate: '2026-11-10', 工程表印刷済: true } };
test('KC1 依頼は依頼の表に依頼済で1行書くだけ。受注（TableJuchu）には書かない', async () => {
  const e = await kcEnv({ orders: { [KREC]: korder } });
  try {
    const r = await e.run('koteiCopy', { id: KREC, reqId: KREQ });
    assert.equal(r.j.ok, true, JSON.stringify(r.j)); assert.equal(r.j.request.state, '依頼済');
    const f = [...e.reqs.values()][0].fields;
    assert.equal(f['依頼ID'], KREQ); assert.equal(f['受注RecordID'], KREC); assert.equal(f['状態'], '依頼済');
    assert.equal(f['Book'], 'Ta'); assert.equal(f['WorkCord'], '3666'); assert.equal(f['依頼者'], 'テスト 太郎'); assert.equal(f['社員番号'], 9001);
    assert.ok(!e.calls.some(c => /^(PATCH|POST|DELETE) order/.test(c)), e.calls.join(','));
  } finally { e.restore(); }
});
test('KC1 同じ依頼IDの送り直し・同じ受注の依頼中があるときは2行目を作らない', async () => {
  const e = await kcEnv({ orders: { [KREC]: korder } });
  try {
    await e.run('koteiCopy', { id: KREC, reqId: KREQ });
    const again = await e.run('koteiCopy', { id: KREC, reqId: KREQ });
    assert.equal(again.j.ok, true); assert.equal(again.j.again, true);
    const other = await e.run('koteiCopy', { id: KREC, reqId: 'kc-99999999-2222-3333-4444-555555555555' });
    assert.equal(other.j.ok, true); assert.equal(other.j.dup, true);
    assert.equal(e.reqs.size, 1);
    [...e.reqs.values()][0].fields['状態'] = '印刷済';
    const next = await e.run('koteiCopy', { id: KREC, reqId: 'kc-99999999-2222-3333-4444-555555555555' });
    assert.equal(next.j.ok, true); assert.ok(!next.j.dup); assert.equal(e.reqs.size, 2, '前の依頼が済んでいればもう1枚頼める');
  } finally { e.restore(); }
});
test('KC1 依頼IDなし・受注が無い・Ta/Ko/Yo 以外は依頼しない。状況は直近の依頼を返す', async () => {
  const e = await kcEnv({ orders: { [KREC]: korder, recKOTEICOPY00002: { id: 'recKOTEICOPY00002', fields: { Book: 'Zz', WorkCord: 1 } } } });
  try {
    assert.equal((await e.run('koteiCopy', { id: KREC })).status, 400);
    assert.equal((await e.run('koteiCopy', { id: 'recKOTEICOPY00009', reqId: KREQ })).status, 404);
    assert.equal((await e.run('koteiCopy', { id: 'recKOTEICOPY00002', reqId: KREQ })).status, 400);
    assert.equal(e.reqs.size, 0);
    await e.run('koteiCopy', { id: KREC, reqId: KREQ });
    const st = await e.run('koteiCopyStatus', { id: KREC });
    assert.equal(st.j.ok, true); assert.equal(st.j.requests[0].reqId, KREQ); assert.equal(st.j.requests[0].state, '依頼済');
  } finally { e.restore(); }
});
// ---- LB1 箱ラベルの印刷依頼 2026-11-12（偽の Airtable。本物には繋がない） ----
const LREQ = 'lp-11111111-2222-3333-4444-555555555555';
test('LB1 依頼は依頼の表に依頼済で1行書くだけ。品名2行・梱包数・枚数を入れ、空なら書かない。受注には書かない', async () => {
  const e = await kcEnv({ orders: { [KREC]: korder } });
  process.env.LABEL_PRINT_ENABLED = '0';
  try {
    const off = await e.run('labelPrint', { id: KREC, reqId: LREQ, line1: 'HB3247-W6(仕切2)', line2: '', pack: '', sheets: '' });
    assert.equal(off.status, 503); assert.equal(e.reqs.size, 0, '事務所PCの準備前は書かない');
    process.env.LABEL_PRINT_ENABLED = '1';
    const r = await e.run('labelPrint', { id: KREC, reqId: LREQ, line1: ' HB3247-W6(仕切2) ', line2: '赤', pack: '25', sheets: '3' });
    assert.equal(r.j.ok, true, JSON.stringify(r.j)); assert.equal(r.j.request.state, '依頼済');
    const f = [...e.reqs.values()][0].fields;
    assert.equal(f['依頼ID'], LREQ); assert.equal(f['受注RecordID'], KREC); assert.equal(f['状態'], '依頼済');
    assert.equal(f['品名1'], 'HB3247-W6(仕切2)'); assert.equal(f['品名2'], '赤'); assert.equal(f['梱包数'], 25); assert.equal(f['枚数'], 3);
    assert.equal(f['Book'], 'Ta'); assert.equal(f['WorkCord'], '3666'); assert.equal(f['依頼者'], 'テスト 太郎'); assert.equal(f['社員番号'], 9001);
    assert.ok(!e.calls.some(c => /^(PATCH|POST|DELETE) order/.test(c)), e.calls.join(','));
    [...e.reqs.values()][0].fields['状態'] = '印刷済';
    const auto = await e.run('labelPrint', { id: KREC, reqId: 'lp-99999999-2222-3333-4444-555555555555', line1: '箱', pack: '', sheets: '' });
    assert.equal(auto.j.ok, true);
    const g = [...e.reqs.values()][1].fields;
    assert.ok(!('梱包数' in g) && !('枚数' in g), '空は事務所PCが決める（書かない）');
  } finally { e.restore(); delete process.env.LABEL_PRINT_ENABLED; }
});
test('LB1 品名1が空・梱包数や枚数が整数でない・枚数が10を超える・依頼IDが違う形式は断る。二度押しは2行目を作らない', async () => {
  const e = await kcEnv({ orders: { [KREC]: korder } });
  process.env.LABEL_PRINT_ENABLED = '1';
  try {
    const base = { id: KREC, reqId: LREQ, line1: '箱', line2: '', pack: '', sheets: '' };
    assert.equal((await e.run('labelPrint', { ...base, line1: '  ' })).status, 400);
    assert.equal((await e.run('labelPrint', { ...base, pack: '2.5' })).status, 400);
    assert.equal((await e.run('labelPrint', { ...base, pack: '0' })).status, 400);
    assert.equal((await e.run('labelPrint', { ...base, sheets: '11' })).status, 400);
    assert.equal((await e.run('labelPrint', { ...base, reqId: 'kc-11111111-2222-3333-4444-555555555555' })).status, 400);
    assert.equal((await e.run('labelPrint', { ...base, line1: 'x'.repeat(61) })).status, 400);
    assert.equal((await e.run('labelPrint', { ...base, id: 'recKOTEICOPY00009' })).status, 404);
    assert.equal(e.reqs.size, 0);
    await e.run('labelPrint', base);
    const again = await e.run('labelPrint', base);
    assert.equal(again.j.again, true);
    const other = await e.run('labelPrint', { ...base, reqId: 'lp-99999999-2222-3333-4444-555555555555' });
    assert.equal(other.j.dup, true);
    assert.equal(e.reqs.size, 1);
    const st = await e.run('labelPrintStatus', { id: KREC });
    assert.equal(st.j.ok, true); assert.equal(st.j.requests[0].reqId, LREQ); assert.equal(st.j.requests[0].line1, '箱');
  } finally { e.restore(); delete process.env.LABEL_PRINT_ENABLED; }
});
test('LB1 画面: 品名は # より前を最初の / で2行に分ける。目安の枚数は 数量÷入数÷24 の切り捨て＋1。送り方は工程表コピーと同じ', () => {
  const ctx = {}; vm.runInNewContext(extract('lpSplit') + extract('lpEstimate') + '; this.lpSplit = lpSplit; this.lpEstimate = lpEstimate;', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.lpSplit('HB3247-W6(仕切2)#o#ko'))), ['HB3247-W6(仕切2)', '']);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.lpSplit('お守 角大/赤箔 #h'))), ['お守 角大', '赤箔']);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.lpSplit(''))), ['', '']);
  assert.equal(ctx.lpEstimate({ amount: 384, spec: { packUnit: '25' } }, ''), 1);
  assert.equal(ctx.lpEstimate({ amount: 5000, spec: { packUnit: '20' } }, ''), 11);
  assert.equal(ctx.lpEstimate({ amount: 5000, spec: { packUnit: '20' } }, '500'), 1, '梱包数を入れたらそちらで数える');
  assert.equal(ctx.lpEstimate({ amount: 100, spec: {} }, ''), 0, '入数が分からなければ目安なし');
  const src = extract('lpRequest');
  assert.ok(src.includes('if (!st.retry && !confirm('));
  assert.ok(src.includes("const reqId = st.retry || ('lp-'"));
  assert.ok(src.includes("api({ action: 'labelPrint', id: o.id, reqId, line1, line2, pack, sheets: f.sheets || '' })"));
  assert.ok(src.includes('if (j.unknown) { st.retry = reqId;'));
  assert.ok(extract('renderLabelPrint').includes('b.disabled = !!st.sending || kcPending(st.last);'));
  assert.ok(extract('renderSteps').includes('renderLabelPrint(o);'));
  // 入力欄を押したら入力欄ぜんぶを見出しの下へ持ち上げる（キーボードに隠れない）。入力中だけ下に余白、閉じたら外す
  const form = extract('lpForm');
  assert.ok(form.includes("form.addEventListener('focusin'") && form.includes('scrollToCard(form)'));
  assert.ok(form.includes("card.classList.add('lpediting')") && form.includes("card.classList.remove('lpediting')"));
  assert.ok(extract('renderLabelPrint').includes("else $('stepCard').classList.remove('lpediting');"));
  assert.ok(source.includes('#stepCard.lpediting{ padding-bottom:70vh }'));
  // 型を探す・生地を照合・ラベルを印刷 を同じ大きさで3つ並べ、ラベルの入力欄はそのすぐ下（工程表コピーより上）に開く
  assert.ok(extract('goBar').includes('g.append(findLink(o), fabricLink(o), labelLink(o));'));
  assert.ok(source.includes('.gobar{ display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px }'));
  assert.ok(source.indexOf('id="goBar"') < source.indexOf('id="labelPrint"') && source.indexOf('id="labelPrint"') < source.indexOf('id="koteiCopy"'));
  assert.ok(extract('labelLink').includes("st.open = !st.open; st.msg = ''; renderLabelPrint(o);"));
});
// ---- SL1 受領伝票のすぐ発行 2026-11-10（偽の Airtable。本物には繋がない） ----
const SREC = 'recSLIPISSUE00001', SREQ = 'sl-11111111-2222-3333-4444-555555555555';
const sorder = (f) => ({ id: SREC, fields: { Book: 'Ta', WorkCord: 3666, ItemName: '検証箱 #o', NAmount: 100, Ndate: '2026-11-10', 進行社外: '受領伝票発行可能', ...f } });
test('SL1 受領伝票発行可能なら依頼の表に依頼済で1行書くだけ。受注には書かない', async () => {
  const e = await kcEnv({ orders: { [SREC]: sorder() } });
  process.env.SLIP_ISSUE_ENABLED = '0';
  try {
    const off = await e.run('slipIssue', { id: SREC, reqId: SREQ });
    assert.equal(off.status, 503); assert.equal(e.reqs.size, 0, '事務所PCの準備前は書かない');
    process.env.SLIP_ISSUE_ENABLED = '1';
    const r = await e.run('slipIssue', { id: SREC, reqId: SREQ });
    assert.equal(r.j.ok, true, JSON.stringify(r.j)); assert.equal(r.j.request.state, '依頼済');
    const f = [...e.reqs.values()][0].fields;
    assert.equal(f['依頼ID'], SREQ); assert.equal(f['受注RecordID'], SREC); assert.equal(f['依頼者'], 'テスト 太郎');
    assert.ok(!e.calls.some(c => /^(PATCH|POST|DELETE) order/.test(c)), e.calls.join(','));
    const again = await e.run('slipIssue', { id: SREC, reqId: SREQ });
    assert.equal(again.j.again, true);
    const other = await e.run('slipIssue', { id: SREC, reqId: 'sl-99999999-2222-3333-4444-555555555555' });
    assert.equal(other.j.dup, true); assert.equal(e.reqs.size, 1, '依頼中なら2行目を作らない');
    const st = await e.run('slipIssueStatus', { id: SREC });
    assert.equal(st.j.requests[0].reqId, SREQ);
  } finally { e.restore(); }
});
test('SL1 受領伝票発行可能でない・伝票IDあり・アーカイブ済は断り、依頼の表に書かない', async () => {
  for (const [f, re] of [[{ 進行社外: '' }, /受領伝票発行可能」ではない.*空白/], [{ 進行社外: 'シート材料入荷済' }, /今: シート材料入荷済/],
    [{ 進行社外: '伝票出力済' }, /ではない/], [{ 伝票ID: 'Ta_11_20261110_5001' }, /発行済み.*5001/], [{ アーカイブ済: true }, /アーカイブ済/]]) {
    const e = await kcEnv({ orders: { [SREC]: sorder(f) } });
    try {
      const r = await e.run('slipIssue', { id: SREC, reqId: SREQ });
      assert.equal(r.status, 409, JSON.stringify(f)); assert.equal(r.j.refused, true); assert.match(r.j.error, re);
      assert.equal(e.reqs.size, 0);
    } finally { e.restore(); }
  }
  const e = await kcEnv({ orders: {} });
  try {
    assert.equal((await e.run('slipIssue', { id: SREC, reqId: 'kc-11111111-2222' })).status, 400, '依頼IDの形が違えば断る');
    assert.equal((await e.run('slipIssue', { id: SREC, reqId: SREQ })).status, 404);
  } finally { e.restore(); }
});
// ---- SL2 同じ納期・納品先の受注をまとめて依頼する 2026-11-11 ----
const SM = (n) => 'recSLIPMATE' + String(n).padStart(6, '0');
const mate = (n, f = {}) => ({ id: SM(n), fields: { Book: 'Ta', WorkCord: 4000 + n, ItemName: `仲間${n} #o`, NAmount: n * 100, Ndate: '2026-11-10', Kname: '検証紙器', DeliPlace: '検証倉庫', 進行社外: '受領伝票発行可能', ...f } });
const smain = () => sorder({ Kname: '検証紙器', DeliPlace: '検証倉庫' });
const slipWorld = (list) => ({ orders: Object.fromEntries([smain(), ...list].map(r => [r.id, r])) });
test('SL2 状況: 同じ Book・顧客・納品先・納期 の受注を、発行可能（一緒に入る）と まだ（入らない）に分けて返す', async () => {
  const e = await kcEnv(slipWorld([mate(1), mate(2, { 進行社外: 'シート材料入荷済' }), mate(3, { 伝票ID: 'Ta_11_20261110_5001' }), mate(4, { 進行社外: '完納済' }),
    mate(5, { Ndate: '2026-11-11' }), mate(6, { DeliPlace: '別の倉庫' }), mate(7, { Kname: '別の顧客' }), mate(8, { Book: 'Ko' }), mate(9, { アーカイブ済: true }), mate(10, { 進行社外: '一旦キャンセルです' })]));
  try {
    const st = await e.run('slipIssueStatus', { id: SREC });
    assert.equal(st.j.ok, true);
    assert.deepEqual(st.j.mates.ready.map(m => m.id), [SM(1)]);
    assert.deepEqual(st.j.mates.wait.map(m => m.id), [SM(2)], '発行済み・完納・キャンセル・別の納期／納品先／顧客／Book・アーカイブ済は出さない');
    assert.equal(st.j.mates.ready[0].amount, 100); assert.equal(st.j.mates.wait[0].progOut, 'シート材料入荷済');
    assert.ok(!e.calls.some(c => /^(PATCH|POST|DELETE)/.test(c)), '状況を読むだけでは何も書かない');
  } finally { e.restore(); }
});
test('SL2 状況: 納品先か納期が空の受注はまとめない。選んだ受注が発行可能でなければ探さない。読めなければ mates は null', async () => {
  for (const f of [{ DeliPlace: '' }, { Ndate: '' }, { 進行社外: 'シート材料入荷済' }]) {
    const e = await kcEnv({ orders: { [SREC]: sorder({ Kname: '検証紙器', DeliPlace: '検証倉庫', ...f }), [SM(1)]: mate(1, f.DeliPlace === '' ? { DeliPlace: '' } : f.Ndate === '' ? { Ndate: '' } : {}) } });
    try {
      const st = await e.run('slipIssueStatus', { id: SREC });
      assert.deepEqual(st.j.mates, { ready: [], wait: [] }, JSON.stringify(f));
      assert.ok(!e.calls.includes('GET order'), '受注の一覧は読まない');
    } finally { e.restore(); }
  }
  const e = await kcEnv({ ...slipWorld([mate(1)]), failList: true });
  try {
    const st = await e.run('slipIssueStatus', { id: SREC });
    assert.equal(st.j.ok, true); assert.equal(st.j.mates, null); assert.ok(Array.isArray(st.j.requests));
  } finally { e.restore(); }
});
test('SL2 依頼: 確認した受注だけを、同じ依頼として1回で書く（依頼ID.2 .3）。見せていない受注は足さない', async () => {
  const e = await kcEnv(slipWorld([mate(1), mate(2), mate(3)]));
  process.env.SLIP_ISSUE_ENABLED = '1';
  try {
    const r = await e.run('slipIssue', { id: SREC, reqId: SREQ, with: [SM(1), SM(3)] });
    assert.equal(r.j.ok, true, JSON.stringify(r.j));
    assert.deepEqual(r.j.mates.map(m => m.id), [SM(1), SM(3)]); assert.deepEqual(r.j.dropped, []);
    const rows = [...e.reqs.values()].map(x => x.fields);
    assert.deepEqual(rows.map(f => [f['依頼ID'], f['受注RecordID'], f['状態']]), [[SREQ, SREC, '依頼済'], [SREQ + '.2', SM(1), '依頼済'], [SREQ + '.3', SM(3), '依頼済']]);
    assert.equal(new Set(rows.map(f => f['依頼日時'])).size, 1, '同じ依頼日時');
    assert.equal(rows[1]['WorkCord'], '4001'); assert.equal(rows[1]['依頼者'], 'テスト 太郎');
    assert.equal(e.calls.filter(c => c === 'POST kc').length, 1, '1回の書き込み（途中まで書けた状態を作らない）');
    assert.ok(!e.calls.some(c => /^(PATCH|POST|DELETE) order/.test(c)), '受注には書かない');
    // 送り直し（同じ依頼ID）は書かずに、まとめた受注も返す
    const again = await e.run('slipIssue', { id: SREC, reqId: SREQ, with: [SM(1), SM(3)] });
    assert.equal(again.j.again, true); assert.deepEqual(again.j.mates.map(m => m.id).sort(), [SM(1), SM(3)]); assert.equal(e.reqs.size, 3);
    // まとめられた受注のカードでも依頼中と分かる。もう一度頼んでも2行目を作らない
    const st = await e.run('slipIssueStatus', { id: SM(1) });
    assert.equal(st.j.requests[0].reqId, SREQ + '.2');
    const dup = await e.run('slipIssue', { id: SM(1), reqId: 'sl-99999999-2222-3333-4444-555555555555' });
    assert.equal(dup.j.dup, true); assert.equal(e.reqs.size, 3);
    // 残った仲間2 から頼むと、依頼中の受注は一緒に入れない
    const st2 = await e.run('slipIssueStatus', { id: SM(2) });
    assert.deepEqual(st2.j.mates.ready.map(m => [m.id, !!m.pending]), [[SREC, true], [SM(1), true], [SM(3), true]]);
    const r2 = await e.run('slipIssue', { id: SM(2), reqId: 'sl-88888888-2222-3333-4444-555555555555', with: [SREC, SM(1)] });
    assert.equal(r2.j.ok, true); assert.deepEqual(r2.j.mates, []); assert.deepEqual(r2.j.dropped, [SREC, SM(1)]); assert.equal(e.reqs.size, 4);
  } finally { e.restore(); }
});
test('SL2 依頼: 確認の後に状態が変わった受注・別の伝票になる受注は外して知らせる。with が無ければ今までどおり1行', async () => {
  const e = await kcEnv(slipWorld([mate(1), mate(2, { 進行社外: 'シート材料入荷済' }), mate(3, { DeliPlace: '別の倉庫' }), mate(4, { 伝票ID: 'Ta_11_20261110_5001' })]));
  process.env.SLIP_ISSUE_ENABLED = '1';
  try {
    assert.equal((await e.run('slipIssue', { id: SREC, reqId: SREQ, with: ['x'] })).status, 400);
    const r = await e.run('slipIssue', { id: SREC, reqId: SREQ, with: [SM(1), SM(2), SM(3), SM(4), SREC] });
    assert.deepEqual(r.j.mates.map(m => m.id), [SM(1)]); assert.deepEqual(r.j.dropped, [SM(2), SM(3), SM(4)]);
    assert.equal(e.reqs.size, 2);
  } finally { e.restore(); }
  const one = await kcEnv(slipWorld([mate(1)]));
  try {
    const r = await one.run('slipIssue', { id: SREC, reqId: SREQ });
    assert.equal(r.j.ok, true); assert.deepEqual(r.j.mates, []); assert.equal(one.reqs.size, 1);
    assert.ok(!one.calls.includes('GET order'), 'with が無ければ受注の一覧は読まない');
  } finally { one.restore(); }
});
test('SL2 依頼: 1回にまとめるのは選んだ受注＋9件まで。一緒に入る受注を確かめられなければ書かない', async () => {
  const many = Array.from({ length: 12 }, (_, i) => mate(i + 1));
  const e = await kcEnv(slipWorld(many));
  process.env.SLIP_ISSUE_ENABLED = '1';
  try {
    const r = await e.run('slipIssue', { id: SREC, reqId: SREQ, with: many.map(m => m.id) });
    assert.equal(r.j.ok, true, JSON.stringify(r.j)); assert.equal(r.j.mates.length, 9); assert.equal(r.j.dropped.length, 3); assert.equal(e.reqs.size, 10);
  } finally { e.restore(); }
  const bad = await kcEnv({ ...slipWorld([mate(1)]), failList: true });
  try {
    const r = await bad.run('slipIssue', { id: SREC, reqId: SREQ, with: [SM(1)] });
    assert.equal(r.status, 502); assert.equal(bad.reqs.size, 0);
  } finally { bad.restore(); }
});
test('SL2 画面: 一緒に入る受注をボタンの下と確認に出し、確認した ID だけを with で送る。送り直しは同じ内容', () => {
  const ctx = { SL_MATE_MAX: 9 };
  vm.runInNewContext(extract('slMates') + '; this.f = slMates;', ctx);
  const ready = Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, pending: i === 0 }));
  const m = ctx.f({ mates: { ready, wait: [{ id: 'w' }] } });
  assert.equal(m.go.length, 9); assert.equal(m.over, 2); assert.equal(m.busy.length, 1); assert.equal(m.wait.length, 1);
  assert.ok(!m.go.some(x => x.pending), '依頼中の受注は一緒に入れない');
  assert.equal(JSON.stringify(ctx.f({})), JSON.stringify({ go: [], over: 0, busy: [], wait: [] }));
  assert.equal(ctx.f({ mates: null }).go.length, 0, '読めなかったときはこの受注だけ');
  const rq = extract('slRequest');
  assert.ok(rq.indexOf('await slLoad(o.id)') < rq.indexOf('confirm('), '確認の前に読み直す');
  assert.ok(rq.includes('一緒に同じ伝票に入れる受注') && rq.includes('まだ発行可能でないので入らない受注'));
  assert.ok(rq.includes('withIds = mt.go.map(x => x.id)') && rq.includes('with: withIds') && rq.includes('st.retryWith = withIds'));
  const rn = extract('renderSlipIssue');
  assert.ok(rn.includes('一緒に同じ伝票に入れます') && rn.includes('この伝票に入りません') && rn.includes('件まとめて'));
});
test('SL1 画面: 受領伝票発行可能でなければ送らずに断る。発行済みはボタンを出さない', () => {
  const src = extract('slRequest');
  assert.ok(src.indexOf('slipRefusal(o)') < src.indexOf("api({ action: 'slipIssue'"), '送る前に断る');
  assert.ok(src.indexOf('slipRefusal(o)') < src.indexOf('confirm('), '確認より前に断る');
  const ctx = { SL_READY: '受領伝票発行可能' };
  vm.runInNewContext(extract('slipRefusal') + '; this.f = slipRefusal;', ctx);
  assert.equal(ctx.f({ progOut: '受領伝票発行可能' }), '');
  assert.match(ctx.f({ progOut: '' }), /空白/);
  assert.match(ctx.f({ progOut: '受領伝票発行可能', slipId: 'X1' }), /発行済み/);
  assert.match(ctx.f({ progOut: '受領伝票発行可能', archived: true }), /アーカイブ済/);
  assert.ok(extract('renderSlipIssue').includes('SL_AFTER.has(o.progOut)'), '伝票の後の段階ではボタンを出さない');
});
test('KC1 画面: 確認してから依頼IDを作って送り、結果不明は同じIDで送り直す。依頼中はボタンを止める', () => {
  const src = extract('kcRequest');
  assert.ok(src.includes('if (!st.retry && !confirm('));
  assert.ok(src.includes("const reqId = st.retry || ('kc-'"));
  assert.ok(src.includes("api({ action: 'koteiCopy', id: o.id, reqId })"));
  assert.ok(src.includes('if (j.unknown) { st.retry = reqId;'));
  assert.ok(extract('renderKoteiCopy').includes('b.disabled = !!st.sending || kcPending(st.last);'));
  assert.ok(extract('renderSteps').includes('renderKoteiCopy(o);'));
});

// ---- RS2 路線の祝日は事務所側と同じ 2026-11-05 ----
// 事務所の Z:\Airtable\rosen_pickup_report.py（_路線集荷予定.txt と S96.5 J列「路線M/D出荷」）と
// 画面の ROSEN_HOLIDAYS は同じ規則・同じ祝日でなければならない。事務所のファイルが見えない環境では飛ばす
test('RS2 画面の路線の祝日（ROSEN_HOLIDAYS）は事務所の rosen_pickup_report.py の HOLIDAYS と同じ', () => {
  const py = ['//server/data/Airtable/rosen_pickup_report.py', 'Z:/Airtable/rosen_pickup_report.py'].find(f => { try { return fs.existsSync(f); } catch { return false; } });
  if (!py) { console.log('     (事務所のファイルが見えないので比較を飛ばしました)'); return; }
  const src = fs.readFileSync(py, 'utf8');
  const m = /HOLIDAYS = \{([^}]*)\}/.exec(src); assert.ok(m, 'HOLIDAYS が見つからない');
  const pyDays = [...m[1].matchAll(/\((\d+),\s*(\d+)\)/g)].map(x => `${x[1].padStart(2, '0')}-${x[2].padStart(2, '0')}`).sort();
  const js = /const ROSEN_HOLIDAYS = new Set\(\[([^\]]*)\]\)/.exec(source); assert.ok(js);
  const jsDays = [...js[1].matchAll(/'(\d\d-\d\d)'/g)].map(x => x[1]).sort();
  assert.deepEqual(jsDays, pyDays);
});

// ---- SW1 進行社外が空白のシート待ち: 紙入荷日が先なら シート手配済み 2026-11-06（偽の Airtable。本物には繋がない） ----
test('SW1 進行社外が空白の抜きの受注は 紙入荷日なし→シート手配待ち／先の日付→シート手配済み／今日以前→シート材料入荷済', async () => {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const calls = []; const prevFetch = global.fetch;
  const rec = (id, f) => ({ id, fields: { Book: 'Ko', WorkCord: 1, NAmount: 10, ItemName: '箱 #o', '工程(自動)': '|オートン|', Ndate: '2026-12-01', ...f } });
  const active = [rec('recSHEETNONE00001', {}), rec('recSHEETFUTURE001', { '紙入荷日': '2099-01-01' }), rec('recSHEETPAST00001', { '紙入荷日': '2000-01-01' }),
    rec('recSHEETKIKAI0001', { ItemName: '箱 #ki', '工程(自動)': '|機械貼|', '紙入荷日': '2099-01-01' })];
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); const m = init.method || 'GET';
    calls.push({ m, u, body: init.body });
    if (u.pathname.includes('/meta/')) return new Response(JSON.stringify({ tables: [] }), { status: 200 });
    if (m !== 'GET') return new Response(JSON.stringify({ records: [] }), { status: 200 });
    const fm = u.searchParams.get('filterByFormula') || '';
    return new Response(JSON.stringify({ records: fm === 'NOT({アーカイブ済})' ? active : [] }), { status: 200 });
  };
  try {
    const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_process.js')).href);
    const r = await mod.handleProcess('view', { view: 'all', refresh: true, lite: true }, { user: { id: 'recSTAFF0000000001', no: 9001, name: 'テスト 太郎' } });
    const j = await r.json();
    assert.equal(j.ok, true, JSON.stringify(j).slice(0, 200));
    const wrote = {};
    for (const c of calls.filter(c => c.m === 'PATCH' && /TableJuchu/.test(c.u.pathname))) {
      for (const x of JSON.parse(c.body).records) wrote[x.id] = x.fields['進行社外'];
    }
    assert.deepEqual(wrote, { recSHEETNONE00001: 'シート手配待ち', recSHEETFUTURE001: 'シート手配済み', recSHEETPAST00001: 'シート材料入荷済' }, '機械貼だけの受注には書かない');
  } finally { global.fetch = prevFetch; }
});

// ---- WC1 同じ品番の受注をすべて見る（アーカイブ済も含む）2026-11-06（偽の Airtable。本物には繋がない） ----
test('WC1 同じ品番はアーカイブ済も含めて新しい順に上限まで読み、閉じた受注に印。ふだんの品番で探すはアーカイブ済を外したまま', async () => {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const calls = []; const prevFetch = global.fetch;
  const rec = (id, f) => ({ id, fields: { Book: 'Ta', WorkCord: 3848, NAmount: 10, ItemName: 'お守', ...f } });
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push(u);
    if (u.pathname.includes('/meta/')) return new Response(JSON.stringify({ tables: [] }), { status: 200 });
    return new Response(JSON.stringify({ records: [rec('recOLD0000000001', { Ndate: '2025-10-01', 'アーカイブ済': true }), rec('recOPEN000000001', { Ndate: '2026-11-16' })] }), { status: 200 });
  };
  try {
    const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_process.js')).href);
    const who = { user: { id: 'recSTAFF0000000001', no: 9001, name: 'テスト 太郎' } };
    let j = await (await mod.handleProcess('orders', { book: 'Ta', wc: '3848', archived: true }, who)).json();
    assert.equal(j.ok, true, JSON.stringify(j).slice(0, 200));
    const orderCalls = () => calls.filter(c => !c.pathname.includes('/meta/') && !c.pathname.includes('tblPbnYc3tIr9VYJ6')); // 推定所要時間の読み取りは除く
    let u = orderCalls().pop();
    assert.equal(u.searchParams.get('filterByFormula'), "AND({Book}='Ta',{WorkCord}=3848)");
    assert.equal(u.searchParams.get('sort[0][direction]'), 'desc');
    assert.ok(Number(u.searchParams.get('maxRecords')) > 1);
    assert.deepEqual(j.orders.map(o => [o.id, !!o.archived, !!o.closed]), [['recOPEN000000001', false, false], ['recOLD0000000001', true, true]]);
    j = await (await mod.handleProcess('orders', { book: 'Ta', wc: '3848' }, who)).json();
    u = orderCalls().pop();
    assert.match(u.searchParams.get('filterByFormula'), /\{アーカイブ済\}!=TRUE\(\)/);
  } finally { global.fetch = prevFetch; }
  const ui = extract('renderSameWc');
  assert.ok(ui.includes('search({ archived: true })') && ui.includes('setBook(o.book)'), '詳細画面のボタンは Book も揃えてアーカイブ済込みで探す');
  assert.ok(extract('reloadFind').includes('archived: !!S.findArch'), '読み直しでも同じ条件');
});

// ---- MS1 本人の実績（今日・昨日・今月）2026-11-08（偽の Airtable。本物には繋がない） ----
test('MS1 本人の分だけ数える。取り消した完了は数えず、別の人のやり直しはその人に付く。一昨日以前は日別の表、今日・昨日は作業ログ', async () => {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_incentive.js')).href);
  const jst = (n) => new Date(Date.now() + 9 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
  const today = jst(0), yesterday = jst(1);
  const at = (d, hm) => new Date(Date.parse(`${d}T${hm}:00+09:00`)).toISOString();
  const WL = { at: 'fldal1FMiPlRVn9BF', no: 'fldmjyRUDyPPaFFnb', name: 'fldEBJAH0707h1ity', action: 'fldHbWQ5VemkIPMmS',
    step: 'flds9HiDR5e1eiFGf', orderId: 'fldOfsIbZmKNfeik8', credit: 'fldIHadyI8FqyEqQ5' };
  const log = (id, d, hm, no, action, step, order, credit) => ({ id, fields: { [WL.at]: at(d, hm), [WL.no]: no, [WL.name]: 'n' + no,
    [WL.action]: action, [WL.step]: step, [WL.orderId]: order, ...(credit ? { [WL.credit]: true } : {}) } });
  const logs = [
    log('l1', today, '09:00', 1001, '工程完了', 'オートン抜き完了', 'recA', true),
    log('l2', today, '09:05', 1001, '工程完了', 'オートン抜き完了', 'recB', true),
    log('l3', today, '09:06', 1001, '工程取消', 'オートン抜き完了', 'recB'),          // 押し間違い → 数えない
    log('l4', today, '10:00', 1001, '工程完了', '手貼り完了', 'recC', true),
    log('l5', today, '10:10', 1001, '工程取消', '手貼り完了', 'recC'),
    log('l6', today, '10:20', 1002, '工程完了', '手貼り完了', 'recC', true),         // 別の人がやり直し → その人に付く
    log('l7', today, '11:00', 1001, '抜型照合', '抜型照合', 'recD', true),
    log('l8', yesterday, '16:00', 1001, '状況報告', 'シート材料入荷済', 'recE', true),
  ];
  const D = { date: 'fld9QfTWCVyARS1KA', step: 'fldcYOdk3kKZ4E56t', count: 'fldqLboYbHkmWrVqN' };
  const monthFrom = today.slice(0, 8) + '01';
  const daily = monthFrom < yesterday ? [{ id: 'd1', fields: { [D.date]: monthFrom, [D.step]: 'オートン抜き完了', [D.count]: 5 } }] : [];
  const calls = []; const prevFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url)); calls.push(u);
    const recs = u.pathname.includes('tblQFZ7QEuRaBW4oj') ? logs : u.pathname.includes('tblaO7MWgAW0VvCwU') ? daily : [];
    return new Response(JSON.stringify({ records: recs }), { status: 200 });
  };
  try {
    const r = await mod.myStats(1001);
    assert.equal(r.today.total, 2, '今日はオートン1・抜型照合1');
    assert.deepEqual(r.today.steps.map(x => x.step).sort(), ['オートン抜き完了', '抜型照合'].sort());
    assert.equal(r.yesterday.total, 1);
    assert.equal(r.month.total, 3 + (daily.length ? 5 : 0) - (yesterday < monthFrom ? 1 : 0));
    const dq = calls.find(u => u.pathname.includes('tblaO7MWgAW0VvCwU'));
    if (daily.length) assert.match(dq.searchParams.get('filterByFormula'), /\{fldZOZLQTiElEHx7D\}=1001/, '日別の表は本人の行だけ読む');
    const n = calls.length;
    await mod.myStats(1001);
    assert.equal(calls.length, n, '2分以内・同じ日なら読み直さない');
    const r2 = await mod.myStats(1002);
    assert.equal(r2.today.total, 1, 'やり直した人に1件');
  } finally { global.fetch = prevFetch; }
});
// ---- IN1 毎晩の集計は直近の分のログだけ読む（2026-11-10。偽の Airtable。本物には繋がない） ----
test('IN1 毎晩の集計は書く範囲（直近45日）のログだけ読み、全部読んだときと同じ行を書く。full は 10/8 から読む', async () => {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_incentive.js')).href);
  const jst = (n) => new Date(Date.now() + 9 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
  const at = (d, hm) => new Date(Date.parse(`${d}T${hm}:00+09:00`)).toISOString();
  const WL = { at: 'fldal1FMiPlRVn9BF', no: 'fldmjyRUDyPPaFFnb', name: 'fldEBJAH0707h1ity', action: 'fldHbWQ5VemkIPMmS',
    step: 'flds9HiDR5e1eiFGf', orderId: 'fldOfsIbZmKNfeik8', credit: 'fldIHadyI8FqyEqQ5' };
  const log = (id, d, hm, no, action, step, order, credit) => ({ id, fields: { [WL.at]: at(d, hm), [WL.no]: no, [WL.name]: 'n' + no,
    [WL.action]: action, [WL.step]: step, [WL.orderId]: order, ...(credit ? { [WL.credit]: true } : {}) } });
  const from = [mod.START_DATE, jst(45)].sort().pop();
  const old = jst(200), edge = from; // old は範囲より前、edge は範囲の最初の日
  const logs = [
    log('a1', old, '09:00', 1001, '工程完了', 'オートン抜き完了', 'recA', true),   // 範囲より前に完了したまま → 書く対象外
    log('b1', old, '09:10', 1001, '工程完了', '手貼り完了', 'recB', true),         // 範囲より前に完了 →
    log('b2', jst(3), '10:00', 1001, '工程取消', '手貼り完了', 'recB'),            //   範囲の中で取消 →
    log('b3', jst(2), '11:00', 1002, '工程完了', '手貼り完了', 'recB', true),      //   別の人がやり直し（その人に1件）
    log('c1', old, '09:20', 1001, '工程完了', '機械貼完了', 'recC', true),         // 範囲より前に完了 →
    log('c2', jst(1), '12:00', 1001, '工程取消', '機械貼完了', 'recC'),            //   範囲の中で取消（0件）
    log('d1', edge, '00:05', 1003, '工程完了', 'CADカット完了', 'recD', true),     // 範囲の最初の日の 0:05（日本時間）
    log('e1', jst(5), '09:00', 1003, '抜型照合', '抜型照合', 'recE', true),
    log('f1', jst(4), '09:00', 1003, '工程完了', 'オートン抜き完了', 'recF', true),
    log('f2', jst(4), '09:01', 1003, '工程取消', 'オートン抜き完了', 'recF'),
  ];
  const rowsFrom = (list) => [...mod.countDaily(list).values()].filter(c => c.date >= from)
    .map(c => `${c.key}=${c.count}`).sort();
  const since = mod.logsSince(from);
  const windowed = logs.filter(l => l.fields[WL.at] > since);
  assert.ok(windowed.length < logs.length && windowed.some(l => l.id === 'd1'), '範囲より前のログは読まず、最初の日の朝は読む');
  assert.deepEqual(rowsFrom(windowed), rowsFrom(logs), '直近の分だけ読んでも、全部読んだときと同じ行になる');
  assert.equal(rowsFrom(windowed).length, 3, '書くのは やり直した人の手貼り・CAD・抜型照合 の3行');

  const calls = []; const prevFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if ((init.method || 'GET') !== 'GET') return new Response(JSON.stringify({ records: [] }), { status: 200 });
    const f = u.searchParams.get('filterByFormula') || '';
    const m = /IS_AFTER\(\{fldal1FMiPlRVn9BF\}, '([^']+)'\)/.exec(f);
    const recs = u.pathname.includes('tblQFZ7QEuRaBW4oj') ? logs.filter(l => !m || l.fields[WL.at] > m[1]) : [];
    return new Response(JSON.stringify({ records: recs }), { status: 200 });
  };
  try {
    const r = await mod.runIncentive();
    const q = calls.find(c => c.u.pathname.includes('tblQFZ7QEuRaBW4oj')).u.searchParams.get('filterByFormula');
    assert.ok(q.includes(`'${since}'`), '毎晩の集計は直近45日の1日前から読む');
    assert.equal(r.logs, windowed.length);
    assert.equal(r.rows, 3); assert.equal(r.written, 3); assert.equal(r.total, 3);
    const wrote = calls.filter(c => c.method === 'PATCH').flatMap(c => c.body.records.map(x => x.fields.fldCqMq8twEDgwn3a)).sort();
    assert.deepEqual(wrote, rowsFrom(logs).map(s => s.split('=')[0]));
    calls.length = 0;
    await mod.runIncentive({ full: true });
    const qf = calls.find(c => c.u.pathname.includes('tblQFZ7QEuRaBW4oj')).u.searchParams.get('filterByFormula');
    assert.ok(qf.includes(`'${mod.logsSince(mod.START_DATE)}'`), 'full は 10/8 の1日前から読む');
  } finally { global.fetch = prevFetch; }
});
test('MS1 画面: 完了・取消・材料の報告を保存できたらログイン帯の件数を数え直す', () => {
  assert.ok(/CREDIT_ACTIONS = new Set\(\['complete', 'cancel', 'stock'\]\)/.test(source));
  assert.ok(extract('write').includes('myStats.refresh(true)'));
});

// ---- QR1 工程表のQR（2026-11-08） ----
test('QR1 同じ品番が何件もあるとき、最後に見ていた作業リストで自分の工程がまだの受注が1件だけならそれを選ぶ。決まらなければ選ばない', () => {
  const env = { S: { view: 'auton', views: [{ key: 'auton', label: 'オートン抜き', mine: ['o'] }, { key: 'all', label: '全件', mine: [] }] } };
  env.hasMine = (v) => !!(v && (v.mine || []).length);
  env.viewTags = () => ['オートン'];
  env.itemTags = (o) => o.tags;
  env.mineDone = (o) => !!o.done;
  vm.createContext(env);
  vm.runInContext(extract('qrPick') + '\nglobalThis.qrPick = qrPick;', env);
  const a = { id: 'a', tags: ['オートン'], done: true }, b = { id: 'b', tags: ['オートン', '機械貼'], done: false }, c = { id: 'c', tags: ['機械貼'], done: false };
  assert.equal(env.qrPick([a, b, c])?.o.id, 'b', 'オートンでまだなのは b だけ');
  assert.equal(env.qrPick([a, { ...b, id: 'b2' }, b]), null, '2件残るなら選ばない');
  env.S.view = 'all';
  assert.equal(env.qrPick([a, b, c]), null, '自分の工程の無いリストからは選ばない');
});
test('QR1 QRを読んだら fromQr で探す。右下の QR ボタンは作業リストからでも 品番で探す に切り替えてカメラを開く', () => {
  assert.ok(source.includes("search({ fromQr: true })"));
  assert.ok(/\$\('qrFab'\)\.onclick = \(\) => \{[^]*?setMode\('find'\)[^]*?startCam\(\)/.test(source));
  assert.ok(extract('search').includes('qrPick(open)'));
});

// ---- ST1 止まっている受注（2026-11-08） ----
test('ST1 納期過ぎ／納期7日以内で3営業日動きなし（記録なしも）／10営業日動きなし を止まっているとする。営業日は土日・祝日を除く', () => {
  const at = (d) => Date.parse(`${d}T10:00:00+09:00`);
  const env = { todayJST: () => '2026-11-09', fmtChange: () => 'x', todoRooms: (o) => o.todo || [],
    latestChanges: (o) => (o.last ? { t: at(o.last), keys: new Set() } : null) };
  vm.createContext(env);
  vm.runInContext([
    line(/^  const ROSEN_HOLIDAYS = .*$/m), line(/^  const SHIPPED_OUT = .*$/m), line(/^  const STALL_IDLE = .*$/m),
    extract('daysFromToday'), extract('workdaysSince'), extract('stalledInfo'),
    'globalThis.stalledInfo = stalledInfo; globalThis.workdaysSince = workdaysSince;',
  ].join('\n'), env);
  const o = (x) => ({ done: {}, group: '', progOut: '', ...x });
  // 11/3 は祝日: 11/2(月)からの営業日は 11/4・5・6・9 の4日
  assert.equal(env.workdaysSince(at('2026-11-02')), 4);
  assert.equal(env.stalledInfo(o({ ndate: '2026-11-06', last: '2026-11-08' })).text, '納期を3日過ぎ');
  const near = env.stalledInfo(o({ ndate: '2026-11-12', last: '2026-11-03', todo: ['機械貼'] }));
  assert.ok(near && near.idle === 4 && near.sub.includes('次 機械貼'), '納期3日前で4営業日動きなし');
  assert.equal(env.stalledInfo(o({ ndate: '2026-11-12', last: '2026-11-06' })), null, '1営業日前に動きがあれば止まっていない');
  assert.ok(env.stalledInfo(o({ ndate: '2026-11-12' })), '納期が近くて動きの記録が無いものも出す');
  assert.ok(env.stalledInfo(o({ ndate: '2026-12-20', last: '2026-10-20' })), '納期が先でも10営業日以上動きなしは出す');
  assert.equal(env.stalledInfo(o({ ndate: '2026-12-20', last: '2026-11-02' })), null, '納期が先で4営業日なら出さない');
  assert.equal(env.stalledInfo(o({ ndate: '2026-11-06', group: '最終' })), null, '仕上がり済は出さない');
  assert.equal(env.stalledInfo(o({ ndate: '2026-11-06', progOut: '受領伝票発行可能' })), null, '伝票に進んだものは出さない');
  assert.equal(env.stalledInfo(o({ ndate: '2026-11-06', closed: true })), null);
  assert.equal(env.stalledInfo(o({ book: 'Yo', ndate: '2026-11-09' })), null, '工程表の無い Yo は出さない');
  assert.ok(env.stalledInfo(o({ book: 'Yo', ndate: '2026-11-09', printedAt: '2026-11-02 10:00', last: '2026-11-02' })), '工程表のある Yo は出す');
});
test('ST1 サーバー: 止まっている のリストは仕上がり・伝票に進んだ受注とアーカイブ済を読まない', async () => {
  const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_process.js')).href);
  const v = mod.VIEWS.stalled;
  assert.ok(v && v.stalled && mod.publicViews().find(x => x.key === 'stalled').stalled);
  const f = v.sources[0].formula;
  for (const w of ['NOT({アーカイブ済})', "{進行社内グループ}!='最終'", "'受領伝票発行可能'", "'伝票出力済'", "'完納済'"]) assert.ok(f.includes(w), w);
});

test('SH1 作業リストに Grid シート材料入荷 を出す。ビューの並び（紙入荷日順）のまま', async () => {
  const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_process.js')).href);
  const v = mod.VIEWS.sheet;
  assert.ok(v && v.label === 'シート材料入荷' && v.sources[0].id === 'viwqbcoqwCPvxtOOR');
  const pub = mod.publicViews().find(x => x.key === 'sheet');
  assert.ok(pub && pub.keepOrder && pub.mine.length === 0);
});

// ---- EST1 推定所要時間 2026-11-09（偽の Airtable。本物には繋がない） ----
test('EST1 一覧の行に推定（TableWorkTimeEstimate）を Book|WorkCord で付ける。3回以上だけ・アーカイブ済には付けない・読めなくても一覧は返す', async () => {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const calls = []; const prevFetch = global.fetch; let estFail = false;
  const rec = (id, f) => ({ id, fields: { NAmount: 100, ItemName: '箱', Ndate: '2026-12-01', '進行社外': '在庫シート利用', ...f } });
  const active = [rec('recESTHIT00000001', { Book: 'Ta', WorkCord: 336 }), rec('recESTNONE0000001', { Book: 'Ko', WorkCord: 99999 }),
    rec('recESTBAD00000001', { Book: 'Zz', WorkCord: 1 })];
  const archived = [rec('recESTARCH0000001', { Book: 'Ta', WorkCord: 336, Ndate: '2025-01-01' })];
  const est = [{ id: 'recE1', fields: { 'キー': 'Ta|336', '1個あたり分': 13.85, '1個あたり分_下': 10.7, '1個あたり分_上': 14.882, '回数': 125, '人数_中央値': 1 } },
    { id: 'recE2', fields: { 'キー': 'Ko|1', '1個あたり分': 1, '回数': 9 } }]; // 頼んでいないキーは使わない
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); const m = init.method || 'GET'; calls.push({ m, u });
    if (u.pathname.includes('/meta/')) return new Response(JSON.stringify({ tables: [] }), { status: 200 });
    if (u.pathname.includes('tblPbnYc3tIr9VYJ6')) return estFail ? new Response('{}', { status: 403 }) : new Response(JSON.stringify({ records: est }), { status: 200 });
    if (m !== 'GET') return new Response(JSON.stringify({ records: [] }), { status: 200 });
    const fm = u.searchParams.get('filterByFormula') || '';
    return new Response(JSON.stringify({ records: fm === '{アーカイブ済}' ? archived : fm === 'NOT({アーカイブ済})' ? active : [] }), { status: 200 });
  };
  try {
    const mod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', '_process.js')).href);
    const who = { user: { id: 'recSTAFF0000000001', no: 9001, name: 'テスト 太郎' } };
    const j = await (await mod.handleProcess('view', { view: 'all', refresh: true, lite: true }, who)).json();
    assert.equal(j.ok, true, JSON.stringify(j).slice(0, 200));
    const by = Object.fromEntries(j.rows.map(r => [r.id, r.est]));
    assert.deepEqual(by.recESTHIT00000001, { pp: 13.85, lo: 10.7, hi: 14.882, n: 125, people: 1 });
    assert.equal(by.recESTNONE0000001, undefined); assert.equal(by.recESTBAD00000001, undefined);
    assert.equal(by.recESTARCH0000001, undefined, 'アーカイブ済には付けない');
    const q = calls.filter(c => c.u.pathname.includes('tblPbnYc3tIr9VYJ6'));
    assert.equal(q.length, 1, '1回の読み取りでまとめて引く');
    const fm = q[0].u.searchParams.get('filterByFormula');
    assert.ok(fm.startsWith(`AND({回数}>=${mod.EST_MIN_JOBS},OR(`) && fm.includes("{キー}='Ta|336'") && fm.includes("{キー}='Ko|99999'") && !fm.includes('Zz'), fm);
    // 2回目は使い回す（表は毎晩しか変わらない）
    await (await mod.handleProcess('view', { view: 'all', refresh: true, lite: true }, who)).json();
    assert.equal(calls.filter(c => c.u.pathname.includes('tblPbnYc3tIr9VYJ6')).length, 1);
    // 推定の表が読めなくても一覧は返す（別の品番で試す）
    estFail = true; active.push(rec('recESTFAIL0000001', { Book: 'Yo', WorkCord: 5 }));
    const j2 = await (await mod.handleProcess('view', { view: 'all', refresh: true, lite: true }, who)).json();
    assert.equal(j2.ok, true); assert.equal(j2.rows.find(r => r.id === 'recESTFAIL0000001').est, undefined);
    assert.ok(j2.rows.find(r => r.id === 'recESTHIT00000001').est, '使い回し中の推定はそのまま');
  } finally { global.fetch = prevFetch; }
});
test('EST1 画面: 数量×1個あたり分で延べ時間と幅・回数を出す。閉じた受注・数量なし・推定なしは出さない', () => {
  const made = [];
  const mk = (tag) => { const el = { tag, className: '', textContent: '', title: '', kids: [], append(...xs) { this.kids.push(...xs); } }; made.push(el); return el; };
  const env = { document: { createElement: mk } };
  vm.createContext(env);
  vm.runInContext([extract('fmtMinutes'), extract('estLine'), 'Object.assign(globalThis, { fmtMinutes, estLine });'].join('\n'), env);
  const text = (el) => el.kids.map(k => typeof k === 'string' ? k : k.textContent).join(' ');
  assert.equal(env.fmtMinutes(4.2), '4分'); assert.equal(env.fmtMinutes(43), '45分'); assert.equal(env.fmtMinutes(92), '1時間30分');
  assert.equal(env.fmtMinutes(120), '2時間'); assert.equal(env.fmtMinutes(700), '11.5時間');
  const e = { pp: 1.5, lo: 1, hi: 2.2, n: 12, people: 2 };
  const s = env.estLine({ amount: 60, est: e });
  assert.equal(text(s), '推定 延べ1時間30分 1時間〜2時間10分・過去12回・2人なら約45分');
  assert.equal(env.estLine({ amount: 60, est: e, closed: true }), null);
  assert.equal(env.estLine({ amount: null, est: e }), null);
  assert.equal(env.estLine({ amount: 60 }), null);
  assert.equal(text(env.estLine({ amount: 10, est: { pp: 2, lo: 2, hi: 2, n: 3, people: 1 } })), '推定 延べ20分 過去3回', '幅が同じなら幅を出さない・1人なら人数割りを出さない');
  assert.ok(extract('facts').includes('const es = estLine(o); if (es) f.append(es);'));
});

// ---- SH2 シート材料入荷の作業リストは入荷日をどのカードも同じ場所（数量・納期の隣）に出す（2026-11-12） ----
test('SH2 シート材料入荷のカードは入荷日を数量・納期の隣に必ず出す。空は未入力、入荷済・在庫シートも日付を出す', () => {
  const mk = (tag) => ({ tag, className: '', textContent: '', kids: [], classList: { list: [], add(c) { this.list.push(c); } }, append(...xs) { this.kids.push(...xs); } });
  const env = { document: { createElement: mk }, WD: ['日', '月', '火', '水', '木', '金', '土'], OUT_ARRIVED: ['シート材料入荷済', '機械貼材料入荷済'],
    daysFromToday: (d) => ({ '2026-11-20': 8, '2026-11-12': 0, '2026-11-01': -11 })[d] };
  vm.createContext(env);
  vm.runInContext([extract('paperNote'), extract('arrivalFact'), 'Object.assign(globalThis, { arrivalFact });'].join('\n'), env);
  const text = (el) => el.kids.map(k => typeof k === 'string' ? k : k.textContent).join(' ');
  const cls = (el) => el.classList.list.join(' ');
  let a = env.arrivalFact({ paper: '' }); assert.equal(text(a), '入荷日 未入力'); assert.equal(cls(a), 'none');
  a = env.arrivalFact({ paper: '2026-11-20', progOut: 'シート手配済み' }); assert.equal(text(a), '入荷日 11/20(金) 予定'); assert.equal(cls(a), 'soon');
  a = env.arrivalFact({ paper: '2026-11-12', progOut: '' }); assert.equal(text(a), '入荷日 11/12(木) 本日・確認待ち'); assert.equal(cls(a), 'late');
  a = env.arrivalFact({ paper: '2026-11-01', progOut: 'シート手配済み' }); assert.equal(text(a), '入荷日 11/1(日) 要確認');
  a = env.arrivalFact({ paper: '2026-11-01', progOut: 'シート材料入荷済' }); assert.equal(text(a), '入荷日 11/1(日) 入荷済'); assert.equal(cls(a), 'ok');
  a = env.arrivalFact({ paper: '2026-11-01', progOut: '在庫シート利用' }); assert.equal(text(a), '入荷日 11/1(日) 在庫シート');
  assert.ok(extract('facts').includes("if (view === 'sheet') f.append(arrivalFact(o));"));
  assert.ok(source.includes('info.append(it, facts(o, S.view), mt, progressStrip(o, S.view));'));
});

// ---- RC1 Recent 1day: 前回見たときからの変化（2026-11-12。スマホの中だけで比べる） ----
test('RC1 Recent 1day は前回この端末で見た姿と比べて 新・変化（欄の名前）を付ける。基準なしは付けない。自分の記録は変化にしない。Recent にいる間は基準を変えない', () => {
  const block = line(/^  const SEEN_KEY[^]*?^  };\n/m);
  const mem = {};
  const env = { store: { get: (k) => mem[k] ?? null, set: (k, v) => { mem[k] = v; } }, document: { createElement: () => ({}) }, JSON, Object, String, Date };
  vm.createContext(env);
  vm.runInContext(block + '\nObject.assign(globalThis, { seen });', env);
  const { seen } = env;
  const A = { id: 'recA', progIn: '抜き作業中', progOut: 'シート手配済み', done: {}, amount: 100, ndate: '2026-11-20', paper: '', memo: '', room: [], die: [] };
  const B = { ...A, id: 'recB' };
  // 初めて: 基準が無いので何も付けない。今の姿は保存する
  seen.update([A, B]); assert.equal(seen.marks.size, 0); assert.ok(JSON.parse(mem['dl.seen.recent']).rows.recA);
  // 他のリストへ移ってから戻ると、保存した姿と比べる
  seen.leave();
  const A2 = { ...A, progOut: 'シート材料入荷済', paper: '2026-11-12' }, C = { ...A, id: 'recC' };
  seen.update([A2, B, C]);
  assert.deepEqual([...seen.marks.keys()].sort(), ['recA', 'recC']);
  assert.equal(JSON.stringify(seen.marks.get('recA')), JSON.stringify({ isNew: false, fields: ['進行社外', '紙入荷日'] }));
  assert.equal(seen.marks.get('recC').isNew, true);
  // Recent にいる間の読み直しでは基準を変えず、印は残る。このスマホで記録した受注（touched）は基準に入れて印を消す
  const B2 = { ...B, done: { o: '佐藤 2026-11-12 10:00' } };
  seen.touched.add('recB');
  seen.update([A2, B2, C]);
  assert.deepEqual([...seen.marks.keys()].sort(), ['recA', 'recC'], '自分の記録は変化にしない・前の印は残る');
  const B3 = { ...B2, memo: '急ぎ' };
  seen.update([A2, B3, C]);
  assert.equal(seen.marks.get('recB').fields.join(), '連絡事項', '他の人の変化はその後も付く');
  // 戻り直すと、最後に出した姿が基準になり印は消える
  seen.leave(); seen.update([A2, B3, C]); assert.equal(seen.marks.size, 0);
  // 保存が壊れていても止まらず、基準なしとして扱う
  mem['dl.seen.recent'] = '{壊れた'; seen.leave(); seen.update([A2]); assert.equal(seen.marks.size, 0);
  // 画面: Recent のときだけ読み直しで比べ、他のビュー・他のモードでは基準を捨てる。書き込みが通ったら touched に入れる
  assert.ok(extract('loadView').includes("if (S.view === 'recent') seen.update(j.rows); else seen.leave();"));
  assert.ok(extract('setMode').includes("if (m !== 'list') seen.leave();"));
  assert.ok(extract('write').includes('if (body.id) seen.touched.add(body.id)'));
  assert.ok(extract('renderList').includes("if (S.view === 'recent' && seen.chgOnly) base = base.filter(o => seen.marks.has(o.id));"));
});

// ---- UD1 工程の取り消しを分かりやすく（2026-11-13。権限は今のまま本人と管理者だけ） ----
test('UD1 取り消せる記録だけボタンを出し、他の人の記録は頼む先を書く。カード上に最後の記録と取り消し。記録直後の案内から取り消せる', async () => {
  const mk = (tag) => ({ tag, className: '', textContent: '', type: '', dataset: {}, kids: [], attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, append(...xs) { this.kids.push(...xs); } });
  const calls = [];
  const env = { document: { createElement: mk }, me: { name: '佐藤 太郎', role: 'スタッフ' }, $: (id) => ({ id }),
    S: { steps: [{ key: 'o', label: 'オートン抜き完了', variants: [{ value: 'オートン抜き完了' }] }, { key: 'finish', label: '仕上がりました', variants: [{ value: '仕上がりました' }] }] },
    current: () => null, cancelStep: (...a) => calls.push(a),
    fullStamp: (t) => t, latestKey: (o) => o.k };
  vm.createContext(env);
  vm.runInContext([line(/^  const stampWho = .*$/m), extract('canUndo'), extract('undoControl'), extract('lastRecordRow'),
    'Object.assign(globalThis, { canUndo, undoControl, lastRecordRow, stampWho });'].join('\n'), env);
  assert.equal(env.canUndo('佐藤 太郎 2026-11-13 10:00').ok, true, '自分の記録');
  assert.equal(env.canUndo('').ok, true, '記録者なし');
  assert.equal(env.canUndo('Airtable 2026-11-13 10:00').ok, true, 'オートメーション');
  const other = env.canUndo('田中 花子 2026-11-13 10:00');
  assert.equal(other.ok, false); assert.equal(other.who, '田中 花子', '空白のある名前も日時より前を全部');
  assert.equal(env.canUndo('佐藤 2026-11-13 10:00').ok, false, '名前の頭が同じだけの別人は本人とみなさない');
  env.me.role = '管理者'; assert.equal(env.canUndo('田中 花子 2026-11-13 10:00').ok, true, '管理者は誰の記録も'); env.me.role = 'スタッフ';
  const s = env.S.steps[0];
  const no = env.undoControl(s, '田中 花子 2026-11-13 10:00', '記録を取り消す', null);
  assert.equal(no.className, 'undo-no'); assert.match(no.textContent, /田中 花子 さんの記録です。取り消しは本人か管理者/);
  const yes = env.undoControl(s, '佐藤 太郎 2026-11-13 10:00', '記録を取り消す', { id: 'box' });
  assert.equal(yes.tag, 'button'); assert.equal(yes.dataset.w, '1', '書き込み中はまとめて止める');
  yes.onclick(); assert.equal(calls.length, 1); assert.equal(calls[0][4].id, 'box', '案内は押したボタンの箱に出す');
  // 最後の記録: 今の進行社内の工程か一番新しい記録。記録者なしでも進行社内がその工程なら出す。何も無ければ出さない
  const r = env.lastRecordRow({ k: 'o', progIn: 'オートン抜き完了', done: { o: '佐藤 太郎 2026-11-13 10:00' } });
  assert.equal(r.className, 'lastrec'); assert.equal(r.kids[1].textContent, '✓ オートン抜き完了'); assert.equal(r.kids[3].textContent, 'この記録を取り消す');
  assert.equal(env.lastRecordRow({ k: 'finish', progIn: '仕上がりました', done: {} }).kids[2].textContent, '記録者なし');
  assert.equal(env.lastRecordRow({ k: '', done: {} }), null);
  assert.equal(env.lastRecordRow({ k: 'o', progIn: '', done: {} }), null);
  // 画面: カードの主操作の上に最後の記録。記録直後の案内に取り消し。案内からはカードを開かずに取り消す
  assert.ok(extract('renderPrimary').includes('const lr = lastRecordRow(o); if (lr) box.append(lr);'));
  assert.ok(extract('doneCell').includes("undoControl(s, done, '記録を取り消す'"));
  assert.ok(extract('afterComplete').includes('undo: s ? { o, s, stamp:'));
  assert.ok(source.includes("$('toastUndo').hidden = !t.undo;"));
  assert.ok(source.includes('cancelStep(u.s, u.stamp, u.o, true)'));
  assert.ok(extract('cancelStep').includes('if (fromToast) S.sel = o.id;'));
  // サーバー: 権限は変えない（本人か管理者。記録者なしは誰でも）。断るときの名前は日時より前を全部
  const srv = fs.readFileSync(path.join(__dirname, '..', 'api', '_process.js'), 'utf8');
  assert.ok(srv.includes("if (!unowned && user.role !== ROLE_ADMIN && !String(cur).startsWith(`${user.name} `))"));
  assert.ok(srv.includes("${String(cur).replace(/\\s+\\d{4}-\\d\\d-\\d\\d.*$/, '').trim()} さんの記録なので取り消せません"));
});

// ---- AC1 受領伝票発行可能になる工程は、完了の前に仕上がり数量を確かめる（2026-11-13） ----
test('AC1 最終になる工程（進行社内グループの数式・FinalProcess）だけ数量を確かめる。数量を直したら先に保存し、失敗なら完了を送らない', async () => {
  const env = {};
  vm.createContext(env);
  vm.runInContext([line(/^  const FINAL_VALUES = .*$/m), line(/^  const PROC_GROUP = .*$/m), extract('reachesSlip'), extract('needsAmountCheck'),
    'Object.assign(globalThis, { reachesSlip, needsAmountCheck });'].join('\n'), env);
  const o = (x = {}) => ({ item: '箱 #o', finalProcess: '', amountLocked: false, ...x });
  for (const v of ['仕上がりました', '製品在庫から', '機械貼完了', '手貼り完了']) assert.equal(env.needsAmountCheck(o(), v), true, v);
  assert.equal(env.needsAmountCheck(o(), 'オートン抜き完了'), false, '抜きは FinalProcess が無ければ途中の工程');
  assert.equal(env.needsAmountCheck(o(), '生地カット終了'), false);
  assert.equal(env.needsAmountCheck(o({ finalProcess: '抜き完了' }), 'オートン抜き完了'), true, 'FinalProcess＝抜き完了なら抜きが最後');
  assert.equal(env.needsAmountCheck(o({ finalProcess: '抜き完了' }), 'CADカット完了'), true);
  assert.equal(env.needsAmountCheck(o(), 'シール貼完了'), true, '#ki が無ければシール貼は最終');
  assert.equal(env.needsAmountCheck(o({ item: '箱 #ki' }), 'シール貼完了'), false, '#ki のシール貼は FinalProcess しだい');
  assert.equal(env.needsAmountCheck(o({ item: '箱 #ki', finalProcess: 'シール貼完了' }), 'シール貼完了'), true);
  assert.equal(env.needsAmountCheck(o({ amountLocked: true }), '仕上がりました'), false, '伝票発行後は数量を変えられないので聞かない');
  assert.equal(env.needsAmountCheck(o({ finalProcess: '仕上完了早期引取' }), 'オートン抜き完了'), false);

  // 画面の流れ: 確かめの欄から「この数量で完了」
  const mk = (tag) => ({ tag, className: '', textContent: '', value: '', type: '', dataset: {}, kids: [], hidden: true, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, append(...xs) { this.kids.push(...xs); }, after() {}, focus() {}, select() {} });
  async function run(amountIn, amountReply, cur = 1000) {
    const sent = [], said = [];
    const box = mk('div');
    const e = { document: { createElement: mk }, confirm: () => true, sent, said,
      $: (id) => (id === 'variants' ? box : mk('div')),
      applyLocks() {}, sayAt: (el, t, c) => said.push([t, c || '']),
      runOp: async (x, fn) => fn(),
      write: async (b) => { sent.push(b); return b.action === 'amount' ? amountReply : { ok: true }; },
      outcomeUnknown: (j, need) => !!j.unknown || (j.ok && !need(j)),
      markUnsure: (x, what) => said.push(['unsure ' + what, '']),
      patch: (x, fn) => fn(x),
      saveComplete: async (x, s, v) => { sent.push({ action: 'complete', amountAtSave: x.amount, value: v.value }); },
    };
    vm.createContext(e);
    vm.runInContext(extract('showAmountCheck') + '\nglobalThis.showAmountCheck = showAmountCheck;', e);
    const ord = { id: 'recA', amount: cur };
    e.showAmountCheck(ord, { key: 'finish' }, { value: '仕上がりました' }, false, null);
    assert.equal(box.hidden, false); assert.match(box.kids[0].textContent, /受領伝票を発行できるようになります/);
    const [, inp, go, stop] = box.kids;
    assert.equal(inp.value, cur, '今の数量を入れておく'); assert.equal(go.dataset.w, '1', '書き込み中は押せない');
    inp.value = amountIn;
    await go.onclick();
    return { sent, said, ord, box, stop };
  }
  let r = await run('1000');
  assert.deepEqual(r.sent.map(x => x.action), ['complete'], 'そのままなら数量は送らない');
  r = await run('1,020', { ok: true, amount: 1020, line: '1000→1020 佐藤' });
  assert.deepEqual(r.sent.map(x => x.action), ['amount', 'complete'], '数量を先に保存してから完了');
  assert.equal(r.sent[1].amountAtSave, 1020);
  r = await run('1020', { ok: false, error: '桁が違います' });
  assert.deepEqual(r.sent.map(x => x.action), ['amount'], '数量を保存できなければ完了を送らない');
  assert.match(r.said.at(-1)[0], /完了はまだ記録していません/);
  r = await run('1020', { unknown: true });
  assert.deepEqual(r.sent.map(x => x.action), ['amount'], '数量が結果不明なら完了を送らない');
  r = await run('abc');
  assert.deepEqual(r.sent, [], '整数でなければ何も送らない');
  // 押した流れ: doComplete は最終になる工程だけ確かめの欄へ回す。サーバーは FinalProcess を一覧に返す
  assert.ok(extract('doComplete').includes('if (needsAmountCheck(o, v.value)) return showAmountCheck(o, s, v, force, near);'));
  const srv = fs.readFileSync(path.join(__dirname, '..', 'api', '_process.js'), 'utf8');
  assert.ok(srv.includes("finalProcess: String(f[F.finalProcess] || '').trim(),"));
  assert.ok(/const LIST_FIELDS = \[[^\]]*F\.finalProcess/.test(srv));
});

// ---- RC2 Recent 1day: Airtable の最終更新から「○分前」の印と枠（2026-11-13） ----
test('RC2 30分以内は hot・2時間以内は warm・それより前は印だけ。記録の時刻が最終更新と重なれば何が変わったかを添える。初めて開いても出る', () => {
  const env = { S: { steps: [{ key: 'finish', label: '仕上がりました' }, { key: 'o', label: 'オートン抜き完了' }] }, document: { createElement: () => ({ className: '', textContent: '', title: '' }) } };
  vm.createContext(env);
  vm.runInContext([line(/^  const UPD_HOT_MIN = .*$/m), extract('recTime'), extract('logTime'), line(/^  const AMT_LOG = .*$/m), line(/^  const NDATE_LOG = .*$/m),
    extract('latestChanges'), extract('fmtChange'), extract('updInfo'), extract('updBadge'),
    'Object.assign(globalThis, { updInfo, updBadge });'].join('\n'), env);
  const now = Date.parse('2026-11-13T06:00:00Z'); // 15:00 JST
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  assert.equal(env.updInfo({ updatedAt: at(5), done: {} }, now).level, 'hot');
  assert.equal(env.updInfo({ updatedAt: at(30), done: {} }, now).level, 'hot');
  assert.equal(env.updInfo({ updatedAt: at(31), done: {} }, now).level, 'warm');
  assert.equal(env.updInfo({ updatedAt: at(121), done: {} }, now).level, '');
  assert.equal(env.updInfo({ updatedAt: '', done: {} }, now), null, '更新時間が無ければ出さない');
  assert.equal(env.updInfo({ updatedAt: at(0.2), done: {} }, now).ago, 'たった今');
  assert.equal(env.updInfo({ updatedAt: at(75), done: {} }, now).ago, '1時間15分前');
  // 仕上がりました の記録が 14:50 JST、最終更新 14:51 → 添える。最終更新が 30分後なら別の変更なので添えない
  const o = { updatedAt: '2026-11-13T05:51:00.000Z', done: { finish: '佐藤 2026-11-13 14:50' } };
  const b = env.updBadge(o, now);
  assert.equal(b.level, 'hot'); assert.equal(b.el.className, 'upd hot');
  assert.equal(b.el.textContent, '更新 9分前（14:51） 仕上がりました');
  assert.equal(env.updInfo({ ...o, updatedAt: '2026-11-13T05:20:00.000Z' }, now).what, '');
  // 画面: Recent のカードだけに付け、枠のクラスを足す。変化の印（seen）とは別。描き直さない自動の読み直しでも時刻を合わせる
  const lr = extract('renderList');
  assert.ok(lr.includes("const ub = S.view === 'recent' ? updBadge(o) : null; if (ub) { bd.append(ub.el); if (ub.level) el.classList.add('upd-' + ub.level); }"));
  assert.ok(extract('loadView').includes('if (quiet && sig === shownSig) { refreshUpd();'));
  assert.ok(source.includes('setInterval(refreshUpd, 60 * 1000);'));
  const srv = fs.readFileSync(path.join(__dirname, '..', 'api', '_process.js'), 'utf8');
  assert.ok(srv.includes("updatedAt: String(f[F.updated] || ''),"));
  assert.ok(/const LIST_FIELDS = \[[^\]]*F\.updated/.test(srv));
});

// ---- AU1 照合・棚登録・図面・伝票の API はログイン必須（2026-11-10。偽の Airtable。本物には繋がない） ----
test('AU1 未ログインは 401（needLogin）。社員表を読めないときは 503 で未ログインと取り違えない。伝票照合は照合した人を作業ログに残す', async () => {
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const imp = (f) => import(require('url').pathToFileURL(path.join(__dirname, '..', 'api', f)).href);
  const auth = await imp('_auth.js');
  const ORIGIN = 'https://app.example.com';
  const sid = { ok: 'recAU1ok000000001', down: 'recAU1down0000002', gone: 'recAU1gone0000003' };
  const token = (id) => auth.signSession(auth.makeSessionPayload({ id, no: 1001, name: '試験 太郎', role: 'スタッフ', gen: 1 }));
  const req = async (p, { id, csrf = true, method = 'POST', body } = {}) => new Request(ORIGIN + p, {
    method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...(csrf ? { 'x-csrf': 't' } : {}),
      cookie: [csrf ? 'xcsrf=t' : '', id ? `dl_sess=${await token(id)}` : ''].filter(Boolean).join('; ') },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const calls = []; const prevFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); const method = init.method || 'GET';
    calls.push({ u, method, body: init.body ? JSON.parse(init.body) : null });
    const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname.endsWith('/' + sid.ok)) return ok({ id: sid.ok, fields: { 氏名: '試験 太郎', 社員番号: 1001, PIN暗号値: 'x', 有効: true, ログイン世代: 1 } });
    if (u.pathname.endsWith('/' + sid.down)) return new Response('{"error":"bad"}', { status: 400 }); // 読めない（404 ではない）
    if (u.pathname.endsWith('/' + sid.gone)) return new Response('{"error":"NOT_FOUND"}', { status: 404 });
    if (method === 'PATCH') return ok({ records: init.body ? JSON.parse(init.body).records.map(r => ({ id: r.id })) : [] });
    return ok({ records: [] });
  };
  try {
    let a = await auth.requireUser(await req('/api/x'));
    assert.equal(a.deny.status, 401); assert.equal((await a.deny.json()).needLogin, true, 'Cookie が無ければ needLogin');
    a = await auth.requireUser(await req('/api/x', { id: sid.ok }));
    assert.equal(a.user.name, '試験 太郎'); assert.equal(a.user.no, 1001);
    a = await auth.requireUser(await req('/api/x', { id: sid.down }));
    assert.equal(a.deny.status, 503, '社員表を読めないときは未ログイン扱いにしない');
    assert.ok(!(await a.deny.json()).needLogin);
    a = await auth.requireUser(await req('/api/x', { id: sid.gone }));
    assert.equal(a.deny.status, 401, '社員の行が無ければ無効');

    // 各 API: 未ログインは 401、外部（Airtable・Google・AI）には何も送らない
    const edge = [
      ['slip-verify.js', '/api/slip-verify', { action: 'verify', items: [{ id: 'recSLIP0000000001', status: 'OK' }] }],
      ['airtable-update-progress.js', '/api/airtable-update-progress', { action: 'stored', items: [{ book: 'Ta', wc: '1', loc: 'A-1' }] }],
      ['airtable-update-progress.js', '/api/airtable-update-progress', { action: 'orders', book: 'Ta', wc: '1' }],
      ['die-check.js', '/api/die-check', { book: 'Ta', wc: '1', json: true }],
      ['box-detect.js', '/api/box-detect', { image: 'AAAA' }],
      ['material-match.js', '/api/material-match', { book: 'Ta', wc: '1', image: 'AAAA' }],
      ['die-align-verify.js', '/api/die-align-verify', { book: 'Ta', wc: '1', image: 'AAAA' }],
    ];
    process.env.AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN || 'TEST_ONLY_NOT_A_TOKEN'; // die-check は AIRTABLE_TOKEN を見る
    for (const [file, p, body] of edge) {
      const h = (await imp(file)).default; calls.length = 0;
      const r = await h(await req(p, { body }));
      assert.equal(r.status, 401, `${p} ${body.action || ''} は未ログインで 401`);
      assert.equal(calls.length, 0, `${p} は未ログインのとき外部に何も送らない`);
    }
    for (const p of ['/api/drive-find?book=Ta&wc=1', '/api/drive-proxy?id=abc']) {
      const h = (await imp(p.slice(5).split('?')[0] + '.js')).default; calls.length = 0;
      const r = await h(await req(p, { method: 'GET', csrf: false }));
      assert.equal(r.status, 401, `${p} は未ログインで 401`); assert.equal(calls.length, 0);
    }
    // 図面の表示は X-CSRF ヘッダが無くても、ログインしていれば検証を通る（iframe の PDF）。先へ進んで Google の設定不足で止まる
    const px = await (await imp('drive-proxy.js')).default(await req('/api/drive-proxy?id=abc', { method: 'GET', csrf: false, id: sid.ok }));
    assert.notEqual(px.status, 401); assert.notEqual(px.status, 403);

    // 棚登録（Node ランタイム）: CSRF なしは 403、未ログインは 401
    const gs = (await imp('gsheet-seen-bulk.js')).default;
    const nodeCall = async (headers) => {
      const out = {}; const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
      await gs({ method: 'POST', url: '/api/gsheet-seen-bulk', headers: { host: 'app.example.com', origin: ORIGIN, ...headers }, body: { items: [{ book: 'Ta', wc: '1', loc: 'A-1' }] } }, res);
      return out;
    };
    assert.equal((await nodeCall({})).status, 403);
    const g401 = await nodeCall({ cookie: 'xcsrf=t', 'x-csrf': 't' });
    assert.equal(g401.status, 401); assert.equal(g401.body.needLogin, true);

    // 伝票照合: ログインしていれば書き、照合した人を作業ログ（伝票照合・実績対象なし）に残す
    const slip = (await imp('slip-verify.js')).default; calls.length = 0;
    const r = await slip(await req('/api/slip-verify', { id: sid.ok, body: { action: 'verify', items: [{ id: 'recSLIP0000000001', status: 'UpdatedBySlip', namount: 1200 }] } }));
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.updated, 1); assert.equal(j.operator, '試験 太郎');
    const logPost = calls.find(c => c.method === 'POST' && c.u.pathname.includes('tblQFZ7QEuRaBW4oj'));
    assert.ok(logPost, '作業ログに書く');
    const lf = logPost.body.records[0].fields;
    assert.equal(lf.fldHbWQ5VemkIPMmS, '伝票照合'); assert.equal(lf.fldmjyRUDyPPaFFnb, 1001);
    assert.match(lf.fldJvGOGNVnGzadUW, /^UpdatedBySlip（数量 1200・進行社外 完納（数量訂正））$/);
    assert.equal(lf.fldOfsIbZmKNfeik8, 'recSLIP0000000001'); assert.ok(!('fldIHadyI8FqyEqQ5' in lf), 'インセンティブには数えない');
  } finally { global.fetch = prevFetch; }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); }
    catch (err) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(err.message).split('\n')[0]); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
