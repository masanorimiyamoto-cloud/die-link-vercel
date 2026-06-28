// public/js/die-overlay-match.js
// ============================================================================
// 抜型照合 新方式（ハイブリッド：クライアントCV主＋AI補助）の「メイン側コントローラ」。
//
// 重いCV計算は Web Worker(die-overlay-worker.js) に丸投げし、メインスレッド（UI）は
// 絶対に固めない。さらにハードタイムアウトで worker.terminate() するので、OpenCV.js の
// 取得が詰まっても・計算が重すぎても、UIが固まらず確実に中断できる。
//
// このモジュールの責務:
//   1) 画像を「読み込む前に必ず小さく縮小」してから ImageData 化（高解像度図面でのメモリ枯渇を根絶）
//   2) Worker へ転送（ArrayBuffer transferable）して計算依頼＋タイムアウト管理
//   3) Worker が返した輪郭点列から、現物写真の上に重ね合わせ画像を canvas 描画
//
// 公開API:
//   ensureOpenCv()    … Worker を起こして OpenCV.js を先読み（初回の数十秒を「準備中」表示に使える）
//   matchDieOverlay() … 照合本体。{ ok, matchPct, maxDevMm, avgDevMm, maxDevPct, avgDevPct,
//                        verdict, overlayCanvas, reason }
// ============================================================================

const WORKER_URL = '/js/die-overlay-worker.js';
const DEFAULT_MAX_SIDE = 800;     // 処理解像度の上限（小さいほど速い・軽い）
const WARM_TIMEOUT_MS = 150000;   // 初回 OpenCV 取得の上限（worker内DL＋WASM初期化。低速端末向けに余裕）
const MATCH_TIMEOUT_MS = 20000;   // 1回の照合計算の上限

let _worker = null;
function getWorker() {
  if (!_worker) _worker = new Worker(WORKER_URL);
  return _worker;
}
function killWorker() { if (_worker) { try { _worker.terminate(); } catch (e) {} _worker = null; } }

/** Worker に1往復のメッセージを投げ、タイムアウト付きで結果を待つ。
 *  タイムアウト/例外時は worker を破棄（次回作り直し）して reject する。 */
function runInWorker(msg, transfer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return; settled = true;
      clearTimeout(to);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      fn(arg);
    };
    const to = setTimeout(() => { killWorker(); finish(reject, new Error('CV処理がタイムアウトしました（重すぎ／通信不良）')); }, timeoutMs);
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.ok) finish(resolve, d.result);
      else finish(reject, new Error(d.error || 'CV worker error'));
    };
    const onErr = (e) => { killWorker(); finish(reject, new Error('CV worker 例外: ' + ((e && e.message) || ''))); };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage(msg, transfer || []);
  });
}

/** Worker を起こして OpenCV.js を先読みする（初回のみ重い）。 */
export function ensureOpenCv() {
  return runInWorker({ type: 'warm' }, [], WARM_TIMEOUT_MS);
}

/* ---------- 画像前処理（必ず縮小してから ImageData 化：メモリ枯渇を根絶）---------- */

function srcDims(src) {
  return {
    w: src.naturalWidth || src.videoWidth || src.width || 0,
    h: src.naturalHeight || src.videoHeight || src.height || 0,
  };
}

/** 現物写真を（任意で bbox 切り出し→）maxSide に縮小した canvas にし、ImageData を返す。
 *  戻り値の k(縮小率), sx,sy(全体写真px内の切り出しオフセット) は重ね描画の座標復元に使う。 */
function preparePhoto(photo, productBox, maxSide) {
  const { w, h } = srcDims(photo);
  let sx = 0, sy = 0, sw = w, sh = h;
  if (productBox) {
    sx = Math.max(0, Math.round(productBox.x * w));
    sy = Math.max(0, Math.round(productBox.y * h));
    sw = Math.min(w - sx, Math.round(productBox.w * w));
    sh = Math.min(h - sy, Math.round(productBox.h * h));
  }
  if (sw < 2 || sh < 2) { sx = 0; sy = 0; sw = w; sh = h; }
  const k = Math.min(1, maxSide / Math.max(sw, sh || 1));
  const pw = Math.max(1, Math.round(sw * k)), ph = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas'); c.width = pw; c.height = ph;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(photo, sx, sy, sw, sh, 0, 0, pw, ph);
  const img = g.getImageData(0, 0, pw, ph);
  return { transfer: { width: pw, height: ph, buffer: img.data.buffer }, k, sx, sy };
}

