// api/drive-thumb.js
export const config = { runtime: 'edge' };

function bytesToBase64Url(bytes){ let b=''; for(let i=0;i<bytes.length;i++) b+=String.fromCharCode(bytes[i]); return btoa(b).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'') }
function utf8ToBase64Url(s){ return bytesToBase64Url(new TextEncoder().encode(s)) }
function pemToArrayBuffer(pem){ const b64=pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,''); const raw=atob(b64); const buf=new ArrayBuffer(raw.length); const v=new Uint8Array(buf); for(let i=0;i<raw.length;i++) v[i]=raw.charCodeAt(i); return buf }

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
    'pkcs8', pemToArrayBuffer(svc.private_key),
    { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-V1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'content-type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  if(!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

export default async function handler(req){
  try{
    const u = new URL(req.url);
    const id = (u.searchParams.get('id') || '').trim();
    if(!id) return new Response('missing id', { status:400 });

    const token = await getGoogleAccessToken();

    // 画像そのもの（バイナリ）を取得
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
    const r = await fetch(url, { headers:{ Authorization:`Bearer ${token}` } });
    if(!r.ok){
      return new Response(`drive media ${r.status}`, { status: r.status });
    }

    // そのまま返す（Content-Type を引き継ぐ）
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    return new Response(r.body, {
      status: 200,
      headers:{
        'content-type': ct,
        // 強制的にキャッシュさせない（端末差回避）
        'cache-control': 'no-store, max-age=0',
      }
    });
  }catch(e){
    return new Response(String(e?.message||e), { status:500 });
  }
}
