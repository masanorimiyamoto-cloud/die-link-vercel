// public/js/die-overlay-match.js
// ============================================================================
// 抜型照合 — 純JS版（OpenCV不使用）。
//
// iOS Safari はフル版 OpenCV.js(7MBインラインWASM)の初期化でタブごとメモリ killされる
// ため、OpenCV を全面撤去し、輪郭抽出・自動位置合わせ・一致率(IoU)・mmズレ・重ね合わせ画像を
// すべて素のJS + Canvas で実装する。処理解像度は 480px に縮小するので計算は一瞬で、
// 10MBのWASMロードも無くなるためクラッシュしない。
//
// 公開API:
//   matchDieOverlay(o) … 照合本体。o = { photo(Image), drawing(Image), pxPerMm,
//                        productBox?, tolMm?, maxSide?, onStatus? }
//                        → { ok, matchPct, maxDevMm, avgDevMm, maxDevPct, avgDevPct,
//                            verdict, overlayCanvas, reason }
//   ※ ensureOpenCv は廃止（互換のため呼ばれても何もしない no-op を残す）。
// ============================================================================

const DEFAULT_MAX_SIDE = 480;     // 処理解像度の上限（小さいほど速い・軽い）
const MAX_CONTOUR_PTS = 600;      // 輪郭点の上限（間引いて計算量を抑える）

/* 互換: 旧コードが ensureOpenCv を呼んでもエラーにしない（OpenCVは使わない）。 */
export async function ensureOpenCv(onStatus) { if (onStatus) onStatus(''); return null; }

/* ============================================================================
   画像前処理（必ず縮小してから ImageData 化：メモリ枯渇を根絶）
   ========================================================================== */
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

/* ============================================================================
   メイン: 照合
   ========================================================================== */
