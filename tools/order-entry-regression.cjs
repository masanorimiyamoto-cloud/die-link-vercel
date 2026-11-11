// 新規入力の検索・本人の履歴・画面操作を、本番へ接続せず検証する。
// node tools/order-entry-regression.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const html = fs.readFileSync(path.join(__dirname, '../public/process.html'), 'utf8');
const extract = name => {
  const m = html.match(new RegExp('^  (?:async )?function ' + name + '\\([^]*?^  }', 'm'));
  assert.ok(m, name); return m[0];
};
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const rid = n => 'rec' + String(n).padStart(14, '0');
const order = (n, extra = {}) => ({ id: rid(n), fields: { Book: 'Ta', WorkCord: 321, ItemName: '箱 #ki', Kname: '検証紙器', DeliPlace: '本社', Ndate: '2026-11-20', NAmount: 100, ...extra } });
const who = { user: { id: rid(9001), no: 9001, name: '検証 太郎' } };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function serverWorld(fn) {
  const original = global.fetch;
  process.env.AIRTABLE_PAT = 'TEST_ONLY_NOT_A_TOKEN';
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, method: init.method || 'GET' });
    return fn(url, init);
  };
  const mod = await import(pathToFileURL(path.join(__dirname, '../api/_process.js')).href);
  return {
    calls,
    run: async (body, actor = who) => {
      const r = await mod.handleProcess('orderTemplates', body, actor);
      return { status: r.status, body: await r.json() };
    },
    restore: () => { global.fetch = original; },
  };
}

