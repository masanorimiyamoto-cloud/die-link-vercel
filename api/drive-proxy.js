// api/drive-proxy.js
export const config = { runtime: 'edge' };

/* ========== utils ========== */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function parseCookies(req){
  const h = req.headers.get('cookie') || '';
  const o = {};
  h.split(';').forEach(kv => {
    const [k, ...vs] = kv.split('=');
    if (!k) return;
    o[k.trim()] = decodeURIComponent((vs.join('=') || '').trim());
  });
  return o;
}
function sameOrigin(req){
  const self    = new URL(req.url).origin;
  const origin  = req.headers.get('origin')  || '';
  const referer = req.headers.get('referer') || '';
  return origin.startsWith(self) || referer.startsWith(self);
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
    const dev  = u.searchParams.get('dev') === '1';
    const id   = (u.searchParams.get('id') || '').trim();
    const name = (u.searchParams.get('name') || 'download.bin').trim().replace(/"/g,'');

    if (!id) return json({ ok:false, error:'missing id' }, 400);

    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.hostname);
    if (!isLocal && !dev) {
      if (!sameOrigin(req)) {
        return json({ ok:false, error:'Origin/Referer mismatch' }, 403);
      }
      const cookies = parseCookies(req);
      const cookie = cookies['xcsrf'] || '';
      const header = req.headers.get('x-csrf') || '';
      if (!cookie || !header || cookie !== header) {
        return json({ ok:false, error:'CSRF invalid' }, 403);
      }
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
