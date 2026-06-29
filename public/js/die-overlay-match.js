// public/js/die-overlay-match.js
// ============================================================================
// 抜型照合 新方式（ハイブリッド：クライアントCV主＋AI補助）— メインスレッド実行版。
//
// iOS Safari は Web Worker 内で OpenCV の大きな WASM を初期化できない（メモリ制限で
// 「初期化中」のまま停止）。そこで CV はメインスレッドで実行する。
//   - OpenCV.js の WASM 初期化は非同期 → 読み込み中も画面は固まらない
//   - 画像は必ず小さく縮小(maxSide=480)してから処理 → メモリ枯渇（初回フリーズの主因）を根絶
//   - 計算は小画像なので一瞬（同期だが体感ブロックなし）
//
// 公開API:
//   ensureOpenCv(onStatus) … opencv.js をDL(進捗)＋WASM初期化。onStatus(文字列)で進捗通知
//   matchDieOverlay(o)     … 照合本体。{ ok, matchPct, maxDevMm, avgDevMm, maxDevPct,
//                            avgDevPct, verdict, overlayCanvas, reason }
// ============================================================================

const DEFAULT_MAX_SIDE = 480;     // 処理解像度の上限（小さいほど速い・軽い）
const INIT_TIMEOUT_MS = 60000;    // WASM初期化の上限
const CV_SOURCES = [
  '/js/opencv.js',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
];

let _cv = null;
let _cvBlobUrl = null;

/* ---------- OpenCV.js のダウンロード（進捗付き）＋ WASM初期化 ---------- */

async function downloadCv(onStatus) {
  if (_cvBlobUrl) return _cvBlobUrl;
  let lastErr;
  for (const url of CV_SOURCES) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 120000);
      const r = await fetch(url, { signal: ctrl.signal, cache: 'force-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const total = Number(r.headers.get('content-length') || 0);
      const reader = r.body.getReader();
      const chunks = []; let received = 0; let lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); received += value.length;
        if (onStatus) {
          if (total) {
            const pct = Math.round(received / total * 100);
            if (pct !== lastPct) { lastPct = pct; onStatus(`CVライブラリを取得中… ${pct}%`); }
          } else { onStatus(`CVライブラリを取得中… ${(received / 1048576).toFixed(1)}MB`); }
        }
      }
      clearTimeout(to);
      _cvBlobUrl = URL.createObjectURL(new Blob(chunks, { type: 'text/javascript' }));
      return _cvBlobUrl;
    } catch (e) { lastErr = e; if (onStatus) onStatus('別経路でCV取得を再試行中…'); }
  }
  throw new Error('CVライブラリの取得に失敗: ' + ((lastErr && lastErr.message) || ''));
}

/**
 * メインスレッドに opencv.js を読み込み、WASM初期化完了まで待つ（非同期＝画面は固まらない）。
 * iOSで「初期化中のまま停止」する真因（メモリ不足のabort/例外/未処理reject）を取りこぼさず
 * 早期に reject する。失敗理由を文字列で返すので、画面に出せば実機で原因が分かる。
 */
