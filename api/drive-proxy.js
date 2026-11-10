// api/drive-proxy.js
import { requireUser } from './_auth.js';
export const config = { runtime: 'edge' };

/* ========== utils ========== */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function bytesToBase64Url(bytes){
  let s = '';
  for (let i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
function utf8ToBase64Url(s){ return bytesToBase64Url(new TextEncoder().encode(s)); }
function pemToArrayBuffer(pem){
  const b64 = pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const v = new Uint8Array(buf);
  for (let i=0;i<raw.length;i++) v[i] = raw.charCodeAt(i);
  return buf;
}

/* ========== Google OAuth (SA) ========== */
async function getGoogleAccessToken(){
  const SA_JSON = process.env.GOOGLE_SA_JSON || '';
  if (!SA_JSON) throw new Error('GOOGLE_SA_JSON is missing');
  const svc = JSON.parse(SA_JSON);

  const header = utf8ToBase64Url('{"alg":"RS256","typ":"JWT"}');
  const now = Math.floor(Date.now()/1000);
  const payload = utf8ToBase64Url(JSON.stringify({
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(svc.private_key),
    { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'content-type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

/* ========== Handler ========== */
export default async function handler(req){
  try{
    if (req.method !== 'GET'){
      return json({ ok:false, error:'Method Not Allowed' }, 405);
    }

    const u    = new URL(req.url);
    const id   = (u.searchParams.get('id') || '').trim();
    const name = (u.searchParams.get('name') || 'download.bin').trim().replace(/"/g,'');

    if (!id) return json({ ok:false, error:'missing id' }, 400);

    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.hostname);
    // ログイン必須（2026-11-10）。読むだけの GET なので CSRF の確認はやめ、ログインで守る
    // （ログインの Cookie は SameSite=Lax なので、他のサイトに埋め込まれた画像・iframe には付かない）。
    // X-CSRF ヘッダを要求していたころは、ヘッダを付けられない iframe（PDF の図面）が必ず 403 になっていた。
    // 以前は ?dev=1 を付けると本番でも検証を飛ばせた。省くのはローカルだけにする
    if (!isLocal) {
      const auth = await requireUser(req);
      if (auth.deny) return auth.deny;
    }

    const token = await getGoogleAccessToken();

    // ★ キャッシュ回避用にダミー query を付ける
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&ts=${Date.now()}`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      // 念のため
      cache: 'no-store'
    });

    if (!r.ok) {
      const detail = await r.text().catch(()=> '');
      return json(
        { ok:false, error:`drive ${r.status}`, detail: detail.slice(0,500) },
        r.status
      );
    }

    // レスポンスヘッダ整備
    const headers = new Headers();
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    headers.set('content-type', ct);
    headers.set('content-disposition', `inline; filename="${name}"`);

    // ★ ブラウザ / 中間キャッシュに保存させない
    headers.set('cache-control', 'no-store, max-age=0');
    headers.set('pragma', 'no-cache');

    headers.set('referrer-policy', 'no-referrer');
    headers.set('cross-origin-resource-policy', 'same-origin');

    return new Response(r.body, { status: 200, headers });
  }catch(e){
    return json({ ok:false, error: String(e?.message || e) }, 500);
  }
}
