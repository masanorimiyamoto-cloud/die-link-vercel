> **【2026-06 更新】OpenCV.js は廃止**しました。iOS Safari でフル版 OpenCV.js（7MBインライン
> WASM）の初期化がタブごとメモリ killされ、撮影前にクラッシュするため。輪郭抽出・自動位置合わせ・
> 一致率(IoU)・mmズレ・重ね合わせ画像はすべて **素のJS + Canvas** で実装し直しています
> （`public/js/die-overlay-match.js`。480pxに縮小して純CPUで計算）。Web Worker版
> `die-overlay-worker.js` と `opencv.js` は削除済み。以下の本文中の「OpenCV.js / Web Worker」
> の記述は歴史的経緯として残しますが、実装は純JS版が正です。AI補助(`die-align-verify`)は継続。

# 抜型照合 新方式（ハイブリッド：クライアントCV主＋AI補助）

半透明の手動オーバーレイ目視と box-shape-match の純AI判定を**撤去**し、
「**撮影 → 自動位置合わせ → 一致率(%)・ズレ量(mm)・重ね合わせ画像**」へ一本化する。

## なぜハイブリッドか（重要な前提）

画像LLM（Claude / GPT）は **画像を生成できず、ピクセル精度の位置合わせや mm 単位のズレ量も苦手**。
これは旧方式②の弱点そのもの。したがって役割を分離する：

| 処理 | 担当 | 理由 |
|---|---|---|
| 輪郭抽出・自動位置合わせ・一致率(IoU)・mmズレ・重ね合わせ画像描画 | **クライアントCV**（OpenCV.js） | 幾何計算は決定論的。CAL-50 の px/mm で実 mm が出せる |
| 「同一品番の形状か」の意味照合・CV失敗時のフォールバック | **AI**（_vision 経由） | 線画⇄実物の意味的な対応付けはLLMが得意 |

mm 換算の鍵は既存の **CAL-50（QR・1辺50mm）校正**で得る `pxPerMmVideo`。
> **【2026-07 更新／一旦無効化】実寸(W×H)のホモグラフィ補正**。CAL-50 の4隅から「画像→mm平面」の
> 射影変換を組み、現物輪郭を mm 平面へレクトファイしてから最小外接矩形で外寸を測る仕組み
> （`measureAndCompareDimensions` に `homography` を渡す経路）を実装した。理論上は傾き（10°で
> 十数mm）を直接補正できるが、**小さいCAL-50単体では現物へ外挿する際に隅の数pxノイズが
> 非線形に増幅し、等方スケール法より悪化する（実機で数倍の誤差）**ため、`scan-spec-google.js`
> からの `calQuad` 供給を停止して無効化した。`die-overlay-match.js` 側のホモグラフィ実装は
> 残置（`calQuad` 未指定なら不使用＝従来の `pxPerMm` 等方換算にフォールバック）。
> **再有効化の前提：大きい基準（CAL-100 等）または現物を挟む二点マーカーで外挿距離を縮めること。**
> 加えて、ホモグラフィ結果が等方スケール推定と大きく食い違う場合に破棄するサニティ・フォール
> バックを併設すること。輪郭ズレ(参考値)は従来どおり `pxPerMm` で算出。

## ディレクトリ構成（追加・変更）

```
die-link-vercel/
├── api/
│   ├── _vision.js                 （既存・変更なし：Claude/GPT 切替層）
│   ├── die-align-verify.js        ★新規：AI補助（意味照合＋CV値の講評）。Edge
│   ├── box-shape-match.js         ☆撤去対象（新方式へ統合後に削除可）
│   └── box-detect.js              （継続利用：現物bbox。CVの切り出し精度UPに使う）
├── public/
│   ├── js/
│   │   ├── die-overlay-match.js   ★メイン側コントローラ：画像縮小→Workerへ依頼→重ね合わせ描画
│   │   ├── die-overlay-worker.js  ★Web Worker：OpenCV.jsで輪郭抽出＋位置合わせ＋IoU＋mm（別スレッド）
│   │   └── scan-spec-google.js    ◇要編集：旧オーバーレイUIを撤去し新方式を結線
│   └── scan-spec-google.html      ◇要編集：半透明オーバーレイ用DOM/操作の撤去
└── docs/die-match-newmethod.md    ★このファイル
```

## なぜ Web Worker か（UIを固めないため）

OpenCV.js は同期WASMで重く、メインスレッドで動かすと**UIが固まる**（実機で発生）。さらに
高解像度図面を縮小前に丸ごと読み込むとメモリ枯渇でフリーズする。対策として:

- **CVは Web Worker（別スレッド）で実行** → 画面は常に応答可能。OpenCV.jsの巨大DLもworker内
- **ハードタイムアウト**（既定: 計算20秒／初回DL95秒）で `worker.terminate()` → 詰まっても確実に中断
- **画像は読み込む前に必ず縮小**（`maxSide` 既定800px）してから Worker へ ImageData を転送
- Worker は計算だけ行い、輪郭点列を返す。**重ね合わせ画像はメイン側で canvas 描画**（DOM不要化）