function loadCvScript(blobUrl, onStatus) {
  return new Promise((resolve, reject) => {
    if (window.cv && window.cv.Mat) { resolve(window.cv); return; }

    let done = false;
    let captured = '';   // 初期化中に飛んできた実エラー（abort/例外/reject）

    const fail = (msg) => {
      if (done) return; done = true;
      cleanup();
      reject(new Error(msg + (captured ? `（詳細: ${captured}）` : '')));
    };
    const finish = () => {
      if (done) return; done = true;
      cleanup();
      resolve(window.cv);
    };

    // 初期化フェーズ中だけ、グローバルの例外/未処理rejectを横取りして真因を握る
    const onErr = (ev) => {
      const m = (ev && (ev.message || (ev.error && ev.error.message))) || '';
      if (/opencv|wasm|memory|abort|RuntimeError|table|Cannot enlarge/i.test(m)) captured = m;
    };
    const onRej = (ev) => {
      const r = ev && ev.reason;
      const m = (r && (r.message || String(r))) || '';
      if (m) captured = m;
    };
    const cleanup = () => {
      clearInterval(iv);
      window.removeEventListener('error', onErr, true);
      window.removeEventListener('unhandledrejection', onRej);
    };
    window.addEventListener('error', onErr, true);
    window.addEventListener('unhandledrejection', onRej);

    const s = document.createElement('script');
    s.src = blobUrl; s.async = true;
    s.onload = () => {
      const cv = window.cv;
      if (!cv) { fail('cv undefined（opencv.js の評価に失敗）'); return; }
      if (cv.Mat) { finish(); return; }
      // 初期化完了フック。abort（メモリ不足等）も拾えるよう onAbort を上書き
      try { cv.onRuntimeInitialized = finish; } catch (e) {}
      try { cv.onAbort = (what) => { captured = String(what || 'abort'); fail('OpenCV初期化が中断（abort）'); }; } catch (e) {}
    };
    s.onerror = () => fail('opencv.js のスクリプト読み込み失敗');
    document.head.appendChild(s);

    // ポーリング: Mat出現で成功 / 捕捉済みエラーがあれば即失敗 / 上限で打ち切り
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (window.cv && window.cv.Mat) { finish(); return; }
      if (captured) { fail('OpenCV初期化エラー'); return; }
      const sec = Math.round((Date.now() - t0) / 1000);
      if (onStatus && sec > 0) onStatus(`CVライブラリを初期化中…（${sec}秒）`);
      if (Date.now() - t0 > INIT_TIMEOUT_MS) fail('OpenCV初期化タイムアウト（WASMが応答しません。端末メモリ不足の可能性）');
    }, 250);
  });
}

/** opencv.js を用意（DL進捗→初期化）。onStatus に進捗通知。 */
export async function ensureOpenCv(onStatus) {
  if (_cv) return _cv;
  const blobUrl = await downloadCv(onStatus);
  if (onStatus) onStatus('CVライブラリを初期化中…');
  _cv = await loadCvScript(blobUrl, onStatus);
  return _cv;
}

/* ---------- 画像前処理（必ず縮小してから ImageData 化：メモリ枯渇を根絶）---------- */

function srcDims(src) {
  return {
    w: src.naturalWidth || src.videoWidth || src.width || 0,
    h: src.naturalHeight || src.videoHeight || src.height || 0,
  };
}
/** 現物写真を（任意で bbox 切り出し→）maxSide に縮小し ImageData を返す。k,sx,sy は座標復元用。 */
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
  return { imageData: g.getImageData(0, 0, pw, ph), k, sx, sy };
}
function prepareDrawing(drawing, maxSide) {
  const { w, h } = srcDims(drawing);
  const k = Math.min(1, maxSide / Math.max(w, h || 1));
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas'); c.width = dw; c.height = dh;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(drawing, 0, 0, dw, dh);
  return g.getImageData(0, 0, dw, dh);
}

/* ---------- メイン: 照合 ---------- */
export async function matchDieOverlay(o) {
  const maxSide = o.maxSide || DEFAULT_MAX_SIDE;
  const tolMm = o.tolMm ?? 10;
  const cv = await ensureOpenCv(o.onStatus);

  let pPrep, drawImgData;
  try {
    pPrep = preparePhoto(o.photo, o.productBox, maxSide);
    drawImgData = prepareDrawing(o.drawing, maxSide);
  } catch (e) {
    return failResult('画像の前処理に失敗しました: ' + ((e && e.message) || e));
  }
  const pxPerMmProc = (o.pxPerMm > 0) ? o.pxPerMm * pPrep.k : 0;

  let res;
  try {
    res = runMatch(cv, pPrep.imageData, drawImgData, pxPerMmProc, tolMm);
  } catch (e) {
    return failResult('CV処理エラー: ' + ((e && e.message) || e));
  }
  if (!res || res.ok === false) return failResult((res && res.reason) || '照合に失敗しました');

  let overlayCanvas = null;
  try { overlayCanvas = renderOverlay(o.photo, pPrep.sx, pPrep.sy, pPrep.k, res.movedPts, res.overTolPts); }
  catch (e) { /* 描画失敗は数値だけ返す */ }

  return {
    ok: true, matchPct: res.matchPct, maxDevMm: res.maxDevMm, avgDevMm: res.avgDevMm,
    maxDevPct: res.maxDevPct, avgDevPct: res.avgDevPct, verdict: res.verdict, reason: res.reason, overlayCanvas,
  };
}

function failResult(reason) {
  return { ok: false, matchPct: null, maxDevMm: null, avgDevMm: null, maxDevPct: null, avgDevPct: null, verdict: 'uncertain', overlayCanvas: null, reason };
}