/** 図面を maxSide に縮小した canvas にし、ImageData を返す（位置合わせでスケールは正規化されるので絶対寸法は不問）。 */
function prepareDrawing(drawing, maxSide) {
  const { w, h } = srcDims(drawing);
  const k = Math.min(1, maxSide / Math.max(w, h || 1));
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas'); c.width = dw; c.height = dh;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(drawing, 0, 0, dw, dh);
  const img = g.getImageData(0, 0, dw, dh);
  return { width: dw, height: dh, buffer: img.data.buffer };
}

/* ---------- メイン: 照合 ---------- */
/**
 * @param {Object} o
 * @param {CanvasImageSource} o.photo      現物の静止画（Image/Canvas）
 * @param {CanvasImageSource} o.drawing    登録図面(-zu)（Image/Canvas）
 * @param {number} o.pxPerMm               CAL-50校正の px/mm（撮影画像の元解像度基準。0ならmmなし）
 * @param {{x,y,w,h}} [o.productBox]       現物bboxの正規化座標(0..1)。背景除去に使う
 * @param {number} [o.tolMm=10]            合否許容差(±mm)
 * @param {number} [o.maxSide=800]         処理解像度の上限
 * @param {number} [o.timeoutMs=20000]     計算のハードタイムアウト
 */
export async function matchDieOverlay(o) {
  const maxSide = o.maxSide || DEFAULT_MAX_SIDE;
  const tolMm = o.tolMm ?? 10;

  let pPrep, dPrep;
  try {
    pPrep = preparePhoto(o.photo, o.productBox, maxSide);
    dPrep = prepareDrawing(o.drawing, maxSide);
  } catch (e) {
    return failResult('画像の前処理に失敗しました: ' + ((e && e.message) || e));
  }

  // CAL-50 の px/mm を「処理解像度」に換算（縮小率 k を掛ける）
  const pxPerMmProc = (o.pxPerMm > 0) ? o.pxPerMm * pPrep.k : 0;

  let res;
  try {
    res = await runInWorker(
      { type: 'match', photo: pPrep.transfer, drawing: dPrep, pxPerMmProc, tolMm },
      [pPrep.transfer.buffer, dPrep.buffer],
      o.timeoutMs || MATCH_TIMEOUT_MS,
    );
  } catch (e) {
    return failResult((e && e.message) || String(e));
  }
  if (!res || res.ok === false) return failResult((res && res.reason) || '照合に失敗しました');

  // 重ね合わせ画像（処理座標 → 全体写真座標へ復元して描画）
  let overlayCanvas = null;
  try {
    overlayCanvas = renderOverlay(o.photo, pPrep.sx, pPrep.sy, pPrep.k, res.movedPts, res.overTolPts);
  } catch (e) { /* 画像描画失敗は数値だけ返す */ }

  return {
    ok: true,
    matchPct: res.matchPct,
    maxDevMm: res.maxDevMm,
    avgDevMm: res.avgDevMm,
    maxDevPct: res.maxDevPct,
    avgDevPct: res.avgDevPct,
    verdict: res.verdict,
    reason: res.reason,
    overlayCanvas,
  };
}

function failResult(reason) {
  return { ok: false, matchPct: null, maxDevMm: null, avgDevMm: null, maxDevPct: null, avgDevPct: null, verdict: 'uncertain', overlayCanvas: null, reason };
}

/* ---------- 重ね合わせ描画（メインスレッド） ---------- */
/** 処理座標 p を 全体写真座標へ: full = offset + p / k */
function renderOverlay(photo, sx, sy, k, movedPts, overTolPts) {
  const { w: baseW, h: baseH } = srcDims(photo);
  const canvas = document.createElement('canvas');
  canvas.width = baseW; canvas.height = baseH;
  const g = canvas.getContext('2d');
  g.drawImage(photo, 0, 0, baseW, baseH);

  const inv = k > 0 ? 1 / k : 1;
  const map = (p) => ({ x: sx + p.x * inv, y: sy + p.y * inv });

  // 図面輪郭（半透明グリーン）
  g.lineWidth = Math.max(2, baseW / 400);
  g.strokeStyle = 'rgba(0, 200, 80, 0.9)';
  if (movedPts && movedPts.length) {
    g.beginPath();
    movedPts.forEach((p, i) => { const q = map(p); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    g.closePath();
    g.stroke();
  }
  // 許容超えの点（赤マーカー）
  g.fillStyle = 'rgba(230, 30, 30, 0.9)';
  const r = Math.max(3, baseW / 250);
  for (const p of (overTolPts || [])) {
    const q = map(p);
    g.beginPath(); g.arc(q.x, q.y, r, 0, Math.PI * 2); g.fill();
  }
  return canvas;
}
