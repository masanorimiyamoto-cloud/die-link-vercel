// api/_fabric.js
// 「生地から品番を探す」（2026-11-18 作り替え）。material-match.js の action=search / action=index が使う。
//
// 見本は受注（TableJuchu）の「画像」から自動で作る（現場に見本写真の再登録や品番の手入力を求めない）。
//  1. 索引（TableFabricIndex）: 品番ごとの画像を1行にまとめ（同じ図面が受注ごとに付き直していても1行）、AI が
//     生地が写っているか（線画・シールだけなら外す）・生地の範囲・色・柄を書く。追加・差し替え・削除は取り込みのたびに反映
//  2. 検索: 撮った生地の色・柄を AI が読み → 索引の 生地あり の行を色・柄で絞り（全部は送らない）→ 絞った見本と撮影写真を
//     AI が見比べる → 似ている見本の品番を返す。生地の台帳（TableFabric）は確かめ済みの対応・例外の補正に使う（無くてよい）
// AI には見本ごとに短い札（S1… / I1…）だけを見せ、返ってきた札は「その呼び出しで画像を渡した見本」の中でだけ引き直す。
// 表示する品番は AI の答えではなく、索引（画像の付いていた受注）と台帳から引く。添付の URL は期限があるので持たず、毎回取り直す。

/* ---------- 表と欄 ---------- */
export const FABRIC_TABLE = 'tblocXlBMzKuFmgkX'; // 生地の台帳（確かめ済みの対応・例外）
export const FB = {
  name: 'fldEkerJJZ0AbtXVd', photo: 'fldRBtiJ1D1RTwC1G', items: 'fldXIdwgmPQWN0TnW', material: 'fldQ9VMryxCPUg8rv', active: 'fldOUQS4jXpkwyShi',
};
export const IDX_TABLE = 'tblYRgQscDKXe4vC3';    // 索引（自動で作る）
export const IX = {
  key: 'fldA2G1dzDF3zV3qy', book: 'fld5ALzHDCEK2T7Cv', wc: 'fldBqPUJt0dYzVzUE', rec: 'fldgFn9Q64lVHIrea', att: 'fldr0uJkYq3AXzreR',
  file: 'fld9YeibLFpM0LWuq', state: 'fldFiQP4QBSPm4lvZ', kind: 'fldtw07nfY5A5CzvW', region: 'fld63n1EyBBNqsfwI', colors: 'fldIFJ55EPXRGMvci',
  pattern: 'fldQNDKmkTyTBlFYT', desc: 'fldgZXtq1YHiuCfe4', tries: 'fldesSUFpxYwhiee6', at: 'fldbTUcpso8A1Adx0',
};
export const JUCHU_TABLE = 'tbl3r511iE8MS22vm';
export const JU = {
  book: 'fldWzXx0gysM7Q8cV', wc: 'fldTAu5V3VDs4vZ2q', item: 'fldlElj2SXPdGz2zF', ndate: 'fldD27wbdv6YzNrN4',
  archived: 'fldpjeFwBm3qZqNRF', progOut: 'fldyxr30pgqJJZlHq', image: 'fldWtzIiml1xa609C',
};
const CLOSED_OUT = new Set(['完納済', '完納（数量訂正）', '伝票取消']);

/* ---------- 決まった言葉（絞り込みに使う） ---------- */
export const COLORS = ['赤', '朱', '橙', '黄', '金', '緑', '青', '紺', '水色', '紫', '桃', '茶', 'ベージュ', '白', '灰', '黒', '銀'];
export const PATTERNS = ['無地', '水玉・丸', '縞', '格子', '花', '和柄', '幾何', '文字', 'その他'];
// 写真の具合で入れ替わりやすい近い色（絞り込みでは半分の重みで数える）
const NEAR = { 赤: ['朱', '桃'], 朱: ['赤', '橙'], 橙: ['朱', '茶', '黄'], 黄: ['金', '橙', 'ベージュ'], 金: ['黄', 'ベージュ', '茶'], 緑: ['青'], 青: ['紺', '水色'],
  紺: ['青', '黒', '紫'], 水色: ['青', '白'], 紫: ['紺', '桃'], 桃: ['赤', '紫'], 茶: ['橙', 'ベージュ', '金'], ベージュ: ['白', '茶', '金'], 白: ['ベージュ', '灰', '銀'],
  灰: ['銀', '白', '黒'], 黒: ['紺', '灰'], 銀: ['灰', '白'] };