/* ---------- CV パイプライン（メインスレッド・小画像なので一瞬）---------- */
function runMatch(cv, photoImg, drawImg, pxPerMmProc, tolMm) {
  const trash = [];
  const keep = (m) => { trash.push(m); return m; };
  const cleanup = () => { for (const m of trash) { try { m.delete(); } catch (e) {} } };
  try {
    const photoMat = keep(cv.matFromImageData(photoImg));
    const drawMat  = keep(cv.matFromImageData(drawImg));
    const size = { width: photoMat.cols, height: photoMat.rows };

    const photoContour = extractPhotoContour(cv, photoMat);
    if (!photoContour) { cleanup(); return fail('現物の外形を検出できませんでした'); }
    keep(photoContour);
    const drawContour = extractDrawingContour(cv, drawMat);
    if (!drawContour) { cleanup(); return fail('図面の外形を抽出できませんでした'); }
    keep(drawContour);

    const photoPts = contourToPoints(photoContour);
    const drawPts0 = contourToPoints(drawContour);
    const photoStats = shapeStats(cv, photoPts);
    const drawStats = shapeStats(cv, drawPts0);
    const photoMask = keep(fillMask(cv, photoPts, size));

    let best = null;
    for (const flipX of [false, true]) {
      for (const rot of [0, 90, 180, 270]) {
        const baseRot = (photoStats.angle - drawStats.angle);
        const moved = transformPoints(drawPts0, drawStats, photoStats, baseRot + rot, flipX);
        const mask = fillMask(cv, moved, size);
        const score = iou(cv, photoMask, mask);
        if (!best || score > best.score) { if (best) best.mask.delete(); best = { score, moved, mask }; }
        else { mask.delete(); }
      }
    }
    if (!best) { cleanup(); return fail('位置合わせに失敗しました'); }
    keep(best.mask);
    const matchPct = Math.round(best.score * 1000) / 10;

    const edgeImg = keep(new cv.Mat(size.height, size.width, cv.CV_8UC1, new cv.Scalar(255)));
    drawPolyline(cv, edgeImg, photoPts, 0);
    const dist = keep(new cv.Mat());
    cv.distanceTransform(edgeImg, dist, cv.DIST_L2, 3);

    const refLen = ((photoStats.w + photoStats.h) / 2) || 1;
    const relTol = 0.05;
    let sum = 0, n = 0, maxDevPx = 0;
    const overTolPts = [];
    for (const p of best.moved) {
      const x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue;
      const dpx = dist.floatAt(y, x);
      sum += dpx; n++;
      if (dpx > maxDevPx) maxDevPx = dpx;
      const over = (pxPerMmProc > 0) ? (dpx / pxPerMmProc > tolMm) : (dpx / refLen > relTol);
      if (over) overTolPts.push({ x: p.x, y: p.y });
    }
    const avgDevMm = (pxPerMmProc > 0 && n > 0) ? Math.round((sum / n) / pxPerMmProc * 10) / 10 : null;
    const maxDevMm = (pxPerMmProc > 0) ? Math.round(maxDevPx / pxPerMmProc * 10) / 10 : null;
    const maxDevPct = Math.round((maxDevPx / refLen) * 1000) / 10;
    const avgDevPct = (n > 0) ? Math.round((sum / n / refLen) * 1000) / 10 : null;
    const verdict = decideVerdict(matchPct, maxDevMm, tolMm);
    const movedPts = best.moved.map((p) => ({ x: p.x, y: p.y }));
    cleanup();
    return {
      ok: true, matchPct, maxDevMm, avgDevMm, maxDevPct, avgDevPct, verdict, movedPts, overTolPts,
      reason: (maxDevMm != null)
        ? `IoU一致率 ${matchPct}%・最大ズレ ${maxDevMm}mm（許容±${tolMm}mm）`
        : `IoU一致率 ${matchPct}%・最大ズレ 約${maxDevPct}%（現物サイズ比・CALなし）`,
    };
  } catch (e) { cleanup(); throw e; }
}

function decideVerdict(matchPct, maxDevMm, tolMm) {
  if (matchPct >= 85 && (maxDevMm == null || maxDevMm <= tolMm)) return 'match';
  if (matchPct < 60) return 'mismatch';
  return 'uncertain';
}
function fail(reason) {
  return { ok: false, matchPct: null, maxDevMm: null, avgDevMm: null, maxDevPct: null, avgDevPct: null, verdict: 'uncertain', movedPts: [], overTolPts: [], reason };
}

