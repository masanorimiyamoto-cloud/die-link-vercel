// api/_fabric.js
// 「生地から品番を探す」（2026-11-18）。material-match.js の action=search が使う。
// 生地の台帳 TableFabric（1行＝1つの生地：見本写真・品番の一覧）を読み、撮影した生地と見本写真を AI で見比べ、
// 似ている生地に登録された品番を全部返す。品番は受注ではなく Book/WorkCord の組。
// AI には見本ごとに短い札（F1, F2…）だけを見せ、返ってきた札はサーバーで台帳の行に引き直す（知らない札は捨てる）。
// 表示する品番は AI の答えではなく台帳から引く。

export const FABRIC_TABLE = 'tblocXlBMzKuFmgkX';
export const FB = {
  name: 'fldEkerJJZ0AbtXVd',     // 生地名
  photo: 'fldRBtiJ1D1RTwC1G',    // 見本写真
  items: 'fldXIdwgmPQWN0TnW',    // 品番（1行に1つ Book/WorkCord）
  material: 'fldQ9VMryxCPUg8rv', // 材質（表示だけ）
  active: 'fldOUQS4jXpkwyShi',   // 有効
};
// 受注（TableJuchu）。品名と進行中かどうかを引く
export const JUCHU_TABLE = 'tbl3r511iE8MS22vm';
export const JU = {
  book: 'fldWzXx0gysM7Q8cV', wc: 'fldTAu5V3VDs4vZ2q', item: 'fldlElj2SXPdGz2zF', ndate: 'fldD27wbdv6YzNrN4',
  archived: 'fldpjeFwBm3qZqNRF', progOut: 'fldyxr30pgqJJZlHq',
};
const CLOSED_OUT = new Set(['完納済', '完納（数量訂正）', '伝票取消']);

export const PHOTOS_PER_FABRIC = 3;  // 1つの生地から AI に見せる見本写真の上限
export const IMAGES_PER_CALL = 12;   // 1回の AI 呼び出しに載せる見本写真の上限（撮影画像は別）
export const MAX_CALLS = 6;          // 並べて呼ぶ回数の上限。超える台帳は前段の絞り込みが要る
export const SHOW_MIN_SCORE = 55;    // これ未満の候補は出さない

const BOOKS = { ko: 'Ko', ta: 'Ta', yo: 'Yo' };

// 品番の欄（複数行）を読む。「Ta/1001」「Ta / 1001」「ta-1001」「Ta 1001」「Ｔａ／１００１」を受け付ける。
// 同じ品番は1回だけ。読めない行は bad に返す（画面が「読めない行」として出す）
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

// 見本写真（画像だけ）。AI に送るのは大きめのサムネイル、画面に出すのも同じ
export function photosOf(rec, max = PHOTOS_PER_FABRIC) {
  const list = (rec.fields?.[FB.photo] || []).filter(a => String(a.type || '').startsWith('image/'));
  return list.slice(0, max).map(a => ({ url: a.thumbnails?.large?.url || a.url, full: a.url }));
}

// 台帳の行 → 検索に使う生地。有効で、見本写真が1枚以上あるものだけ
export function toFabric(rec) {
  const f = rec.fields || {};
  const { items, bad } = parseItemLines(f[FB.items]);
  return { id: rec.id, name: String(f[FB.name] || '').trim() || '(名前なし)', material: String(f[FB.material] || '').trim(),
    photos: photosOf(rec), items, bad };
}

// 1回の AI 呼び出しに載せる組に分ける（見本写真が IMAGES_PER_CALL 枚を超えないように）。
// 生地の数が多くて MAX_CALLS 回に収まらないときは、各生地の写真を1枚に減らしてもう一度詰める
export function planBatches(fabrics) {
  const pack = (perFabric) => {
    const groups = []; let cur = [], n = 0;
    for (const fb of fabrics) {
      const k = Math.min(perFabric, fb.photos.length);
      if (cur.length && n + k > IMAGES_PER_CALL) { groups.push(cur); cur = []; n = 0; }
      cur.push({ ...fb, photos: fb.photos.slice(0, k) }); n += k;
    }
    if (cur.length) groups.push(cur);
    return groups;
  };
  let groups = pack(PHOTOS_PER_FABRIC);
  if (groups.length > MAX_CALLS) groups = pack(1);
  return groups.length > MAX_CALLS ? null : groups;
}