## 環境変数（既存のまま・追加不要）

- `GOOGLE_SA_JSON` … Drive 読み取り用サービスアカウント
- `GDRIVE_DIE_MASTER_ID` … 図面フォルダ（`{book}-{wc}-zu.(jpg|png)` 等）
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` … AI補助（die-align-verify）用

## 使用AIモデル

`api/_vision.js` の `MODELS` を流用：
- `claude-opus-4-8`（既定・推奨）
- `gpt-5.5`

新方式ではAIは**意味照合のみ**なので、既定の Claude Opus 4.8 で十分。
クライアントから `model` を渡せばユーザー選択を引き継げる。

## 前処理（die-overlay-match.js 内）

- **図面(-zu 線画)**：グレースケール → Otsu二値化(反転) → モルフォロジ閉処理で線の途切れを補修 → 最大外側輪郭
- **現物の静止画**：グレースケール → ガウシアン平滑化 → Canny エッジ → 閉処理＋膨張 → 最大外側輪郭
- **任意の高精度化**：`box-detect` の正規化bbox で現物を切り出してから輪郭抽出すると背景ノイズを除去できる

## 位置合わせ・計測ロジック

1. 図面/現物それぞれ最大外側輪郭を抽出
2. `minAreaRect` で相似変換（中心・スケール・角度）を初期化
3. **回転 0/90/180/270 × 反転** を総当たりし、**IoU 最大**の重なりを採用（撮影の裏表・回転を吸収）
4. **一致率(%)** = 採用時の IoU
5. **mmズレ** = 現物輪郭の距離変換(`distanceTransform`)を作り、位置合わせ済み図面輪郭点でサンプル → px を `pxPerMmVideo` で mm 換算（P95＝上位5%の外れ値除外・平均）。単純最大値は影や位置合わせ残差の1点で跳ね上がるため参考値扱い
6. **重ね合わせ画像** = 現物写真 + 位置合わせ済み図面輪郭（半透明グリーン）+ 許容超え点（赤）を canvas 描画
7. **総合判定** = 実寸判定を主とする（`combineVerdicts`）。実寸不一致→不一致。実寸一致かつ IoU≥70% →一致（輪郭ズレでは棄却しない）。実寸判定不可（CAL-50なし等）のときのみ形状判定（`decideVerdict`: IoU≥85% かつ ズレ≤許容で一致）に従う

## API設計

### POST `/api/die-align-verify`（新規・AI補助）
リクエスト（JSON, 同一オリジン＋CSRF必須／localhostは免除）：
```json
{ "book": "A-123", "wc": "45", "image": "data:image/jpeg;base64,...",
  "model": "claude-opus-4-8",
  "cv": { "matchPct": 88.5, "maxDevMm": 7.2, "avgDevMm": 2.1 } }
```
レスポンス：
```json
{ "ok": true, "found": true, "refFileName": "A-123-45-zu.png",
  "verdict": "match", "confidence": 90, "reason": "外形とフラップ配置が一致…" }
```
`cv` は任意。渡すとAIが計測値の妥当性も踏まえて講評する。

### POST `/api/box-detect`（既存・継続）
現物bbox（CVの切り出しに使用）。変更なし。

### `/api/drive-proxy?id=...`（既存・継続）
クライアントCVは図面画素が必要。`S.drawingId` を使い drive-proxy 経由で取得（CSRFヘッダ付き）。
※ 既に `loadBoxDrawing()` が `D.boxOverlay.src` に図面blobを読み込み済みなので、その img をCVの図面入力に流用できる。

## scan-spec-google.js への結線（ドロップイン）

`aiAllInOne()` の **抜型(非生地)パス**を、AI形状判定（box-shape-match）から
クライアントCV＋AI補助に差し替える。下記を関数として追加し、抜型パスから呼ぶ：

```js
import { matchDieOverlay } from './die-overlay-match.js';

// 現物の静止画(Image)を frame.dataUrl から生成
function frameToImage(frame){
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('静止画の生成に失敗'));
    im.src = frame.dataUrl;
  });
}

