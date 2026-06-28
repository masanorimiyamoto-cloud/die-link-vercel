// public/js/die-overlay-worker.js
// ============================================================================
// 抜型照合 CV計算ワーカー（クラシック Web Worker）。
//
// メインスレッド（die-overlay-match.js）から ImageData を受け取り、OpenCV.js で
// 図面/現物の輪郭抽出→自動位置合わせ→一致率(IoU)→ズレ(mm/%) を計算して返す。
//
// ここで重い同期処理を「別スレッド」で行うため、UI（メインスレッド）は固まらない。
// OpenCV.js の巨大ダウンロードもこのワーカー内で起きるので画面はブロックされない。
// メイン側がハードタイムアウトで worker.terminate() すれば、詰まっても確実に止められる。
//
// 入力メッセージ:
//   { type:'warm' }                                         … OpenCV.js を読み込むだけ
//   { type:'match', photo, drawing, pxPerMmProc, tolMm }    … 照合実行
//     photo/drawing: { width, height, buffer(ArrayBuffer:RGBA) }
//     pxPerMmProc: 処理解像度での px/mm（0ならmm算出なし）
// 出力メッセージ:
//   { ok:true, result:{...} } / { ok:false, error }
// ============================================================================

const OPENCV_URLS = [
  // 公式ビルドは importScripts と相性が良い（worker チュートリアルもこの方式）
  'https://docs.opencv.org/4.x/opencv.js',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
];

let _cvReady = null;
function ensureCv() {
  if (_cvReady) return _cvReady;
  _cvReady = new Promise((resolve, reject) => {
    let loaded = false;
    for (const url of OPENCV_URLS) {
      try { importScripts(url); if (typeof cv !== 'undefined') { loaded = true; break; } }
      catch (e) { /* 次のCDNを試す */ }
    }
    if (!loaded || typeof cv === 'undefined') { reject(new Error('OpenCV.js を読み込めません')); return; }
    if (cv.Mat) { resolve(cv); return; }
    // WASM 初期化待ち（onRuntimeInitialized ＋ ポーリング保険）
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(cv); } };
    try { cv.onRuntimeInitialized = finish; } catch (e) {}
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (typeof cv !== 'undefined' && cv.Mat) { clearInterval(iv); finish(); }
      else if (Date.now() - t0 > 60000) { clearInterval(iv); if (!done) { done = true; reject(new Error('OpenCV 初期化タイムアウト')); } }
    }, 200);
  });
  return _cvReady;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    await ensureCv();
    if (msg.type === 'warm') { self.postMessage({ ok: true, result: 'warm' }); return; }
    if (msg.type === 'match') { self.postMessage({ ok: true, result: runMatch(msg) }); return; }
    self.postMessage({ ok: false, error: 'unknown message type' });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};

/* ============================ CV パイプライン ============================ */

function toImageData(o) {
  return { data: new Uint8ClampedArray(o.buffer), width: o.width, height: o.height };
}