export async function matchDieOverlay(o) {
  const maxSide = o.maxSide || DEFAULT_MAX_SIDE;
  const tolMm = o.tolMm ?? 10;
  const onStatus = o.onStatus;

  let pPrep, drawImgData;
  try {
    if (onStatus) onStatus('画像を解析中…');
    pPrep = preparePhoto(o.photo, o.productBox, maxSide);
    drawImgData = prepareDrawing(o.drawing, maxSide);
  } catch (e) {
    return failResult('画像の前処理に失敗しました: ' + ((e && e.message) || e));
  }
  const pxPerMmProc = (o.pxPerMm > 0) ? o.pxPerMm * pPrep.k : 0;

  let res;
  try {
    if (onStatus) onStatus('外形を抽出して位置合わせ中…');
    res = runMatch(pPrep.imageData, drawImgData, pxPerMmProc, tolMm);
  } catch (e) {
    return failResult('解析エラー: ' + ((e && e.message) || e));
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

/* ============================================================================
   照合パイプライン（純CPU・小画像なので一瞬）
   ========================================================================== */
function runMatch(photoImg, drawImg, pxPerMmProc, tolMm) {
  const pw = photoImg.width, ph = photoImg.height;
  const dw = drawImg.width, dh = drawImg.height;

  // --- 現物：エッジ→閉処理→背景フラッドフィル→最大連結成分 でシルエット ---
  const photoMask = photoSilhouette(photoImg);
  if (!photoMask || photoMask.area < pw * ph * 0.01) return fail('現物の外形を検出できませんでした');
  // --- 図面(-zu 線画)：インク二値→閉処理→背景フラッドフィル でシルエット ---
  const drawMask = drawingSilhouette(drawImg);
  if (!drawMask || drawMask.area < dw * dh * 0.005) return fail('図面の外形を抽出できませんでした');

  const photoPoly = simplifyPoly(traceContour(photoMask.mask, pw, ph), MAX_CONTOUR_PTS);
  const drawPoly0 = simplifyPoly(traceContour(drawMask.mask, dw, dh), MAX_CONTOUR_PTS);
  if (photoPoly.length < 8) return fail('現物の輪郭が取得できませんでした');
  if (drawPoly0.length < 8) return fail('図面の輪郭が取得できませんでした');

  const photoStats = maskMoments(photoMask.mask, pw, ph);
  const drawStats = maskMoments(drawMask.mask, dw, dh);
  if (!photoStats || !drawStats) return fail('形状統計の計算に失敗しました');

  const size = { width: pw, height: ph };
  const baseRot = photoStats.angle - drawStats.angle; // 主軸を合わせる初期回転（rad）

  // 回転 0/90/180/270 × 反転 を総当たりし IoU 最大の重なりを採用
  let best = null;
  for (const flip of [false, true]) {
    for (const rot of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      const moved = transformPoly(drawPoly0, drawStats, photoStats, baseRot + rot, flip);
      const candMask = fillPoly(moved, pw, ph);
      const score = iou(photoMask.mask, candMask);
      if (!best || score > best.score) best = { score, moved };
    }
  }
  if (!best) return fail('位置合わせに失敗しました');
  const matchPct = Math.round(best.score * 1000) / 10;

  // mmズレ：現物輪郭の距離変換を作り、位置合わせ済み図面輪郭点でサンプル
  const photoBoundary = boundaryMask(photoMask.mask, pw, ph);
  const dist = distanceTransform(photoBoundary, pw, ph);

  const refLen = Math.sqrt(photoStats.area) || 1;
  const relTol = 0.05;
  let sum = 0, n = 0, maxDevPx = 0;
  const overTolPts = [];
  for (const p of best.moved) {
    const x = Math.round(p.x), y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= pw || y >= ph) continue;
    const dpx = dist[y * pw + x];
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

  return {
    ok: true, matchPct, maxDevMm, avgDevMm, maxDevPct, avgDevPct, verdict,
    movedPts: best.moved, overTolPts,
    reason: (maxDevMm != null)
      ? `一致率(IoU) ${matchPct}%・最大ズレ ${maxDevMm}mm（許容±${tolMm}mm）`
      : `一致率(IoU) ${matchPct}%・最大ズレ 約${maxDevPct}%（現物サイズ比・CALなし）`,
  };
}

function decideVerdict(matchPct, maxDevMm, tolMm) {
  if (matchPct >= 85 && (maxDevMm == null || maxDevMm <= tolMm)) return 'match';
  if (matchPct < 60) return 'mismatch';
  return 'uncertain';
}
function fail(reason) {
  return { ok: false, matchPct: null, maxDevMm: null, avgDevMm: null, maxDevPct: null, avgDevPct: null, verdict: 'uncertain', movedPts: [], overTolPts: [], reason };
}

/* ============================================================================
   シルエット抽出（純JS）
   ========================================================================== */
function toGray(imgData) {
  const { data, width, height } = imgData;
  const g = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
  }
  return g;
}
function otsu(g) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thr = t; }
  }
  return thr;
}
function boxBlur3(g, w, h) {
  const out = new Uint8Array(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      s += g[yy * w + xx]; n++;
    }
    out[y * w + x] = (s / n) | 0;
  }
  return out;
}
/** Sobel勾配の大きさ（Uint8正規化）を返す。 */
function sobelMag(g, w, h) {
  const mag = new Uint8Array(w * h);
  let mx = 1;
  const raw = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
    const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
    const m = Math.sqrt(gx * gx + gy * gy);
    raw[i] = m; if (m > mx) mx = m;
  }
  for (let i = 0; i < mag.length; i++) mag[i] = Math.min(255, (raw[i] / mx) * 255) | 0;
  return mag;
}
/** 二値マスクの矩形膨張（半径r・分離フィルタ）。 */
function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; if (mask[y * w + xx]) { v = 1; break; } }
    tmp[y * w + x] = v;
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let v = 0;
    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; if (tmp[yy * w + x]) { v = 1; break; } }
    out[y * w + x] = v;
  }
  return out;
}
/** 壁(barrier=1)で囲まれた内側を塗りつぶしたシルエットを最大連結成分で返す。 */
function silhouetteFromBarrier(barrier, w, h) {
  const bg = new Uint8Array(w * h);  // 1 = 外側(背景)
  const stack = [];
  const push = (x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = y * w + x; if (bg[i] || barrier[i]) return; bg[i] = 1; stack.push(i); };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) { const i = stack.pop(); const x = i % w, y = (i / w) | 0; push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1); }
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < inside.length; i++) inside[i] = bg[i] ? 0 : 1;  // 外側でない＝内側(穴も内側扱い=穴埋め)
  return largestComponent(inside, w, h);
}
function largestComponent(mask, w, h) {
  const lab = new Int32Array(w * h);
  let bestLab = 0, bestSize = 0, cur = 0;
  const stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || lab[s]) continue;
    cur++; let size = 0; lab[s] = cur; stack.push(s);
    while (stack.length) {
      const i = stack.pop(); size++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && mask[i - 1] && !lab[i - 1]) { lab[i - 1] = cur; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !lab[i + 1]) { lab[i + 1] = cur; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !lab[i - w]) { lab[i - w] = cur; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !lab[i + w]) { lab[i + w] = cur; stack.push(i + w); }
    }
    if (size > bestSize) { bestSize = size; bestLab = cur; }
  }
  const out = new Uint8Array(w * h);
  if (bestLab) for (let i = 0; i < out.length; i++) out[i] = (lab[i] === bestLab) ? 1 : 0;
  return { mask: out, area: bestSize };
}
function photoSilhouette(imgData) {
  const w = imgData.width, h = imgData.height;
  let g = toGray(imgData);
  g = boxBlur3(g, w, h);
  const mag = sobelMag(g, w, h);
  const thr = Math.max(24, otsu(mag));         // エッジ二値化のしきい値
  const edge = new Uint8Array(w * h);
  for (let i = 0; i < edge.length; i++) edge[i] = mag[i] >= thr ? 1 : 0;
  const r = Math.max(1, Math.round(Math.max(w, h) / 200));  // 線の途切れを閉じる
  const closed = dilate(edge, w, h, r);
  return silhouetteFromBarrier(closed, w, h);
}
function drawingSilhouette(imgData) {
  const w = imgData.width, h = imgData.height;
  const g = toGray(imgData);
  const thr = otsu(g);
  const ink = new Uint8Array(w * h);            // 暗い画素=インク(線)
  for (let i = 0; i < ink.length; i++) ink[i] = g[i] < thr ? 1 : 0;
  const r = Math.max(1, Math.round(Math.max(w, h) / 240));
  const closed = dilate(ink, w, h, r);
  return silhouetteFromBarrier(closed, w, h);
}