export const BATCH_IMAGES = 12;      // 1回の照合に載せる見本の画像の上限（撮影画像は別）
export const SEARCH_POOL = 12;       // 絞り込みの後に AI で見比べる見本の数の上限（1回分。トークン節約のため 36→12）
export const CLASSIFY_BATCH = 8;     // 索引作りの1回の AI 呼び出しに載せる画像の数
export const MAX_TRIES = 3;          // 失敗した画像をやり直す回数
export const SHOW_MIN_SCORE = 55;    // これ未満の見本は出さない
export const SAME_SCORE = 70;        // これ以上は「同じ生地」としてまとめて品番を出す。55〜69 は「似ている別の生地かも」

const BOOKS = { ko: 'Ko', ta: 'Ta', yo: 'Yo' };
const okBook = (b) => BOOKS[String(b || '').trim().toLowerCase()] || '';
const okWc = (w) => { const n = Number(w); return Number.isInteger(n) && n > 0 ? String(n) : ''; };

/* ---------- 台帳（TableFabric） ---------- */
// 品番の欄（複数行）。「Ta/1001」「Ta / 1001」「ta-1001」「Ta 1001」「Ｔａ／１００１」を受け付ける。同じ品番は1回だけ
export function parseItemLines(text) {
  const items = [], bad = [], seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.normalize('NFKC').trim();
    if (!line) continue;
    const m = /^(ko|ta|yo)\s*[\/\-_ ]?\s*(\d+)$/i.exec(line);
    if (!m) { bad.push(raw.trim()); continue; }
    const book = BOOKS[m[1].toLowerCase()], wc = String(Number(m[2]));
    const key = book + '/' + wc;
    if (seen.has(key)) continue;
    seen.add(key); items.push({ book, wc });
  }
  return { items, bad };
}
export function photosOf(rec, max = 2) {
  const list = (rec.fields?.[FB.photo] || []).filter(a => String(a.type || '').startsWith('image/'));
  return list.slice(0, max).map(a => ({ url: a.thumbnails?.large?.url || a.url }));
}
export function toFabric(rec) {
  const f = rec.fields || {};
  const { items, bad } = parseItemLines(f[FB.items]);
  return { id: rec.id, name: String(f[FB.name] || '').trim() || '(名前なし)', material: String(f[FB.material] || '').trim(), photos: photosOf(rec), items, bad };
}