function runMatch(msg) {
  const tolMm = msg.tolMm || 10;
  const pxPerMmProc = msg.pxPerMmProc || 0;
  const trash = [];
  const keep = (m) => { trash.push(m); return m; };
  const cleanup = () => { for (const m of trash) { try { m.delete(); } catch (e) {} } };

  try {
    const photoMat = keep(cv.matFromImageData(toImageData(msg.photo)));
    const drawMat  = keep(cv.matFromImageData(toImageData(msg.drawing)));
    const size = { width: photoMat.cols, height: photoMat.rows };

    const photoContour = extractPhotoContour(photoMat);
    if (!photoContour) { cleanup(); return fail('現物の外形を検出できませんでした'); }
    keep(photoContour);
    const drawContour = extractDrawingContour(drawMat);
    if (!drawContour) { cleanup(); return fail('図面の外形を抽出できませんでした'); }
    keep(drawContour);

    const photoPts = contourToPoints(photoContour);
    const drawPts0 = contourToPoints(drawContour);
    const photoStats = shapeStats(photoPts);
    const drawStats = shapeStats(drawPts0);
    const photoMask = keep(fillMask(photoPts, size));

    // 自動位置合わせ：回転(0/90/180/270)×反転 で IoU 最大を採用
    let best = null;
    for (const flipX of [false, true]) {
      for (const rot of [0, 90, 180, 270]) {
        const baseRot = (photoStats.angle - drawStats.angle);
        const moved = transformPoints(drawPts0, drawStats, photoStats, baseRot + rot, flipX);
        const mask = fillMask(moved, size);
        const score = iou(photoMask, mask);
        if (!best || score > best.score) { if (best) best.mask.delete(); best = { score, moved, mask }; }
        else { mask.delete(); }
      }
    }
    if (!best) { cleanup(); return fail('位置合わせに失敗しました'); }
    keep(best.mask);
    const matchPct = Math.round(best.score * 1000) / 10;

    // ズレ量：現物輪郭の距離変換を作り、位置合わせ済み図面輪郭点で距離をサンプル
    const edgeImg = keep(new cv.Mat(size.height, size.width, cv.CV_8UC1, new cv.Scalar(255)));
    drawPolyline(edgeImg, photoPts, 0);
    const dist = keep(new cv.Mat());
    cv.distanceTransform(edgeImg, dist, cv.DIST_L2, 3);

    const refLen = ((photoStats.w + photoStats.h) / 2) || 1; // スケール非依存の基準長
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
      ok: true, matchPct, maxDevMm, avgDevMm, maxDevPct, avgDevPct, verdict,
      movedPts, overTolPts,
      reason: (maxDevMm != null)
        ? `IoU一致率 ${matchPct}%・最大ズレ ${maxDevMm}mm（許容±${tolMm}mm）`
        : `IoU一致率 ${matchPct}%・最大ズレ 約${maxDevPct}%（現物サイズ比・CALなし）`,
    };
  } catch (e) {
    cleanup();
    return fail('CV処理エラー: ' + ((e && e.message) || e));
  }
}

function decideVerdict(matchPct, maxDevMm, tolMm) {
  if (matchPct >= 85 && (maxDevMm == null || maxDevMm <= tolMm)) return 'match';
  if (matchPct < 60) return 'mismatch';
  return 'uncertain';
}
function fail(reason) {
  return { ok: false, matchPct: null, maxDevMm: null, avgDevMm: null, maxDevPct: null, avgDevPct: null, verdict: 'uncertain', movedPts: [], overTolPts: [], reason };
}

/* ---------- 前処理・幾何ヘルパ（メイン版と同等。cv はワーカーのグローバル）---------- */
function extractDrawingContour(rgba) {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const bin = new cv.Mat();
  cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
  const contour = largestExternalContour(bin);
  gray.delete(); bin.delete(); k.delete();
  return contour;
}
function extractPhotoContour(rgba) {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 60, 160);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
  cv.dilate(edges, edges, k);
  const contour = largestExternalContour(edges);
  gray.delete(); edges.delete(); k.delete();
  return contour;
}
function largestExternalContour(bin) {
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
function pointsToContour(pts) {
  const flat = [];
  for (const p of pts) { flat.push(Math.round(p.x), Math.round(p.y)); }
  return cv.matFromArray(pts.length, 1, cv.CV_32SC2, flat);
}
function fillMask(pts, size) {
  const mask = cv.Mat.zeros(size.height, size.width, cv.CV_8UC1);
  const mv = new cv.MatVector(); const c = pointsToContour(pts);
  mv.push_back(c); cv.fillPoly(mask, mv, new cv.Scalar(255));
  c.delete(); mv.delete();
  return mask;
}
function iou(a, b) {
  const inter = new cv.Mat(), uni = new cv.Mat();
  cv.bitwise_and(a, b, inter); cv.bitwise_or(a, b, uni);
  const i = cv.countNonZero(inter), u = cv.countNonZero(uni);
  inter.delete(); uni.delete();
  return u > 0 ? i / u : 0;
}
function shapeStats(pts) {
  const c = pointsToContour(pts);
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
function drawPolyline(mat, pts, color) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    cv.line(mat, new cv.Point(Math.round(a.x), Math.round(a.y)), new cv.Point(Math.round(b.x), Math.round(b.y)), new cv.Scalar(color), 2);
  }
}