test('本人の登録履歴から新しい順に品目をまとめ、削除済み・別の納品先を正しく扱う', async () => {
  const logIds = [rid(5), rid(4), rid(3), rid(2), rid(1)];
  const e = await serverWorld(url => {
    if (url.pathname.includes('tblQFZ7QEuRaBW4oj')) {
      assert.equal(url.searchParams.get('filterByFormula'), "AND({操作}='新規受注',{社員番号}=9001)");
      return response({ records: logIds.map(id => ({ fields: { 受注ID: id } })) });
    }
    return response({ records: [order(1), order(2), order(4, { DeliPlace: '第二倉庫' }), order(5, { アーカイブ済: true })] });
  });
  try {
    const r = await e.run({ recent: true });
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.templates.map(o => o.id), [rid(5), rid(4)]);
    assert.ok(e.calls.every(c => c.method === 'GET'));
    assert.equal(e.calls.length, 2);
  } finally { e.restore(); }
});
test('履歴なし・社員番号なし・未ログインでは他人の候補や不要な読み込みをしない', async () => {
  const e = await serverWorld(() => response({ records: [] }));
  try {
    assert.deepEqual((await e.run({ recent: true })).body.templates, []);
    assert.equal(e.calls.length, 1);
    assert.deepEqual((await e.run({ recent: true }, { user: {} })).body.templates, []);
    assert.equal((await e.run({ recent: true }, null)).status, 401);
    assert.equal(e.calls.length, 1);
  } finally { e.restore(); }
});
test('顧客・品名・コードを検索し、ページを進め、同じ品目でもBook・顧客・納品先の違いを残す', async () => {
  const e = await serverWorld(url => {
    const formula = url.searchParams.get('filterByFormula');
    assert.ok(formula.includes('{Kname}') && formula.includes('{ItemName}') && formula.includes('{WorkCord}'));
    assert.ok(formula.includes("LOWER('321')") && !formula.includes('アーカイブ済'));
    return url.searchParams.get('offset') ? response({ records: [order(3, { Book: 'Ko' }), order(4, { Kname: '別の顧客' }), order(5, { DeliPlace: '第二倉庫' })] })
      : response({ records: [order(1, { アーカイブ済: true }), order(2)], offset: 'next' });
  });
  try {
    const r = await e.run({ query: '３２１' });
    assert.deepEqual(r.body.templates.map(o => o.id), [rid(1), rid(3), rid(4), rid(5)]);
    assert.equal(r.body.more, false); assert.equal(e.calls.length, 2);
  } finally { e.restore(); }
});
test('検索の打ち切りを知らせ、長過ぎる検索や不正なIDは読まずに断る', async () => {
  const e = await serverWorld(url => {
    const page = Number(url.searchParams.get('offset') || 0);
    const length = page === 200 ? 1 : 100;
    return response({ records: Array.from({ length }, (_, i) => order(page + i + 1, { WorkCord: page + i + 1 })), ...(page < 200 ? { offset: String(page + 100) } : {}) });
  });
  try {
    const r = await e.run({ query: '', book: 'Ta' });
    assert.equal(r.body.more, true); assert.equal(r.body.templates.length, 200);
    assert.equal(e.calls.length, 3);
    assert.equal((await e.run({ query: 'a'.repeat(101) })).status, 400);
    assert.equal((await e.run({ id: 'bad' })).status, 400);
    assert.equal(e.calls.length, 3);
  } finally { e.restore(); }
});
test('最近の品目を選ぶと元の受注を再取得し、削除済みは登録へ進めない', async () => {
  const e = await serverWorld(url => url.pathname.endsWith(rid(1)) ? response(order(1, { Kname: '変更後の顧客' })) : response({}, 404));
  try {
    assert.equal((await e.run({ id: rid(1) })).body.templates[0].spec.kname, '変更後の顧客');
    assert.equal((await e.run({ id: rid(2) })).status, 404);
    assert.ok(e.calls.every(c => c.method === 'GET'));
  } finally { e.restore(); }
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.hidden = false;
    this.value = ''; this.className = ''; this.disabled = false;
    this.classList = { contains: c => this.className.split(' ').includes(c) };
  }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
  append(...els) { this.children.push(...els); }
  setAttribute(k, v) { this.attributes[k] = v; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  querySelectorAll(selector) {
    const all = this.children.flatMap(c => [c, ...c.querySelectorAll(selector)]);
    return selector === '[data-w]' ? all.filter(c => c.dataset.w) : all;
  }
}
function pageWorld(api, sharedStore = new Map(), user = who.user) {
  const nodes = new Map(); const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const ctx = {
    $, nodes, me: user, S: { mode: 'new', orders: [], sel: null, newIds: new Set() },
    document: { createElement: tag => new Element(tag) }, store: { get: k => sharedStore.get(k), set: (k, v) => sharedStore.set(k, v) },
    api, say: (el, text, cls = '') => { el.textContent = text; el.className = 'msg ' + cls; },
    approveCtl: () => new Element(), hideToast() {}, updateNav() {}, scrollToCard() {},
    itemShort: o => o.item, navigator: { vibrate() {} }, WD: ['日', '月', '火', '水', '木', '金', '土'],
    current: () => ctx.S.orders.find(o => o.id === ctx.S.sel), detailOpen: () => false,
    confirm: () => true,
  };
  ctx.write = api;
  vm.createContext(ctx);
  const names = ['entryHistory', 'rememberEntry', 'entryChoice', 'renderEntryHistory', 'openOrderEntry', 'loadEntryHistory', 'searchEntry', 'selectEntry', 'renderNewOrder', 'runOp', 'busyNow', 'applyLocks', 'sayAt'];
  vm.runInContext([
    'let entryGen=0, listGen=0, listBusy=0, findGen=0, writing=0, op=null;',
    html.match(/^  const entryKey = .*$/m)[0], html.match(/^  const entryHistoryKey = .*$/m)[0],
    ...names.map(extract),
    `Object.assign(globalThis, { ${names.join(',')} });`,
    'globalThis.bumpEntry = () => { entryGen++; };',
  ].join('\n'), ctx);
  return ctx;
}
const template = n => ({ id: rid(n), book: 'Ta', wc: n, item: '品目' + n, spec: { kname: '検証紙器' }, deli: '本社', amount: 100 });
const descendants = el => el.children.flatMap(c => [c, ...descendants(c)]);
const formControls = e => {
  const all = descendants(e.$('entryForm'));
  return { amount: all.find(x => x.attributes['aria-label'] === '数量'), date: all.find(x => x.attributes['aria-label'] === '納期'), save: all.find(x => x.textContent === '登録する') };
};
test('最近登録した品目は最大12件・同じ品目をまとめ、ログインした人ごとに分ける', () => {
  const storage = new Map(), e = pageWorld(async () => ({}), storage);
  for (let i = 1; i <= 15; i++) e.rememberEntry(template(i));
  e.rememberEntry({ ...template(14), id: rid(99), amount: 10000, done: { finish: '履歴' }, images: ['図面'] });
  assert.equal(e.entryHistory().length, 12); assert.equal(e.entryHistory()[0].id, rid(99));
  assert.ok(!JSON.stringify(e.entryHistory()).includes('図面'));
  assert.deepEqual(Array.from(pageWorld(async () => ({}), storage, { id: rid(9002) }).entryHistory()), []);
});
test('遅れて届いた検索・履歴は、選び直した品目や別の画面を上書きしない', async () => {
  const pending = [];
  const e = pageWorld(body => new Promise(resolve => pending.push({ body, resolve })));
  const a = e.selectEntry(rid(1)), b = e.selectEntry(rid(2));
  pending[1].resolve({ ok: true, templates: [template(2)] }); await b;
  pending[0].resolve({ ok: true, templates: [template(1)] }); await a;
  assert.equal(e.S.sel, rid(2));
  const p = e.searchEntry(); e.S.mode = 'find';
  pending[2].resolve({ ok: true, templates: [template(3)] }); await p;
  assert.equal(e.$('entryResults').children.length, 0);
});
test('品目の削除・検索失敗を知らせ、作成処理は送らない', async () => {
  const calls = [], e = pageWorld(async body => { calls.push(body); return { ok: false, error: '元の受注がありません' }; });
  await e.selectEntry(rid(1));
  assert.equal(e.S.sel, null); assert.equal(e.$('entryForm').hidden, true);
  assert.ok(e.$('entryMsg').textContent.includes('ありません'));
  assert.ok(calls.every(c => c.action === 'orderTemplates'));
});
test('専用画面から数量・納期を登録でき、同時の二度押しを止めて最近の品目に残す', async () => {
  let finish; const sent = [];
  const e = pageWorld(async body => {
    if (body.action === 'orderTemplates') return { ok: true, templates: body.id ? [template(1)] : [] };
    sent.push(body); return new Promise(resolve => { finish = resolve; });
  });
  await e.selectEntry(rid(1)); const c = formControls(e);
  c.amount.value = '１，２００'; c.date.value = '2026-11-20';
  const first = c.save.onclick(); await c.save.onclick();
  assert.equal(sent.length, 1); assert.equal(sent[0].id, rid(1)); assert.equal(sent[0].amount, '1200');
  assert.equal(c.save.disabled, true);
  finish({ ok: true, order: { ...template(20), wc: 1, amount: 1200 } }); await first;
  assert.equal(e.S.sel, null); assert.equal(e.entryHistory()[0].id, rid(20));
  assert.ok(e.$('entryMsg').textContent.includes('新規受注を作りました'));
});
test('登録の結果不明は自動再送せず、成功や履歴追加にしない', async () => {
  let sends = 0;
  const e = pageWorld(async body => {
    if (body.action === 'orderTemplates') return { ok: true, templates: [template(1)] };
    sends++; return { ok: false, unknown: true };
  });
  await e.selectEntry(rid(1)); const c = formControls(e);
  c.amount.value = '100'; c.date.value = '2026-11-20'; await c.save.onclick();
  assert.equal(sends, 1); assert.equal(e.entryHistory().length, 0);
  assert.ok(e.$('entryMsg').textContent.includes('作られたか確認できません'));
});
test('確認でやめたときは登録しない。顧客名と納品先を確認に出す', async () => {
  let creates = 0, confirmation = '';
  const e = pageWorld(async body => { if (body.action === 'neworder') creates++; return { ok: true, templates: [template(1)] }; });
  e.confirm = text => { confirmation = text; return false; };
  await e.selectEntry(rid(1)); const c = formControls(e);
  c.amount.value = '100'; c.date.value = '2026-11-20'; await c.save.onclick();
  assert.equal(creates, 0); assert.ok(confirmation.includes('検証紙器') && confirmation.includes('本社'));
});

(async () => {
  let failed = 0;
  // ページ全体のJavaScriptも構文確認する（外部スクリプトは実行しない）。
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([^]*?)<\/script>/g)) new vm.Script(m[1]);
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); }
    catch (err) { failed++; console.error('FAIL ' + t.name + '\n' + err.stack); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`); process.exitCode = failed ? 1 : 0;
})();
