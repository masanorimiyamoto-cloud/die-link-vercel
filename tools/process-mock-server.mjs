// tools/process-mock-server.mjs
// public/process.html を本番の API・Airtable に一切触れずに画面で確かめるための、全面モックのローカルサーバー（2026-11-03）。
// ・/api/session（ログイン）と /api/airtable-update-progress のすべての action をここで返す
// ・モックしていない /api/* は 500 で失敗させる（本番へは流さない）。受注はすべて架空のデータ
// ・/__mock に POST すると、次の一覧の読み込みを失敗させる（failView）・遅らせる（delayView。内容は要求を受けた時点のもの）、
//   次の書き込みを拒否する（rejectWrite）・結果不明にする（unknownWrite: 保存せずに壊れた応答 / lostWrite: 保存したのに応答だけ壊れる）などを指定できる。GET /__mock/log で受けた書き込みを返す
// 実行: node tools/process-mock-server.mjs [port]   → http://127.0.0.1:8787/process.html
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicViews, publicSteps, STEPS } from '../api/_process.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.argv[2] || 8787);
const USER = '検証 太郎';
const ROOMS = [
  { name: 'オートン', color: 'blueLight2', tag: 'オートン' }, { name: '機械貼', color: 'greenLight2', tag: '機械貼' },
  { name: 'Nao', color: 'purpleLight2', tag: 'Nao' }, { name: '手貼(花 神)', color: 'pinkLight2', tag: '花' },
  { name: '2F_小', color: 'orangeLight2', tag: '2F_小' }, { name: 'たおしK判', color: 'cyanLight2', tag: 'たおしK判' },
  { name: 'たおしM判', color: 'tealLight2', tag: 'たおしM判' }, { name: 'CAD', color: 'grayLight2', tag: 'CAD' },
];