/* ============================================================================
   輪郭トレース（Moore近傍・時計回り）／簡略化
   ========================================================================== */
function traceContour(mask, w, h) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]) ? 1 : 0;
  let sx = -1, sy = -1;
  for (let y = 0; y < h && sy < 0; y++) for (let x = 0; x < w; x++) { if (mask[y * w + x]) { sx = x; sy = y; break; } }
  if (sx < 0) return [];
  // 時計回り8近傍（画面座標：yは下向き）。0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE
  const ox = [1, 1, 0, -1, -1, -1, 0, 1];
  const oy = [0, 1, 1, 1, 0, -1, -1, -1];
  const out = [];
  let px = sx, py = sy;
  // 開始画素には左(W)から入った想定 → 逆方向(=探索開始)は W の次から
  let backtrack = 4; // 直前画素の方向(W)
  const limit = 8 * (w * h);
  let count = 0;
  do {
    out.push({ x: px, y: py });
    let moved = false;
    // backtrack の次から時計回りに最初の前景画素を探す
    for (let k = 1; k <= 8; k++) {
      const d = (backtrack + k) % 8;
      const nx = px + ox[d], ny = py + oy[d];
      if (at(nx, ny)) {
        backtrack = (d + 4) % 8; // 新しい画素から見た「来た方向」
        px = nx; py = ny; moved = true; break;
      }
    }
    if (!moved) break; // 孤立点
    count++;
  } while ((px !== sx || py !== sy) && count < limit);
  return out;
}
/** 輪郭点を最大 maxPts 個に間引く（等間隔ストライド）。 */
function simplifyPoly(poly, maxPts) {
  const n = poly.length;
  if (n <= maxPts) return poly.slice();
  const stride = Math.ceil(n / maxPts);
  const out = [];
  for (let i = 0; i < n; i += stride) out.push(poly[i]);
  return out;
}

/* ============================================================================
   幾何ヘルパ（モーメント・相似変換・ポリゴン塗り・IoU・距離変換）
   ========================================================================== */
