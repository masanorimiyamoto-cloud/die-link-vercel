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
│   │   ├── die-overlay-match.js   ★新規：CV計算エンジン（前処理＋位置合わせ＋IoU＋mm＋描画）
│   │   └── scan-spec-google.js    ◇要編集：旧オーバーレイUIを撤去し新方式を結線
│   └── scan-spec-google.html      ◇要編集：半透明オーバーレイ用DOM/操作の撤去
└── docs/die-match-newmethod.md    ★このファイル
```

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
5. **mmズレ** = 現物輪郭の距離変換(`distanceTransform`)を作り、位置合わせ済み図面輪郭点でサンプル → px を `pxPerMmVideo` で mm 換算（最大・平均）
6. **重ね合わせ画像** = 現物写真 + 位置合わせ済み図面輪郭（半透明グリーン）+ 許容超え点（赤）を canvas 描画
7. **総合判定** = 一致率と最大ズレの両面（`decideVerdict` の閾値は現場で調整）

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

- `decideVerdict` の閾値（既定 match: IoU≥85% かつ maxDev≤許容）
- `extractPhotoContour` の Canny 閾値(60,160)・カーネルサイズ … 素材/照明で要調整
- `maxSide`（既定1024）… 大きいほど精度↑/速度↓
- 図面が線画でなく寸法線・枠つきの場合、最大輪郭が枠を拾うことがある → 図面側は枠を除いた `-zu` の用意が理想

## テスト

ローカルCVは**ブラウザ実機**でのみ動作（OpenCV.js/WASM）。
`npm run dev`（vercel dev）で起動し、品番スキャン → CAL-50セット → 撮影 → 結果を確認。
照明・距離・角度・裏表のサンプルで閾値を調整すること。
```