/* ---------- 前処理・幾何ヘルパ（cv は引数で受け取る）---------- */
function extractDrawingContour(cv, rgba) {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const bin = new cv.Mat();
  cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
  const contour = largestExternalContour(cv, bin);
  gray.delete(); bin.delete(); k.delete();
  return contour;
}
function extractPhotoContour(cv, rgba) {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 60, 160);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
  cv.dilate(edges, edges, k);
  const contour = largestExternalContour(cv, edges);
  gray.delete(); edges.delete(); k.delete();
  return contour;
}
function largestExternalContour(cv, bin) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const a = cv.contourArea(c);
    if (a > bestArea) { bestArea = a; if (best) best.delete(); best = c.clone(); }
    c.delete();
  }
  contours.delete(); hierarchy.delete();
  return best;
}
function contourToPoints(contour) {
  const pts = []; const d = contour.data32S;
  for (let i = 0; i < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] });
  return pts;
}
function pointsToContour(cv, pts) {
  const flat = [];
  for (const p of pts) { flat.push(Math.round(p.x), Math.round(p.y)); }
  return cv.matFromArray(pts.length, 1, cv.CV_32SC2, flat);
}
function fillMask(cv, pts, size) {
  const mask = cv.Mat.zeros(size.height, size.width, cv.CV_8UC1);
  const mv = new cv.MatVector(); const c = pointsToContour(cv, pts);
  mv.push_back(c); cv.fillPoly(mask, mv, new cv.Scalar(255));
  c.delete(); mv.delete();
  return mask;
}
function iou(cv, a, b) {
  const inter = new cv.Mat(), uni = new cv.Mat();
  cv.bitwise_and(a, b, inter); cv.bitwise_or(a, b, uni);
  const i = cv.countNonZero(inter), u = cv.countNonZero(uni);
  inter.delete(); uni.delete();
  return u > 0 ? i / u : 0;
}
function shapeStats(cv, pts) {
  const c = pointsToContour(cv, pts);
  const rect = cv.minAreaRect(c);
  c.delete();
  return { cx: rect.center.x, cy: rect.center.y, w: rect.size.width, h: rect.size.height, angle: rect.angle };
}
function transformPoints(pts, src, dst, rotDeg, flipX) {
  const rad = rotDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const sx = (dst.w && src.w) ? dst.w / src.w : 1;
  const sy = (dst.h && src.h) ? dst.h / src.h : 1;
  const s = (sx + sy) / 2;
  return pts.map((p) => {
    let dx = (p.x - src.cx) * (flipX ? -1 : 1);
    let dy = (p.y - src.cy);
    dx *= s; dy *= s;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return { x: rx + dst.cx, y: ry + dst.cy };
  });
}
function drawPolyline(cv, mat, pts, color) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    cv.line(mat, new cv.Point(Math.round(a.x), Math.round(a.y)), new cv.Point(Math.round(b.x), Math.round(b.y)), new cv.Scalar(color), 2);
  }
}

/* ---------- 重ね合わせ描画 ---------- */
function renderOverlay(photo, sx, sy, k, movedPts, overTolPts) {
  const { w: baseW, h: baseH } = srcDims(photo);
  const canvas = document.createElement('canvas');
  canvas.width = baseW; canvas.height = baseH;
  const g = canvas.getContext('2d');
  g.drawImage(photo, 0, 0, baseW, baseH);
  const inv = k > 0 ? 1 / k : 1;
  const map = (p) => ({ x: sx + p.x * inv, y: sy + p.y * inv });
  g.lineWidth = Math.max(2, baseW / 400);
  g.strokeStyle = 'rgba(0, 200, 80, 0.9)';
  if (movedPts && movedPts.length) {
    g.beginPath();
    movedPts.forEach((p, i) => { const q = map(p); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    g.closePath(); g.stroke();
  }
  g.fillStyle = 'rgba(230, 30, 30, 0.9)';
  const r = Math.max(3, baseW / 250);
  for (const p of (overTolPts || [])) {
    const q = map(p);
    g.beginPath(); g.arc(q.x, q.y, r, 0, Math.PI * 2); g.fill();
  }
  return canvas;
}