// 架空の受注。views: どの作業リストに出すか（all は自動で全件）
let seq = 0;
const rid = () => 'recMOCK' + String(++seq).padStart(10, '0');
function order(p) {
  return { id: rid(), book: 'Ko', wc: 9000 + seq, item: '検証用の箱', amount: 1000, ndate: '2026-11-06', progIn: '', progOut: '', group: '',
    kotei: '', memo: '', paper: '', die: [], room: [], printedAt: '', amountFrom: '', amountLog: '', ndateFrom: '', ndateLog: '',
    amountLocked: false, images: [], closed: false, addPending: false, approved: true, done: {}, views: [], ...p };
}
const LONG_MEMO = '検証用の長い連絡事項です。改行を含みます。\n2行目: 先方から色の指定あり（架空）。\n3行目: 仕上がり後は事務所へ連絡。とても長い文章が続く場合でも全文が読めることを確かめるための文章です。';
function fixtures() {
  seq = 0;
  return [
    // 機械貼: 前工程（オートン）が済んで着手可。数量の変更が一番新しい記録
    order({ item: '検証箱A 機械貼テスト #o#ki', kotei: '|オートン|機械貼|', progIn: 'オートン抜き完了', amount: 1200,
      amountFrom: '1000', amountLog: '1000→1200 田中 2026-11-03 14:32', printedAt: '2026-11-01 09:00',
      done: { o: '佐藤 2026-11-02 10:15' }, memo: LONG_MEMO, die: ['型修正あり'], room: ['Nao'], views: ['kikai', 'recent'] }),
    // 機械貼: 材料待ち（予定日経過）
    order({ item: '検証箱B 材料待ち #ki', kotei: '|機械貼|', progOut: 'シート手配済み', paper: '2026-11-01', ndate: '2026-11-04',
      printedAt: '2026-11-02 08:30', views: ['kikai'] }),
    // 機械貼: 済（記録あり）。工程と納期変更が同時刻
    order({ item: '検証箱C 済 #ki#nao', kotei: '|機械貼|Nao|', progIn: '機械貼完了', done: { kikai: '鈴木 2026-11-03 11:00' },
      ndate: '2026-11-10', ndateFrom: '2026-11-08', ndateLog: '2026-11-08→2026-11-10 鈴木 2026-11-03 11:00', views: ['kikai', 'nao'] }),
    // 機械貼: 閉じた受注（伝票取消）
    order({ item: '検証箱D 取消 #ki', kotei: '|機械貼|', progOut: '伝票取消', closed: true, amountLocked: true, views: ['kikai'] }),
    // 機械貼: 記録なし・不正な日時・ログと今の値の不一致（強調しない）
    order({ item: '検証箱E 不正日時 #ki', kotei: '|機械貼|', amount: 500, amountLog: '400→450 田中 2026-11-03 09:00',
      ndateLog: '2026-11-07→2026-11-09 田中 2026-13-40 25:99', ndate: '2026-11-09', printedAt: '2026-11-03', views: ['kikai'] }),
    // たおし: K判だけ / M判だけ / 両方 / どちらも無し
    order({ item: '検証たおしK #tk', kotei: '|たおしK判|', views: ['taoshi'], progOut: '在庫シート利用' }),
    order({ item: '検証たおしM #tm', kotei: '|たおしM判|', views: ['taoshi'] }),
    order({ item: '検証たおし両方 #tk#tm', kotei: '|たおしK判|たおしM判|', views: ['taoshi'] }),
    order({ item: '検証たおし無し', kotei: '', views: ['taoshi'] }),
    // お守箔焼印: 未記録
    order({ item: '検証お守り #o', kotei: '|オートン|', views: ['omamori'], printedAt: '2026-11-02 13:00' }),
    // Nao・2F 小: シール貼だけ済
    order({ item: '検証Nao #o#nao#ki', kotei: '|オートン|機械貼|Nao|', progIn: 'シール貼完了', done: { o: '佐藤 2026-11-01 10:00', seal: '高橋 2026-11-02 16:20' }, views: ['nao', 'f2'] }),
    order({ item: '検証2F #ko', kotei: '|2F_小|', views: ['f2', 'nao'] }),
    // オートン抜き: 抜き半製品あり（済とみなす）・旧手貼り名・最終グループ
    order({ item: '検証半製品 #o', kotei: '|オートン|', progIn: '抜き半製品あり', views: ['auton'] }),
    order({ item: '検証手貼り旧名 #h', kotei: '|花|', progIn: '(花)貼り完了', views: ['tebari'] }),
    order({ item: '検証最終 #o', kotei: '|オートン|', progIn: '仕上がりました', group: '最終', views: ['auton'] }),
    // 未対応タグ（福祉）を含む・品名にないタグ
    order({ item: '検証未対応 #o', kotei: '|オートン|福祉|', views: ['auton'], done: {}, progOut: 'シート材料入荷済' }),
    // 新規受注・削除できるもの
    order({ item: '検証新規 #ki', kotei: '|機械貼|', addPending: true, approved: false, progIn: '工程表発行済', views: ['fax', 'kikai'] }),
  ];
}
let DB = fixtures();
let LEDGER = []; // 削除台帳（新しい順）
const ctl = { failView: 0, delayView: 0, unknownWrite: 0, lostWrite: 0, rejectWrite: 0, delayWrite: 0, log: [] };

const pub = (o) => { const { views, ...rest } = o; return JSON.parse(JSON.stringify(rest)); };
const nowStamp = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };

async function handle(body) {
  const a = body.action;
  const views = publicViews(), steps = publicSteps();
  const find = () => DB.find(o => o.id === body.id);
  if (['complete', 'cancel', 'amount', 'ndate', 'paper', 'room', 'stock', 'neworder', 'delete', 'approve'].includes(a)) {
    ctl.log.push({ action: a, id: body.id, step: body.step, variant: body.variant, force: body.force });
    if (ctl.delayWrite) await new Promise(r => setTimeout(r, ctl.delayWrite));
    if (ctl.unknownWrite) { ctl.unknownWrite--; return { raw: '<html>502 Bad Gateway</html>', status: 502 }; }
    if (ctl.rejectWrite) { ctl.rejectWrite--; return { status: 400, body: { ok: false, error: 'TEST_SERVER_REJECTION' } }; }
  }
  if (a === 'view') {
    const fail = ctl.failView > 0; if (fail) ctl.failView--;
    const key = body.view || 'cad';
    const rows = DB.filter(o => key === 'all' || o.views.includes(key)).map(pub).map(o => ({ ...o, images: [] }));
    if (ctl.delayView) await new Promise(r => setTimeout(r, ctl.delayView)); // 待たせても内容は要求を受けた時点のもの
    if (fail) return { status: 502, body: { ok: false, error: 'mock 502' } };
    return { body: { ok: true, view: key, views, steps, rooms: ROOMS, rows, cachedAt: Date.now() } };
  }
  if (a === 'viewImages') {
    const key = body.view;
    const images = {};
    for (const o of DB.filter(o => key === 'all' || o.views.includes(key))) if (o.item.includes('A ')) images[o.id] = [{ thumb: '/__mock/img.svg', full: '/__mock/img.svg', name: 'mock.svg', isImage: true }];
    return { body: { ok: true, view: key, images } };
  }
  if (a === 'orders') {
    const list = DB.filter(o => o.book === body.book && String(o.wc) === String(body.wc)).map(pub);
    return { body: { ok: true, orders: list, steps, rooms: ROOMS } };
  }
  if (a === 'items') {
    const keys = [body.k1, body.k2].filter(Boolean).map(k => k.toLowerCase());
    const list = DB.filter(o => keys.every(k => o.item.toLowerCase().includes(k))).map(pub);
    return { body: { ok: true, orders: list, more: false, steps, rooms: ROOMS } };
  }
  if (a === 'deletions') return { body: { ok: true, rows: LEDGER.slice(0, 30) } };
  if (a === 'delete') {
    if (!/^del-[A-Za-z0-9-]{8,64}$/.test(String(body.reqId || ''))) return { status: 400, body: { ok: false, error: '画面が古いので、読み込み直してからもう一度削除してください' } };
    const led = LEDGER.find(x => x.reqId === body.reqId);
    if (led) return { body: { ok: true, id: body.id, ledger: led.state, pre: true, again: true } };
  }
  const o = find();
  if (!o) return { status: 404, body: { ok: false, error: '受注が見つかりません' } };
  if (a === 'complete') {
    const s = STEPS[body.step]; if (!s) return { status: 400, body: { ok: false, error: '工程の指定が正しくありません' } };
    if (o.done[body.step] && !body.force) return { status: 409, body: { ok: false, conflict: true, error: `この工程は「${o.done[body.step]}」で記録済みです` } };
    const stamp = `${USER} ${nowStamp()}`;
    o.done[body.step] = stamp; o.progIn = s.variants[0].value; if (body.step === 'finish') o.group = '最終';
    // 機械貼が済んだら機械貼のリストから外す（ビューから消える場合の確認用）
    if (body.step === 'kikai' && o.item.includes('#ki#nao')) o.views = o.views.filter(v => v !== 'kikai');
    return { body: { ok: true, id: o.id, value: o.progIn, stamp, prev: '', prevRecord: '' } };
  }
  if (a === 'cancel') { delete o.done[body.step]; o.progIn = ''; return { body: { ok: true, progIn: '' } }; }
  if (a === 'amount') { const line = `${o.amount}→${body.amount} ${USER} ${nowStamp()}`; o.amountFrom ||= String(o.amount); o.amount = Number(body.amount); o.amountLog = line; return { body: { ok: true, amount: o.amount, line } }; }
  if (a === 'ndate') { const line = `${o.ndate || '空白'}→${body.ndate} ${USER} ${nowStamp()}`; o.ndateFrom ||= o.ndate || '空白'; o.ndate = body.ndate; o.ndateLog = line; return { body: { ok: true, ndate: o.ndate, line } }; }
  if (a === 'paper') { o.paper = body.paper; return { body: { ok: true, paper: o.paper } }; }
  if (a === 'room') { o.room = body.on ? [...new Set([...o.room, body.room])] : o.room.filter(r => r !== body.room); return { body: { ok: true, room: o.room } }; }
  if (a === 'stock') { o.progOut = body.on ? body.out : 'シート手配済み'; return { body: { ok: true, progOut: o.progOut } }; }
  if (a === 'neworder') {
    if (!body.force && DB.some(x => x.item === o.item && x.ndate === body.ndate && String(x.amount) === String(body.amount))) return { status: 409, body: { ok: false, dup: true, error: '同じ納期・数量の受注が既にあります' } };
    const no = order({ ...pub(o), id: rid(), amount: Number(body.amount), ndate: body.ndate, memo: body.memo, done: {}, progIn: '', addPending: true, approved: true, views: o.views });
    DB.push(no); return { body: { ok: true, order: pub(no) } };
  }
  if (a === 'approve') { const was = o.approved; o.approved = true; return { body: { ok: true, approved: true, ...(was ? { unchanged: true } : {}) } }; }
  if (a === 'delete') {
    LEDGER.unshift({ reqId: body.reqId, recordId: o.id, state: 'Airtable削除済', pre: true, book: o.book, wc: String(o.wc), item: o.item, amount: o.amount, ndate: o.ndate, by: 'テスト 太郎', at: new Date().toISOString(), excelAt: '', memo: '', reason: body.reason || '' });
    DB = DB.filter(x => x.id !== o.id);
    return { body: { ok: true, id: o.id, ledger: 'Airtable削除済', pre: true, ledgerWarn: false } };
  }
  return { status: 400, body: { ok: false, error: 'unknown action (mock)' } };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let raw = ''; for await (const c of req) raw += c;
  if (u.pathname === '/api/session') {
    if (u.searchParams.get('action') === 'me') return send(res, 200, { ok: true, user: { name: USER, id: 'mock' } });
    return send(res, 200, { ok: true }, { 'set-cookie': 'xcsrf=MOCK; Path=/' });
  }
  if (u.pathname === '/api/airtable-update-progress' && req.method === 'POST') {
    const b = JSON.parse(raw || '{}');
    const r = await handle(b);
    // 保存はしたが応答だけ壊れる（「実際は保存済み」からの確認の流れ用）
    if (ctl.lostWrite && r.body?.ok && ['complete', 'cancel', 'amount', 'ndate', 'paper', 'room', 'stock', 'delete', 'approve'].includes(b.action)) { ctl.lostWrite--; res.writeHead(502, { 'content-type': 'text/html' }); return res.end('<html>502</html>'); }
    if (r.raw) { res.writeHead(r.status, { 'content-type': 'text/html' }); return res.end(r.raw); }
    return send(res, r.status || 200, r.body);
  }
  if (u.pathname.startsWith('/api/')) { console.error('UNMOCKED', req.method, u.pathname); return send(res, 500, { ok: false, error: 'unmocked API (mock server)' }); }
  if (u.pathname === '/__mock' && req.method === 'POST') { const b = JSON.parse(raw || '{}'); if (b.reset) { DB = fixtures(); LEDGER = []; ctl.log = []; } Object.assign(ctl, b.ctl || {}); return send(res, 200, { ok: true, ctl }); }
  if (u.pathname === '/__mock/log') return send(res, 200, ctl.log);
  if (u.pathname === '/__mock/img.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140"><rect width="200" height="140" fill="#e2e8f0"/><text x="20" y="80" font-size="22">MOCK IMAGE</text></svg>'); }
  const file = path.join(ROOT, path.normalize(u.pathname).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`mock: http://127.0.0.1:${PORT}/process.html`));
