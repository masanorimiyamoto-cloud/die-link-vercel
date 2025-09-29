// api/scan.js
export const config = { runtime: 'edge' };

const HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QRを読み取る</title>
<style>
  body{font-family:system-ui;margin:0;padding:16px;line-height:1.6}
  h1{font-size:20px;margin:0 0 8px}
  .btn{display:inline-block;background:#0a0;color:#fff;text-decoration:none;
       padding:10px 14px;border-radius:8px;border:none;cursor:pointer}
  .btn-alt{background:#f7f7f7;color:#222;border:1px solid #ccc}
  video{width:100%;border-radius:8px;background:#000}
  .wrap{max-width:720px;margin:0 auto}
  .msg{margin-bottom:8px}
  .err{color:#c00;margin-bottom:8px}
</style>
<div class="wrap">
  <h1>QRを読み取る</h1>
  <div id="err" class="err" hidden></div>
  <div id="msg" class="msg">カメラを初期化しています…</div>
  <video id="video" playsinline muted></video>
  <canvas id="canvas" hidden></canvas>
  <div style="margin-top:12px">
    <label for="pick" class="btn">カメラで読み取る（代替）</label>
    <input id="pick" type="file" accept="image/*" capture="environment" style="display:none">
    <button class="btn btn-alt" onclick="location.href='/'" style="margin-left:8px">トップへ</button>
  </div>
</div>
<script>
(async () => {
  const $ = sel => document.querySelector(sel);
  const video = $('#video');
  const canvas = $('#canvas');
  const msg = $('#msg');
  const errBox = $('#err');
  const supported = 'BarcodeDetector' in window;

  function showErr(t){ errBox.textContent=t; errBox.hidden=false; }
  function setMsg(t){ msg.textContent=t; }

  if (!supported) setMsg('下の「カメラで読み取る（代替）」をご利用ください。');

  let stream, rafId;
  async function start() {
    try {
      if (!supported) return;
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false
      });
      video.srcObject = stream;
      await video.play();
      setMsg('QRコードをかざしてください…');

      const ctx = canvas.getContext('2d');
      const tick = async () => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          try {
            const bitmap = await createImageBitmap(canvas);
            const codes = await detector.detect(bitmap);
            if (codes && codes.length) {
              const url = codes[0].rawValue;
              cleanup();
              location.href = url;
              return;
            }
          } catch(e) {}
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    } catch(e) {
      console.error(e);
      setMsg('');
      showErr('カメラにアクセスできませんでした。下の「カメラで読み取る（代替）」をご利用ください。');
    }
  }

  function cleanup(){
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach(t => t.stop());
  }

  // 画像からの読み取りは簡易対応（ライブラリ未同梱）
  $('#pick').addEventListener('change', ev => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    alert('端末のカメラアプリでQR→「ブラウザで開く」を推奨です。画像からのデコードが必要なら jsQR 等の導入をご相談ください。');
  });

  addEventListener('pagehide', cleanup);
  start();
})();
</script>`;

export default async function handler() {
  return new Response(HTML, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}
