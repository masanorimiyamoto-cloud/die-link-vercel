// api/drive-thumb.js
// Google Drive ファイル（画像）を Service Account で取得して、そのまま返す（Edge Runtime）
// 目的：ブラウザ/端末差・Google thumbnail/uc の癖・CDNキャッシュを避けて安定サムネ表示

export const config = { runtime: 'edge' };

// ---- JWT helpers (Drive-find と同じ) ----
function bytesToBase64Url(bytes){
  let b = '';
  for(let i=0;i<bytes.length;i++) b += String.fromCharCode(bytes[i]);
  return btoa(b).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
function utf8ToBase64Url(s){
  return bytesToBase64Url(new TextEncoder().encode(s));
}
function pemToArrayBuffer(pem){
  const b64 = pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const v = new Uint8Array(buf);
  for(let i=0;i<raw.length;i++) v[i] = raw.charCodeAt(i);
  return buf;
}

async function getGoogleAccessToken(){
  const SA_JSON = process.env.GOOGLE_SA_JSON || '';
  if(!SA_JSON) throw new Error('GOOGLE_SA_JSON is missing');
  const svc = JSON.parse(SA_JSON);

  const header = utf8ToBase64Url('{"alg":"RS256","typ":"JWT"}');
  const now = Math.floor(Date.now()/1000);
  const payload = utf8ToBase64Url(JSON.stringify({
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
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
    'RSASSA-PKCS1-V1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'content-type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  if(!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

function noCacheHeaders(contentType){
  return {
    'content-type': contentType || 'application/octet-stream',

    // Browser cache
    'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
    'pragma': 'no-cache',
    'expires': '0',

    // CDN / Edge cache（Vercel等で効きやすい）
    'cdn-cache-control': 'no-store',
    'surrogate-control': 'no-store',

    // 画像用途（安全側）
    'x-content-type-options': 'nosniff',
  };
}

export default async function handler(req){
  try{
    const u = new URL(req.url);
    const id = (u.searchParams.get('id') || '').trim();
    if(!id) return new Response('missing id', { status: 400 });

    // cb はキャッシュ回避用。サーバ側では使わない（受け取るだけ）
    // const cb = u.searchParams.get('cb') || '';

    const token = await getGoogleAccessToken();

    // 1) ファイル本体（バイナリ）を取得
    const mediaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
    const r = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });

    if(!r.ok){
      const detail = (await r.text()).slice(0, 300);
      return new Response(`drive media ${r.status}: ${detail}`, { status: r.status });
    }

    // ★重要：streamをそのまま返さず、一度arrayBufferにして確定（環境差対策）
    const buf = await r.arrayBuffer();
    const ct = r.headers.get('content-type') || 'application/octet-stream';

    return new Response(buf, {
      status: 200,
      headers: noCacheHeaders(ct),
    });

  }catch(e){
    return new Response(String(e?.message || e), { status: 500 });
  }
}
