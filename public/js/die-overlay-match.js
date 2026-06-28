// public/js/die-overlay-match.js
// ============================================================================
// 抜型照合 新方式（ハイブリッド：クライアントCV主＋AI補助）の計算エンジン。
//
// 役割:
//   1) 登録図面(-zu 線画) と 現物の静止画 から、それぞれ「外形輪郭」を抽出する前処理
//   2) 図面輪郭を現物輪郭へ自動位置合わせ（相似変換＋回転/反転の総当たりで IoU 最大を選ぶ）
//   3) 一致率(%)＝重なり面積の IoU、ズレ量(mm)＝距離変換による輪郭間距離を算出
//   4) 現物写真の上に位置合わせ済みの図面輪郭を重ねた「結果画像」を canvas に描画
//
// 重要な前提:
//   - 画像LLMは画像生成も mm 精度の位置合わせもできない。重ね合わせ画像の描画と mm 計測は
//     すべてこのコード（幾何計算）側で行う。AIは別途「同一品番か」の意味照合に使う(_vision)。
//   - mm 換算は CAL-50(QR/1辺50mm) 校正で得た px/mm を呼び出し側から渡してもらう。
//     CV は「静止画を撮影したときの映像解像度」で動かし、その px/mm(pxPerMmVideo) を渡すこと。
//
// 依存: OpenCV.js（遅延ロード）。WASM が大きい(~8MB)ため、照合モードに入ったときだけ読み込む。
// ============================================================================

// 取得元（上から順に試す）。docs.opencv.org のバージョン別パス(4.10.0等)は存在しないため
// ローリング最新の 4.x を主、jsDelivr のバージョン固定版を予備にする。
const OPENCV_URLS = [
  'https://docs.opencv.org/4.x/opencv.js',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
];

let _cvReady = null;

/** 1つのURLから opencv.js を読み込み、WASM初期化完了まで待つ。 */
function loadScriptCv(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => {
      const cv = window.cv;
      if (!cv) { reject(new Error('cv undefined')); return; }
      if (cv.Mat) { resolve(cv); return; }
      // emscripten の初期化完了を待つ（onRuntimeInitialized ＋ ポーリング保険）
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(window.cv); } };
      cv.onRuntimeInitialized = finish;
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window.cv && window.cv.Mat) { clearInterval(iv); finish(); }
        else if (Date.now() - t0 > 40000) { clearInterval(iv); if (!done) { done = true; reject(new Error('init timeout')); } }
      }, 150);
    };
    s.onerror = () => { s.remove(); reject(new Error('load error')); };
    document.head.appendChild(s);
  });
}

/** OpenCV.js を一度だけ遅延ロードする。複数回呼んでも同じ Promise を返す。
 *  1つ目のCDNが失敗（404等）したら次のCDNにフォールバックする。 */
export function ensureOpenCv() {
  if (_cvReady) return _cvReady;
  _cvReady = (async () => {
    if (window.cv && window.cv.Mat) return window.cv;
    for (const url of OPENCV_URLS) {
      try { return await loadScriptCv(url); }
      catch { /* 次のCDNを試す */ }
    }
    throw new Error('opencv.js を取得できません（通信環境を確認）');
  })();
  // 失敗時は次回に再試行できるようキャッシュを破棄
  _cvReady.catch(() => { _cvReady = null; });
  return _cvReady;
}

// ---------------------------------------------------------------------------
// 内部ユーティリティ
// ---------------------------------------------------------------------------

/** ソース(画像/canvas/ImageData)を指定の最大辺に収まるよう縮小して RGBA Mat 化。
 *  返り値の scale は「処理画像px ÷ 元画像px」（mm換算で使う）。 */
function readScaledMat(cv, src, maxSide) {
  // いったん等倍で読み、必要なら縮小
  let mat = cv.imread(src); // RGBA
  const w = mat.cols, h = mat.rows;
  const longSide = Math.max(w, h);
  let scale = 1;
  if (maxSide && longSide > maxSide) {
    scale = maxSide / longSide;
    const dst = new cv.Mat();
    cv.resize(mat, dst, new cv.Size(Math.round(w * scale), Math.round(h * scale)), 0, 0, cv.INTER_AREA);
    mat.delete();
    mat = dst;
  }
  return { mat, scale };
}