/* ---------- 索引の取り込み（受注の画像 → 索引の行） ---------- */
export const imageKey = (book, wc, att) => `${book}|${wc}|${att.filename || ''}|${att.size ?? ''}`;
// 受注の行から、品番ごとの画像を集める。同じキーの画像が何件あっても1つにし、画像を取り直す元は一番新しい受注にする
export function collectImages(juchuRows) {
  const out = new Map();
  for (const r of juchuRows) {
    const f = r.fields || {};
    const book = okBook(f[JU.book]), wc = okWc(f[JU.wc]);
    if (!book || !wc) continue;
    for (const a of f[JU.image] || []) {
      if (!String(a.type || '').startsWith('image/')) continue;
      const key = imageKey(book, wc, a);
      const cur = out.get(key);
      const t = String(r.createdTime || '');
      if (!cur || t > cur.created) out.set(key, { key, book, wc, rec: r.id, att: a.id, file: a.filename || '', created: t, url: a.thumbnails?.large?.url || a.url });
    }
  }
  return out;
}
// 索引と受注の画像の差。create: 新しい画像／update: 取り直す元の受注が変わった／remove: 受注から消えた画像・重なった行
export function planSync(images, indexRows) {
  const create = [], update = [], remove = [], seen = new Set();
  for (const r of indexRows) {
    const f = r.fields || {};
    const key = f[IX.key];
    const img = images.get(key);
    if (!img || seen.has(key)) { remove.push(r.id); continue; }
    seen.add(key);
    if (f[IX.rec] !== img.rec || f[IX.att] !== img.att) update.push({ id: r.id, fields: { [IX.rec]: img.rec, [IX.att]: img.att } });
  }
  for (const img of images.values()) if (!seen.has(img.key)) create.push(img);
  return { create, update, remove };
}
export const newIndexFields = (img) => ({ [IX.key]: img.key, [IX.book]: img.book, [IX.wc]: Number(img.wc), [IX.rec]: img.rec, [IX.att]: img.att,
  [IX.file]: img.file, [IX.state]: '未判定', [IX.tries]: 0 });
// AI に見せる順番待ち（未判定 → 失敗のやり直し）
export const pendingRows = (rows) => rows.filter(r => { const f = r.fields || {}; const s = f[IX.state]?.name || f[IX.state];
  return s === '未判定' || !s || (s === '失敗' && Number(f[IX.tries] || 0) < MAX_TRIES); });
export function indexStatus(rows) {
  const st = { total: rows.length, ready: 0, fabric: 0, pending: 0, failed: 0 };
  for (const r of rows) {
    const f = r.fields || {}; const s = f[IX.state]?.name || f[IX.state];
    if (s === '済') { st.ready++; if ((f[IX.kind]?.name || f[IX.kind]) === '生地あり') st.fabric++; }
    else if (s === '失敗' && Number(f[IX.tries] || 0) >= MAX_TRIES) st.failed++;
    else st.pending++;
  }
  return st;
}

export const CLASSIFY_PROMPT = `あなたは製造現場の図面・写真の仕分けアシスタントです。札（I1, I2 …）付きの画像が並びます。
画像ごとに、その中に「生地（布・紙などの材料の表面）」の色や柄が分かる写真が写っているかを判定してください。
- 現物の写真、または図面の一部に生地の写真・見本が貼ってある → kind は "fabric"。region にその部分の範囲を書く（画像全体が生地なら [0,0,1,1]）
- 抜型の線・寸法線・文字だけの図面 → "drawing"。シール・ラベルの版下だけ → "seal"。そのほか → "other"
- 抜型の形・寸法・余白・ラベルは生地ではない。色の付いた線や塗りつぶしの図形だけなら "drawing"
- colors は生地の色を多い順に最大3つ、次の中から選ぶ: ${COLORS.join('、')}
- pattern は次の中から1つ: ${PATTERNS.join('、')}

回答は次のJSONオブジェクト「のみ」（前後に文章やマークダウンを付けない）:
{"images":[{"id":"I1","kind":"fabric|drawing|seal|other","region":[x0,y0,x1,y1],"colors":["赤"],"pattern":"無地","desc":"日本語30字まで"}]}
region は 0〜1（左上が 0,0）。fabric 以外は region・colors・pattern を空にしてよい。並んでいる札は全部答える。`;