export const SEARCH_PROMPT = `あなたは製造現場の生地（材料）を見分けるアシスタントです。
最初の画像は「作業者が手元の生地をスマホで撮った写真」です。その後に、登録済みの生地の見本写真が札（F1, F2 …）付きで並びます。同じ札の写真は同じ生地です。
撮った生地と同じ生地の見本を、色・地の色味・織り/編みの目・柄・表面の質感で探してください。

前提:
- 照明・角度・距離・ホワイトバランスの違いは許し、生地そのものの違いに注目する。
- 色が近くても、柄や織りの目が違えば別の生地。
- 似ているものが複数あれば全部挙げる（どれか1つに無理に決めない）。
- 撮った写真がぼやけている・暗い・生地が小さい・生地が写っていない場合は quality にそう書く。

回答は次のJSONオブジェクト「のみ」を出力すること（前後に文章やマークダウンを付けない）:
{"matches":[{"id":"F1","score":0〜100の整数,"reason":"日本語20〜60字"}],"quality":"ok|blurry|dark|small|not_fabric","advice":"撮り直しの助言（qualityがok以外のとき。日本語40字まで）"}

- matches には同じ生地の可能性がある見本だけを入れる（score 50 以上）。無ければ空の配列。
- score は同じ生地である確からしさ。見本の札は、並んでいるものの中からだけ選ぶ。`;

// AI に送る並び（撮影画像 → 札付きの見本写真 → 指示）
export function buildParts(group, cap, imgs) {
  const parts = [{ text: '【撮影した生地】' }, { image: cap }];
  group.forEach((fb, i) => {
    fb.photos.forEach((p, j) => {
      const img = imgs.get(p.url);
      if (!img) return;
      parts.push({ text: `【見本 ${fb.label}】${fb.photos.length > 1 ? `（${j + 1}/${fb.photos.length}枚目）` : ''}` });
      parts.push({ image: img });
    });
  });
  parts.push({ text: SEARCH_PROMPT });
  return parts;
}

const QUALITY = new Set(['ok', 'blurry', 'dark', 'small', 'not_fabric']);
// 各組の AI の答えをまとめる。知らない札・数でない score は捨て、同じ生地は一番高い score を取る。
// results: [{ ok, value? , error? }]（組の順）。labels: 札 → 生地
export function mergeResults(results, labels) {
  const best = new Map();
  const qualities = []; let advice = ''; let failed = 0;
  for (const r of results) {
    if (!r.ok) { failed++; continue; }
    const v = r.value || {};
    const q = QUALITY.has(v.quality) ? v.quality : 'ok';
    qualities.push(q);
    if (q !== 'ok' && !advice && typeof v.advice === 'string') advice = v.advice.slice(0, 80);
    for (const m of Array.isArray(v.matches) ? v.matches : []) {
      const fb = labels.get(String(m?.id || '').trim().toUpperCase());
      const score = Math.round(Number(m?.score));
      if (!fb || !Number.isFinite(score)) continue;
      const s = Math.max(0, Math.min(100, score));
      const prev = best.get(fb.id);
      if (!prev || s > prev.score) best.set(fb.id, { fb, score: s, reason: String(m.reason || '').slice(0, 120) });
    }
  }
  const candidates = [...best.values()].filter(x => x.score >= SHOW_MIN_SCORE).sort((a, b) => b.score - a.score);
  // 写真の状態は「ok 以外が多数」なら写真のせいとみなす
  const bad = qualities.filter(q => q !== 'ok');
  const quality = bad.length && bad.length * 2 >= qualities.length ? bad[0] : 'ok';
  return { candidates, quality, advice, failed, answered: qualities.length };
}

// 品番の受注を引き、品名と進行中かを付ける。同じ品番の受注が何行あっても品番は1つ。
// 返り値: Map('Ta/1001' → { itemName, active, ndate })。品名は進行中のものを優先し、無ければ納期の一番新しい受注
export async function lookupItems(airtableList, items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 30) {
    const chunk = items.slice(i, i + 30);
    const formula = 'OR(' + chunk.map(x => `AND({Book}='${x.book}',{WorkCord}=${Number(x.wc)})`).join(',') + ')';
    const rows = await airtableList(JUCHU_TABLE, { filterByFormula: formula, fields: Object.values(JU) });
    for (const r of rows) {
      const f = r.fields || {};
      const key = String(f[JU.book] || '').trim() + '/' + String(f[JU.wc] ?? '').trim();
      const active = !f[JU.archived] && !CLOSED_OUT.has(f[JU.progOut]?.name || f[JU.progOut] || '');
      const ndate = f[JU.ndate] || '';
      const cur = out.get(key);
      const better = !cur || (active && !cur.active) || (active === cur.active && ndate > cur.ndate);
      if (better) out.set(key, { itemName: String(f[JU.item] || ''), active, ndate });
    }
  }
  return out;
}

// 候補の生地ごとに、品番を 進行中（納期の早い順）→ そのほか（Book・WorkCord 順）に並べる
export function itemRows(fb, info) {
  return fb.items.map(x => {
    const i = info.get(x.book + '/' + x.wc);
    return { book: x.book, wc: x.wc, itemName: i?.itemName || '', active: !!i?.active, ndate: i?.active ? i.ndate : '', known: !!i };
  }).sort((a, b) => (b.active - a.active) || (a.active ? String(a.ndate || '9').localeCompare(String(b.ndate || '9')) : 0)
    || a.book.localeCompare(b.book) || Number(a.wc) - Number(b.wc));
}