/** 図面(-zu 線画)から外形輪郭(最大の外側輪郭)を抽出。線画は背景白・線黒の想定。 */
function extractDrawingContour(cv, rgba) {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  // 線画は二値化が安定。Otsu で反転(線=前景)させる。
  const bin = new cv.Mat();
  cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
  // 線の途切れを埋めて閉領域にする
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
  const contour = largestExternalContour(cv, bin);
  gray.delete(); bin.delete(); k.delete();
  return contour; // cv.Mat (Nx1, CV_32SC2) もしくは null
}

/** 現物の静止画から製品シルエットの外形輪郭を抽出。 */
function extractPhotoContour(cv, rgba) {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  // エッジ→膨張→閉じる で製品外形を太い連結成分にする
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 60, 160);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
  cv.dilate(edges, edges, k);
  const contour = largestExternalContour(cv, edges);
  gray.delete(); edges.delete(); k.delete();
  return contour;
}

/** 二値画像から最大面積の外側輪郭を1本返す（呼び出し側で delete）。 */
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
  return best; // null の可能性あり
}

/** 輪郭点列を {x,y} 配列へ。 */
function contourToPoints(cv, contour) {
  const pts = [];
  const d = contour.data32S;
  for (let i = 0; i < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] });
  return pts;
}

/** 点列を 1xN CV_32SC2 の輪郭 Mat へ戻す。 */
function pointsToContour(cv, pts) {
  const m = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flatMap(p => [Math.round(p.x), Math.round(p.y)]));
  return m;
}

/** 輪郭を塗りつぶしたマスク(8UC1)を size で作る。 */
function fillMask(cv, pts, size) {
  const mask = cv.Mat.zeros(size.height, size.width, cv.CV_8UC1);
  const mv = new cv.MatVector();
  const c = pointsToContour(cv, pts);
  mv.push_back(c);
  cv.fillPoly(mask, mv, new cv.Scalar(255));
  c.delete(); mv.delete();
  return mask;
}

/** 2マスクの IoU(0..1)。 */
function iou(cv, a, b) {
  const inter = new cv.Mat(), uni = new cv.Mat();
  cv.bitwise_and(a, b, inter);
  cv.bitwise_or(a, b, uni);
  const i = cv.countNonZero(inter), u = cv.countNonZero(uni);
  inter.delete(); uni.delete();
  return u > 0 ? i / u : 0;
}

/** 点列の重心と minAreaRect 相当の寸法・角度を求める。 */
function shapeStats(cv, pts) {
  const c = pointsToContour(cv, pts);
  const rect = cv.minAreaRect(c);
  c.delete();
  return {
    cx: rect.center.x, cy: rect.center.y,
    w: rect.size.width, h: rect.size.height,
    angle: rect.angle,
  };
}

/** 点列に相似変換(中心 about (cx,cy)・回転deg・スケール s・反転flipX)→平行移動(tx,ty) を適用。 */
function transformPoints(pts, src, dst, rotDeg, flipX) {
  const rad = rotDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const sx = (dst.w && src.w) ? dst.w / src.w : 1;
  const sy = (dst.h && src.h) ? dst.h / src.h : 1;
  const s = (sx + sy) / 2; // 相似（等方）スケール
  return pts.map(p => {
    let dx = (p.x - src.cx) * (flipX ? -1 : 1);
    let dy = (p.y - src.cy);
    // スケール
    dx *= s; dy *= s;
    // 回転
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return { x: rx + dst.cx, y: ry + dst.cy };
  });
}

// ---------------------------------------------------------------------------
// メイン: 位置合わせ＋一致率＋mmズレ＋重ね合わせ画像
// ---------------------------------------------------------------------------
/**
 * @param {Object} o
 * @param {CanvasImageSource|ImageData} o.photo        現物の静止画（video解像度のまま推奨）
 * @param {CanvasImageSource} o.drawing                登録図面(-zu)の HTMLImageElement
 * @param {number} o.pxPerMm                           CAL-50校正の映像px/mm（pxPerMmVideo）
 * @param {{x,y,w,h}} [o.productBox]                   現物bboxの正規化座標(0..1)。あれば切り出して精度UP
 * @param {number} [o.tolMm=10]                        合否許容差(±mm)
 * @param {number} [o.maxSide=1024]                    処理解像度の上限（速度と精度の妥協点）
 * @returns {Promise<{ok,matchPct,maxDevMm,avgDevMm,verdict,overlayCanvas,reason}>}
 */