export function buildClassifyParts(batch, imgs) {
  const parts = [], labels = new Map();
  batch.forEach((row, i) => {
    const img = imgs.get(row.id);
    if (!img) return;
    const label = 'I' + (i + 1);
    labels.set(label, row);
    parts.push({ text: `【${label}】` }, { image: img });
  });
  parts.push({ text: CLASSIFY_PROMPT });
  return { parts, labels };
}
const KIND = { fabric: '生地あり', drawing: '線画', seal: 'シール', other: 'その他' };
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x)));
export function normRegion(r) {
  if (!Array.isArray(r) || r.length !== 4 || r.some(x => !Number.isFinite(Number(x)))) return '';
  let [x0, y0, x1, y1] = r.map(clamp01);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 - x0 < 0.03 || y1 - y0 < 0.03) return '';
  return [x0, y0, x1, y1].map(v => Math.round(v * 100) / 100).join(',');
}
export const normColors = (c) => [...new Set((Array.isArray(c) ? c : String(c || '').split(/[、,\s]+/)).map(s => String(s).trim()).filter(s => COLORS.includes(s)))].slice(0, 3);
export const normPattern = (p) => PATTERNS.includes(String(p || '').trim()) ? String(p).trim() : '';
// AI の答え → 行ごとの書き込み。答えの無い札は書かない（呼んだ側が失敗にする）。知らない札は捨てる
export function parseClassify(value, labels) {
  const out = new Map();
  for (const x of Array.isArray(value?.images) ? value.images : []) {
    const row = labels.get(String(x?.id || '').trim().toUpperCase());
    if (!row || out.has(row.id)) continue;
    const kind = KIND[x.kind] || 'その他';
    const fab = kind === '生地あり';
    out.set(row.id, { [IX.state]: '済', [IX.kind]: kind, [IX.region]: fab ? (normRegion(x.region) || '0,0,1,1') : '',
      [IX.colors]: fab ? normColors(x.colors).join('、') : '', [IX.pattern]: fab ? normPattern(x.pattern) : '', [IX.desc]: String(x.desc || '').slice(0, 60) });
  }
  return out;
}

/* ---------- 検索 ---------- */
export const DESCRIBE_PROMPT = `作業者が手元の生地をスマホで撮った写真です。生地の色と柄を読んでください。
- colors は生地の色を多い順に最大3つ、次の中から: ${COLORS.join('、')}
- pattern は次の中から1つ: ${PATTERNS.join('、')}
- 写真がぼやけている・暗い・生地が小さい・生地が写っていない場合は quality にそう書き、advice に撮り直し方を書く
回答は次のJSONオブジェクト「のみ」: {"colors":["赤"],"pattern":"無地","quality":"ok|blurry|dark|small|not_fabric","advice":"日本語40字まで","desc":"日本語30字まで"}`;
const QUALITY = new Set(['ok', 'blurry', 'dark', 'small', 'not_fabric']);
export function parseDescribe(v) {
  return { colors: normColors(v?.colors), pattern: normPattern(v?.pattern), quality: QUALITY.has(v?.quality) ? v.quality : 'ok',
    advice: String(v?.advice || '').slice(0, 80), desc: String(v?.desc || '').slice(0, 60) };
}
// 索引の行を撮影写真の色・柄に近い順に並べ、上から pool 件を見比べる。並びは読み込み順に左右されない（同点はキー順）
export function prefilter(samples, feat, pool = SEARCH_POOL) {
  const w = [3, 2, 1];
  const score = (s) => {
    let v = 0;
    feat.colors.forEach((c, i) => {
      const j = s.colors.indexOf(c);
      if (j >= 0) v += w[i] * (j === 0 ? 1.5 : 1);
      else if ((NEAR[c] || []).some(n => s.colors.includes(n))) v += w[i] * 0.5;
    });
    if (feat.pattern && s.pattern === feat.pattern) v += 3;
    return v;
  };
  return samples.map(s => ({ s, v: score(s) })).sort((a, b) => (b.v - a.v) || String(a.s.sid).localeCompare(String(b.s.sid))).slice(0, pool).map(x => x.s);
}
// 索引の行 → 見本。品番は画像の付いていた受注の Book/WorkCord
export function indexSample(r) {
  const f = r.fields || {};
  return { sid: r.id, from: 'image', rec: f[IX.rec], att: f[IX.att], items: [{ book: okBook(f[IX.book]), wc: okWc(f[IX.wc]) }].filter(x => x.book && x.wc),
    region: String(f[IX.region] || ''), colors: normColors(f[IX.colors]), pattern: normPattern(f[IX.pattern]), name: String(f[IX.file] || ''), photos: [] };
}
// 台帳の行 → 見本（写真があるときだけ。色・柄は分からないので絞り込みでは必ず残す）
export const fabricSample = (fb) => ({ sid: fb.id, from: 'ledger', items: fb.items, name: fb.name, material: fb.material, region: '', colors: [], pattern: '', photos: fb.photos });

