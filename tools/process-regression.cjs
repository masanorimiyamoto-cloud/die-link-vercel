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
test('R3 完了・取消・数量・納期・Room の書き込みは、どれも結果不明の扱い（markUnsure）を通る', async () => {
  for (const [fn, key] of [['doComplete', 'complete'], ['cancelStep', 'cancel'], ['amountEditor', 'amount'], ['ndateEditor', 'ndate'], ['toggleRoom', 'room']]) {
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

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); }
    catch (err) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(err.message).split('\n')[0]); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