export async function matchDieOverlay(o) {
  const cv = await ensureOpenCv();
  const tolMm = o.tolMm ?? 10;
  const maxSide = o.maxSide ?? 1024;

  const trash = [];
  const keep = (m) => { trash.push(m); return m; };
  const cleanup = () => { for (const m of trash) { try { m.delete(); } catch {} } };

  try {
    // --- 現物画像の読み込み（必要なら bbox で切り出し）---
    let photoSrc = o.photo;
    if (o.productBox) photoSrc = cropToBox(o.photo, o.productBox);
    const { mat: photoMat, scale: photoScale } = readScaledMat(cv, photoSrc, maxSide);
    keep(photoMat);
    const size = { width: photoMat.cols, height: photoMat.rows };

    // --- 輪郭抽出（前処理）---
    const photoContour = extractPhotoContour(cv, photoMat);
    if (!photoContour) { cleanup(); return failResult('現物の外形を検出できませんでした'); }
    keep(photoContour);

    const { mat: drawMat } = readScaledMat(cv, o.drawing, maxSide);
    keep(drawMat);
    const drawContour = extractDrawingContour(cv, drawMat);
    if (!drawContour) { cleanup(); return failResult('図面の外形を抽出できませんでした'); }
    keep(drawContour);

    const photoPts = contourToPoints(cv, photoContour);
    const drawPts0 = contourToPoints(cv, drawContour);
    const photoStats = shapeStats(cv, photoPts);
    const drawStats = shapeStats(cv, drawPts0);

    const photoMask = keep(fillMask(cv, photoPts, size));

    // --- 自動位置合わせ：回転(0/90/180/270)×反転 を総当たりし IoU 最大を選ぶ ---
    // （撮影の裏表・90度回転・遠近の許容。minAreaRect ベースの相似変換で初期化）
    let best = null;
    for (const flipX of [false, true]) {
      for (const rot of [0, 90, 180, 270]) {
        // minAreaRect 角度差も加味
        const baseRot = (photoStats.angle - drawStats.angle);
        const moved = transformPoints(drawPts0, drawStats, photoStats, baseRot + rot, flipX);
        const mask = fillMask(cv, moved, size);
        const score = iou(cv, photoMask, mask);
        if (!best || score > best.score) {
          if (best) best.mask.delete();
          best = { score, moved, mask, rot, flipX };
        } else {
          mask.delete();
        }
      }
    }
    if (!best) { cleanup(); return failResult('位置合わせに失敗しました'); }
    keep(best.mask);

    const matchPct = Math.round(best.score * 1000) / 10; // 0.1%刻み

    // --- mm ズレ量：現物輪郭の距離変換を作り、位置合わせ済み図面輪郭点で距離をサンプル ---
    // 現物輪郭線を 0、それ以外を 255 にした画像に distanceTransform → 各画素=最近傍輪郭までの距離(px)
    const edgeImg = keep(new cv.Mat(size.height, size.width, cv.CV_8UC1, new cv.Scalar(255)));
    drawPolyline(cv, edgeImg, photoPts, 0); // 現物輪郭を黒線(0)で描く
    const dist = keep(new cv.Mat());
    cv.distanceTransform(edgeImg, dist, cv.DIST_L2, 3);

    // 処理px → mm 係数（縮小していれば元px換算してから mm へ）
    // photoScale = 処理px/元px。元px = 処理px / photoScale。mm = 元px / pxPerMm。
    const pxToMm = (photoScale > 0 && o.pxPerMm > 0) ? (1 / photoScale) / o.pxPerMm : 0;

    let sum = 0, n = 0, maxDevPx = 0;
    const overTol = [];
    for (const p of best.moved) {
      const x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue;
      const dpx = dist.floatAt(y, x);
      sum += dpx; n++;
      if (dpx > maxDevPx) maxDevPx = dpx;
      if (pxToMm > 0 && dpx * pxToMm > tolMm) overTol.push(p);
    }
    const avgDevMm = (pxToMm > 0 && n > 0) ? Math.round((sum / n) * pxToMm * 10) / 10 : null;
    const maxDevMm = (pxToMm > 0) ? Math.round(maxDevPx * pxToMm * 10) / 10 : null;

    // --- 重ね合わせ結果画像（現物 + 位置合わせ済み図面輪郭 + 許容超え点）---
    const overlayCanvas = renderOverlay(o.photo, o.productBox, photoScale, best.moved, overTol);

    // --- 総合判定 ---
    const verdict = decideVerdict(matchPct, maxDevMm, tolMm);
    cleanup();
    return {
      ok: true,
      matchPct,
      maxDevMm,
      avgDevMm,
      verdict,
      overlayCanvas,
      reason: `IoU一致率 ${matchPct}%・最大ズレ ${maxDevMm ?? '—'}mm（許容±${tolMm}mm）`,
    };
  } catch (e) {
    cleanup();
    return failResult('CV処理エラー: ' + (e?.message || e));
  }
}