// 1回の照合に載せる組に分ける（見本の画像が BATCH_IMAGES 枚を超えないように）
export function planBatches(samples) {
  const groups = []; let cur = [], n = 0;
  for (const s of samples) {
    const k = Math.max(1, s.photos.length);
    if (cur.length && n + k > BATCH_IMAGES) { groups.push(cur); cur = []; n = 0; }
    cur.push(s); n += k;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export const SEARCH_PROMPT = `あなたは製造現場の生地（材料）を見分けるアシスタントです。
最初の画像は「作業者が手元の生地をスマホで撮った写真」です。その後に、登録済みの見本が札（S1, S2 …）付きで並びます。見本は図面の画像のこともあります。
札に「生地の範囲」が書いてあれば、その範囲に写っている生地だけを見てください。抜型の形・寸法線・余白・文字・ラベルは比べない。
撮った生地と同じ生地の見本を、色・地の色味・織り/編みの目・柄・表面の質感で探してください。
- 照明・角度・距離・ホワイトバランスの違いは許し、生地そのものの違いに注目する。色が近くても柄や織りの目が違えば別の生地
- 似ているものが複数あれば全部挙げる（どれか1つに無理に決めない）
回答は次のJSONオブジェクト「のみ」: {"matches":[{"id":"S1","score":0〜100の整数,"reason":"日本語20〜60字"}]}
matches には同じ生地の可能性がある見本だけ（score 50 以上）。無ければ空の配列。札は並んでいるものの中からだけ選ぶ。`;

const regionText = (r) => {
  const p = String(r || '').split(',').map(Number);
  if (p.length !== 4 || p.some(x => !Number.isFinite(x)) || (p[0] <= 0.01 && p[1] <= 0.01 && p[2] >= 0.99 && p[3] >= 0.99)) return '';
  return `（生地の範囲: 横 ${Math.round(p[0] * 100)}〜${Math.round(p[2] * 100)}%・縦 ${Math.round(p[1] * 100)}〜${Math.round(p[3] * 100)}%）`;
};
// AI に送る並び。画像を読めた見本だけに札を振り、その札の表（labels）を返す（答えはこの表でだけ引き直す）
export function buildSearchParts(group, cap, imgs) {
  const parts = [{ text: '【撮影した生地】' }, { image: cap }], labels = new Map();
  let n = 0;
  for (const s of group) {
    const pics = s.photos.map(p => imgs.get(p.url)).filter(Boolean);
    if (!pics.length) continue;
    const label = 'S' + (++n);
    labels.set(label, s);
    pics.forEach((img, j) => parts.push({ text: `【見本 ${label}】${regionText(s.region)}${pics.length > 1 ? `（${j + 1}/${pics.length}枚目）` : ''}` }, { image: img }));
  }
  parts.push({ text: SEARCH_PROMPT });
  return { parts, labels };
}
// 各回の AI の答えをまとめる。札はその回の labels の中でだけ引き直し、数でない score は捨て、同じ見本は高い方を取る
// results: [{ ok, value?, labels }]
export function mergeResults(results) {
  const best = new Map(); let failed = 0, answered = 0;
  for (const r of results) {
    if (!r.ok) { failed++; continue; }
    answered++;
    for (const m of Array.isArray(r.value?.matches) ? r.value.matches : []) {
      const s = r.labels.get(String(m?.id || '').trim().toUpperCase());
      const score = Math.round(Number(m?.score));
      if (!s || !Number.isFinite(score)) continue;
      const v = Math.max(0, Math.min(100, score));
      const prev = best.get(s.sid);
      if (!prev || v > prev.score) best.set(s.sid, { s, score: v, reason: String(m.reason || '').slice(0, 120) });
    }
  }
  const matched = [...best.values()].filter(x => x.score >= SHOW_MIN_SCORE).sort((a, b) => b.score - a.score);
  return { matched, failed, answered };
}

// 品番の受注を引き、品名と進行中かを付ける。同じ品番の受注が何行あっても品番は1つ。
// 返り値: Map('Ta/1001' → { itemName, active, ndate })。品名は進行中のものを優先し、無ければ納期の一番新しい受注
export async function lookupItems(airtableList, items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 30) {
    const chunk = items.slice(i, i + 30);
    const formula = 'OR(' + chunk.map(x => `AND({Book}='${x.book}',{WorkCord}=${Number(x.wc)})`).join(',') + ')';
    const rows = await airtableList(JUCHU_TABLE, { filterByFormula: formula, fields: [JU.book, JU.wc, JU.item, JU.ndate, JU.archived, JU.progOut] });
    for (const r of rows) {
      const f = r.fields || {};
      const key = String(f[JU.book] || '').trim() + '/' + String(f[JU.wc] ?? '').trim();
      const active = !f[JU.archived] && !CLOSED_OUT.has(f[JU.progOut]?.name || f[JU.progOut] || '');
      const ndate = f[JU.ndate] || '';
      const cur = out.get(key);
      if (!cur || (active && !cur.active) || (active === cur.active && ndate > cur.ndate)) out.set(key, { itemName: String(f[JU.item] || ''), active, ndate });
    }
  }
  return out;
}

// 品番の一覧を作る。同じ生地（SAME_SCORE 以上）の見本の品番に、台帳でつながった品番を足し、品番ごとに1行（根拠は一番高い見本）。
// 似ている別の生地（55〜69）は見本ごとに分けて返す（見本の写真で見分けてもらう）。件数で切らない
export function buildAnswer(matched, ledger) {
  const same = matched.filter(m => m.score >= SAME_SCORE);
  const items = new Map();
  const add = (it, ev) => {
    if (!it.book || !it.wc) return;
    const k = it.book + '/' + it.wc, cur = items.get(k);
    if (!cur || ev.score > cur.ev.score) items.set(k, { book: it.book, wc: it.wc, ev });
  };
  for (const m of same) for (const it of m.s.items) add(it, { sid: m.s.sid, score: m.score, reason: m.reason, via: m.s.from });
  // 台帳: 同じ生地の品番を1つでも含む行は、その行の品番を全部足す（写真の無い品番もここから出る）
  const hit = new Set(items.keys());
  for (const fb of ledger) {
    if (!fb.items.some(it => hit.has(it.book + '/' + it.wc))) continue;
    const top = Math.max(...fb.items.map(it => items.get(it.book + '/' + it.wc)?.ev.score || 0));
    for (const it of fb.items) add(it, { sid: fb.id, score: top, reason: `生地の台帳「${fb.name}」で同じ生地`, via: 'ledger' });
  }
  const similar = matched.filter(m => m.score < SAME_SCORE).map(m => ({ sid: m.s.sid, score: m.score, reason: m.reason, items: m.s.items }));
  return { items: [...items.values()], similar };
}

// 品番を 進行中（納期の早い順）→ そのほか（Book・WorkCord 順）に並べ、品名を付ける
export function itemRows(list, info) {
  return list.map(x => {
    const i = info.get(x.book + '/' + x.wc);
    return { ...x, itemName: i?.itemName || '', active: !!i?.active, ndate: i?.active ? i.ndate : '', known: !!i };
  }).sort((a, b) => (b.active - a.active) || (a.active ? String(a.ndate || '9').localeCompare(String(b.ndate || '9')) : 0)
    || a.book.localeCompare(b.book) || Number(a.wc) - Number(b.wc));
}
