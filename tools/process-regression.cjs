// tools/process-regression.cjs
// public/process.html の一覧読み込み・書き込み結果の扱いの回帰テスト（2026-10-23 再レビュー R1〜R5）。
// 関数をページから抜き出し、DOM・通信・認証はすべて作り物で動かす。本番の API・Airtable には触れない。
// 実行: node tools/process-regression.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

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
    rowsSig: (rows) => JSON.stringify(rows),
    say: (el, text, cls = '') => { el.textContent = text || ''; el.className = 'msg ' + cls; },
    renderChips() {}, updateListHead() {}, loadImages() {}, showFresh() {},
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
function apiEnv(fetchImpl) {
  const env = { fetch: fetchImpl, DLAuth: { csrf: async () => 'MOCK', loginUrl: () => '/login' }, location: { replace() {} } };
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
  for (const [fn, key] of [['doComplete', 'complete'], ['cancelStep', 'cancel'], ['amountEditor', 'amount'], ['ndateEditor', 'ndate'], ['paperEditor', 'paper'], ['toggleRoom', 'room'], ['setStockOut', 'stock']]) {
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
  vm.runInContext('let op = null;\n' + extract('runOp') + '\nglobalThis.runOp = runOp; globalThis.opNow = () => op;', env);
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
  // 完了の送信は doComplete の write 1回だけ（afterComplete・一覧の読み直しからは送らない）
  assert.equal((extract('doComplete').match(/write\(/g) || []).length, 1);
  assert.doesNotMatch(extract('afterComplete'), /write\(|api\(/);
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