function decideVerdict(matchPct, maxDevMm, tolMm) {
  // 一致率と最大ズレの両面で判定。閾値は現場で調整可能。
  if (matchPct >= 85 && (maxDevMm == null || maxDevMm <= tolMm)) return 'match';
  if (matchPct < 60) return 'mismatch';
  return 'uncertain';
}

function failResult(reason) {
  return { ok: false, matchPct: null, maxDevMm: null, avgDevMm: null, verdict: 'uncertain', overlayCanvas: null, reason };
}

// ---------------------------------------------------------------------------
// 描画ヘルパ
// ---------------------------------------------------------------------------

/** 正規化bboxで元画像を切り出した canvas を返す。 */
function cropToBox(src, box) {
  const w = src.naturalWidth || src.videoWidth || src.width;
  const h = src.naturalHeight || src.videoHeight || src.height;
  const sx = Math.max(0, Math.round(box.x * w));
  const sy = Math.max(0, Math.round(box.y * h));
  const sw = Math.min(w - sx, Math.round(box.w * w));
  const sh = Math.min(h - sy, Math.round(box.h * h));
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

/** Mat に点列の折れ線を描く（color はグレースケール値）。 */
function drawPolyline(cv, mat, pts, color) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    cv.line(mat, new cv.Point(Math.round(a.x), Math.round(a.y)),
      new cv.Point(Math.round(b.x), Math.round(b.y)), new cv.Scalar(color), 2);
  }
}

/** 現物写真の上に、位置合わせ済み図面輪郭(処理px座標)を重ねた結果 canvas を返す。 */
function renderOverlay(photo, productBox, photoScale, movedPts, overTolPts) {
  const baseW = photo.naturalWidth || photo.videoWidth || photo.width;
  const baseH = photo.naturalHeight || photo.videoHeight || photo.height;
  const canvas = document.createElement('canvas');
  canvas.width = baseW; canvas.height = baseH;
  const g = canvas.getContext('2d');
  g.drawImage(photo, 0, 0, baseW, baseH);

  // 処理px → 元px へ戻す変換（切り出し時はオフセットも戻す）
  const offX = productBox ? productBox.x * baseW : 0;
  const offY = productBox ? productBox.y * baseH : 0;
  const inv = photoScale > 0 ? 1 / photoScale : 1;
  const map = (p) => ({ x: offX + p.x * inv, y: offY + p.y * inv });

  // 図面輪郭（半透明グリーン）
  g.lineWidth = Math.max(2, baseW / 400);
  g.strokeStyle = 'rgba(0, 200, 80, 0.9)';
  g.beginPath();
  movedPts.forEach((p, i) => { const q = map(p); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
  g.closePath();
  g.stroke();

  // 許容超えの点（赤マーカー）
  g.fillStyle = 'rgba(230, 30, 30, 0.9)';
  const r = Math.max(3, baseW / 250);
  for (const p of overTolPts) {
    const q = map(p);
    g.beginPath(); g.arc(q.x, q.y, r, 0, Math.PI * 2); g.fill();
  }
  return canvas;
}