function maskMoments(mask, w, h) {
  let m00 = 0, m10 = 0, m01 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (mask[y * w + x]) { m00++; m10 += x; m01 += y; } }
  if (!m00) return null;
  const cx = m10 / m00, cy = m01 / m00;
  let mu20 = 0, mu02 = 0, mu11 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (mask[y * w + x]) { const dx = x - cx, dy = y - cy; mu20 += dx * dx; mu02 += dy * dy; mu11 += dx * dy; } }
  mu20 /= m00; mu02 /= m00; mu11 /= m00;
  const angle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02); // 主軸角(rad)
  return { area: m00, cx, cy, angle };
}
/** src(図面)の輪郭点を dst(現物)の中心・スケール・主軸へ移す相似変換。 */
function transformPoly(pts, src, dst, rotRad, flip) {
  const cos = Math.cos(rotRad), sin = Math.sin(rotRad);
  const s = Math.sqrt((dst.area || 1) / (src.area || 1));
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    let dx = (pts[i].x - src.cx) * (flip ? -1 : 1);
    let dy = (pts[i].y - src.cy);
    dx *= s; dy *= s;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    out[i] = { x: rx + dst.cx, y: ry + dst.cy };
  }
  return out;
}
/** 単純ポリゴンを even-odd 規則で塗りつぶし Uint8 マスクを返す。 */
function fillPoly(poly, w, h) {
  const mask = new Uint8Array(w * h);
  const n = poly.length;
  if (n < 3) return mask;
  let minY = Infinity, maxY = -Infinity;
  for (const p of poly) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(h - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = minY; y <= maxY; y++) {
    xs.length = 0;
    const yc = y + 0.5;
    for (let i = 0; i < n; i++) {
      let a = poly[i], b = poly[(i + 1) % n];
      let y1 = a.y, y2 = b.y, x1 = a.x, x2 = b.x;
      if (y1 === y2) continue;
      if (y1 > y2) { const ty = y1; y1 = y2; y2 = ty; const tx = x1; x1 = x2; x2 = tx; }
      if (yc >= y1 && yc < y2) xs.push(x1 + (yc - y1) / (y2 - y1) * (x2 - x1));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let xa = Math.ceil(xs[k] - 0.5), xb = Math.floor(xs[k + 1] - 0.5);
      if (xa < 0) xa = 0; if (xb > w - 1) xb = w - 1;
      const row = y * w;
      for (let x = xa; x <= xb; x++) mask[row + x] = 1;
    }
  }
  return mask;
}
function iou(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { const av = a[i], bv = b[i]; if (av || bv) { uni++; if (av && bv) inter++; } }
  return uni > 0 ? inter / uni : 0;
}
/** シルエット境界画素（前景で4近傍に背景を持つ）マスク。 */
function boundaryMask(mask, w, h) {
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { b[i] = 1; continue; }
    if (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) b[i] = 1;
  }
  return b;
}
/** 2パス chamfer 距離変換（seed=1 の画素を距離0とする近似ユークリッド距離）。 */
function distanceTransform(seed, w, h) {
  const INF = 1e9, c1 = 1, c2 = Math.SQRT2;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i];
    if (x > 0 && d[i - 1] + c1 < v) v = d[i - 1] + c1;
    if (y > 0 && d[i - w] + c1 < v) v = d[i - w] + c1;
    if (x > 0 && y > 0 && d[i - w - 1] + c2 < v) v = d[i - w - 1] + c2;
    if (x < w - 1 && y > 0 && d[i - w + 1] + c2 < v) v = d[i - w + 1] + c2;
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i];
    if (x < w - 1 && d[i + 1] + c1 < v) v = d[i + 1] + c1;
    if (y < h - 1 && d[i + w] + c1 < v) v = d[i + w] + c1;
    if (x < w - 1 && y < h - 1 && d[i + w + 1] + c2 < v) v = d[i + w + 1] + c2;
    if (x > 0 && y < h - 1 && d[i + w - 1] + c2 < v) v = d[i + w - 1] + c2;
    d[i] = v;
  }
  return d;
}

/* ============================================================================
   重ね合わせ描画（現物写真 + 位置合わせ済み図面輪郭 + 許容超え点）
   ========================================================================== */
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

/* テスト用エクスポート（純関数のみ。ブラウザ実行には影響しない）。 */
export const __test = {
  otsu, dilate, silhouetteFromBarrier, largestComponent, traceContour, simplifyPoly,
  maskMoments, transformPoly, fillPoly, iou, boundaryMask, distanceTransform,
};
