// api/box-detect.js
// 撮影画像から「抜き製品（段ボール/紙の半製品）」の外接矩形を Claude ビジョンで推定し、
// 正規化座標(0..1)で返す。クライアントはこれをメジャー枠の初期位置に使う。
import { callVisionJSON } from './_vision.js';
export const config = { runtime: 'edge' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ---------- セキュリティ（material-match.js と同方式） ---------- */
function parseCookies(req) {
  const h = req.headers.get('cookie') || ''; const o = {};
  h.split(';').forEach(kv => { const [k, ...vs] = kv.split('='); if (!k) return; o[k.trim()] = decodeURIComponent((vs.join('=') || '').trim()); });
  return o;
}
function sameOrigin(req) {
  const self = new URL(req.url).origin;
  const origin = req.headers.get('origin') || '';
  const referer = req.headers.get('referer') || '';
  return origin.startsWith(self) || referer.startsWith(self);
}

const DETECT_PROMPT = `この画像には、机などの上に置かれた「抜き製品（展開された段ボール／紙の箱の半製品。フラップや耳が外側に張り出した平らな形状）」が1つと、小さな正方形のQRコード（基準マーカー。製品ではない）が写っています。

タスク: 抜き製品「本体1つ」の外接矩形（最も外側の張り出し・耳まで含む、画像に平行な長方形の枠）を求めてください。

ルール:
- QRコード（基準マーカー）や、机・背景・影・他の物体は枠に含めないこと。製品そのものだけを囲む。
- 製品が一部しか写っていない／見つからない場合は found=false。
- 座標は画像全体に対する正規化値（左上が0,0 / 右下が1,1）。x,y は枠の左上、w,h は幅・高さ。すべて0〜1の小数。

次のJSONオブジェクト「のみ」を出力（前後に文章やマークダウンを付けない）:
{"found":true,"box":{"x":0.0,"y":0.0,"w":0.0,"h":0.0},"confidence":0〜100の整数}
見つからない場合: {"found":false}`;

function clamp01(v) { v = Number(v); if (!Number.isFinite(v)) return 0; return Math.max(0, Math.min(1, v)); }

export default async function handler(req) {
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);

    const u = new URL(req.url);
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.hostname);
    if (!isLocal) {
      if (!sameOrigin(req)) return json({ ok: false, error: 'Origin/Referer mismatch' }, 403);
      const cookies = parseCookies(req);
      const cookie = cookies['xcsrf'] || '';
      const header = req.headers.get('x-csrf') || '';
      if (!cookie || !header || cookie !== header) return json({ ok: false, error: 'CSRF invalid' }, 403);
    }

    const payload = await req.json().catch(() => ({}));
    const image = payload.image || '';
    if (!image) return json({ ok: false, error: 'missing image' }, 400);

    let capMime = 'image/jpeg', capData = image;
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(image);
    if (m) { capMime = m[1]; capData = m[2]; }

    const result = await callVisionJSON({
      modelKey: payload.model,
      parts: [
        { image: { mime: capMime, data: capData } },
        { text: DETECT_PROMPT },
      ],
      maxTokens: 512,
    });
    if (!result || result.found !== true || !result.box) {
      return json({ ok: true, found: false });
    }
    const b = result.box;
    const box = { x: clamp01(b.x), y: clamp01(b.y), w: clamp01(b.w), h: clamp01(b.h) };
    // 枠が画像外にはみ出す場合は内側にクランプ
    if (box.x + box.w > 1) box.w = 1 - box.x;
    if (box.y + box.h > 1) box.h = 1 - box.y;
    if (box.w <= 0.01 || box.h <= 0.01) return json({ ok: true, found: false });

    return json({ ok: true, found: true, box, confidence: result.confidence ?? null });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