// 新方式：撮影→自動位置合わせ→一致率/ズレ/重ね合わせ画像→AI補助
async function runDieOverlayMatch(frame){
  const photo = await frameToImage(frame);

  // 図面：既存 loadBoxDrawing() が読み込んだ D.boxOverlay(img) を流用
  if(!S.drawingReady || !D.boxOverlay.naturalWidth){
    throw new Error('登録図面が読み込めていません');
  }

  // 任意：box-detect で現物bboxを取り背景を除外（失敗しても続行）
  let productBox = null;
  try { productBox = await aiDetectBox(frame); } catch {}

  // CVで自動位置合わせ・計測・重ね合わせ画像
  const cv = await matchDieOverlay({
    photo,
    drawing: D.boxOverlay,
    pxPerMm: S.pxPerMmVideo,           // CAL-50校正済みのとき>0。未校正ならmmはnull
    productBox: productBox || undefined,
    tolMm: S.tolMm || 10,
  });

  // AI補助（同一品番かの意味照合）。CV値も渡して講評させる
  let ai = null;
  try {
    ai = await aiImageMatch('/api/die-align-verify', frame, {
      cv: { matchPct: cv.matchPct, maxDevMm: cv.maxDevMm, avgDevMm: cv.avgDevMm }
    });
  } catch (e) { ai = { _err: String(e.message||e) }; }

  renderDieOverlayResult(cv, ai);
}

// 結果表示：重ね合わせ画像＋数値＋AI講評
function renderDieOverlayResult(cv, ai){
  const box = D.boxResult;
  const verdictColor = cv.verdict==='match' ? '#0a0' : cv.verdict==='mismatch' ? '#c00' : '#c80';
  const aiLine = ai && !ai._err
    ? `AI(${esc(ai.verdict||'')} ${ai.confidence??''}％)：${esc(ai.reason||'')}`
    : `AI補助：${ai && ai._err ? '失敗（'+esc(ai._err)+'）' : '—'}`;
  box.innerHTML = `
    <div style="font-weight:700;color:${verdictColor}">
      一致率 ${cv.matchPct ?? '—'}％ ／ 最大ズレ ${cv.maxDevMm ?? '—'}mm（許容±${S.tolMm||10}mm）
    </div>
    <div style="margin:6px 0;color:#555">${esc(cv.reason||'')}</div>
    <div style="margin:6px 0;color:#555">${aiLine}</div>
    <div id="dieOverlayHost" style="margin-top:8px"></div>`;
  box.style.display = 'block';
  if(cv.overlayCanvas){
    cv.overlayCanvas.style.maxWidth = '100%';
    cv.overlayCanvas.style.borderRadius = '8px';
    document.getElementById('dieOverlayHost').appendChild(cv.overlayCanvas);
  }
  const main = cv.verdict==='match' ? 'OK 一致' : cv.verdict==='mismatch' ? 'NG 不一致' : '要確認';
  showVerdict(cv.verdict==='match'?'ok':cv.verdict==='mismatch'?'ng':'warn',
    main, `一致率 ${cv.matchPct ?? '—'}％`);
}
```

`aiImageMatch` は第3引数で追加ボディを受けられるよう小改修：
```js
async function aiImageMatch(endpoint, frame, extra){
  // ...既存...
  body: JSON.stringify(Object.assign(
    { image: frame.dataUrl, book: S.current.book, wc: S.current.wc, model: S.aiModel },
    extra || {})),
  // ...
}
```

`aiAllInOne()` の抜型パス（生地でない場合）を差し替え：
```js
// 旧: const pAppr = aiShapeDetect(frame)...; ...; renderCombined(dim, a.v, a.err, apprLabel);
// 新:
await runDieOverlayMatch(frame);
return;
```

## 撤去（旧方式）

新方式が安定したら以下を削除：
- `api/box-shape-match.js`
- `scan-spec-google.js`：`applyOverlaySize` / `centerOverlay` / 半透明オーバーレイのドラッグ操作 / `aiShapeDetect`
- `scan-spec-google.html`：`#boxOverlay`（半透明img）と関連操作UI、不透明度スライダ等

`loadBoxDrawing()` は**残す**（新方式が図面画素をCV入力に使うため）。`D.boxOverlay` は
画面表示用ではなく「CVに渡す図面ソース」として `position:absolute; opacity:0` 等で隠して保持してよい。

## 現場調整ポイント（die-overlay-match.js）

- `combineVerdicts` の閾値（実寸一致時は IoU≥70% で一致）／`decideVerdict` の閾値（実寸判定不可時: IoU≥85% かつ ズレ(P95)≤許容）
- `extractPhotoContour` の Canny 閾値(60,160)・カーネルサイズ … 素材/照明で要調整
- `maxSide`（既定1024）… 大きいほど精度↑/速度↓
- 図面が線画でなく寸法線・枠つきの場合、最大輪郭が枠を拾うことがある → 図面側は枠を除いた `-zu` の用意が理想

## テスト

OpenCV.js の取得元は `docs.opencv.org/4.x/opencv.js`（主）＋ jsDelivr（予備）で、片方が落ちても
フォールバックする。`docs.opencv.org/<バージョン>/opencv.js`（例 4.10.0）は存在しない（404）ので使わない。

ローカルCVは**ブラウザ実機**でのみ動作（OpenCV.js/WASM）。
`npm run dev`（vercel dev）で起動し、品番スキャン → CAL-50セット → 撮影 → 結果を確認。
照明・距離・角度・裏表のサンプルで閾値を調整すること。
```
