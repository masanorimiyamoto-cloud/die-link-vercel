export const config = { runtime: 'edge' };

/* 必須: 環境変数
   - GOOGLE_SA_JSON     : サービスアカウント JSON 全文
   - （任意）CSRF/同一オリジン検査を使いたければ die-check の関数を流用してもOK
*/

function parseCookies(req){
  const h = req.headers.get('cookie') || '';
  const out = {};
  h.split(';').forEach(kv=>{
    const [k, ...vs] = kv.split('=');
    if(!k) return;
    out[k.trim()] = decodeURIComponent((vs.join('=')||'').trim());
  });
  return out;
}
function sameOrigin(req){
  const self = new URL(req.url).origin;
  const origin  = req.headers.get('origin')  || '';
  const referer = req.headers.get('referer') || '';
  return (origin.startsWith(self) || referer.startsWith(self));
}
function bytesToBase64Url(bytes){
  let bin=''; for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
function utf8ToBase64Url(str){
  return bytesToBase64Url(new TextEncoder().encode(str));
}
function pemToArrayBuffer(pem){
  const b64 = pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for(let i=0;i<raw.length;i++) view[i]=raw.charCodeAt(i);
  return buf;
}
async function getGoogleAccessToken(){
  const SA = process.env.GOOGLE_SA_JSON;
  if(!SA) throw new Error('GOOGLE_SA_JSON missing');
  const svc = JSON.parse(SA);
  const email = svc.client_email;
  const keyPem = svc.private_key;
  const now = Math.floor(Date.now()/1000);
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const headerB64 = utf8ToBase64Url('{"alg":"RS256","typ":"JWT"}');
  const payloadB64 = utf8ToBase64Url(JSON.stringify(claim));
  const unsigned = `${headerB64}.${payloadB64}`;
  const pkcs8 = pemToArrayBuffer(keyPem);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'content-type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:jwt })
  });
  if(!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

export default async function handler(req){
  try{
    if(req.method !== 'GET') return new Response('Method Not Allowed', { status:405 });
    // できれば CSRF/同一オリジンチェック（必要なければ外してOK）
    if(!sameOrigin(req)) return new Response('Forbidden', { status:403 });
    const cookies = parseCookies(req);
    const csrf = cookies['xcsrf'] || '';
    const hdr = req.headers.get('x-csrf') || '';
    if(!csrf || !hdr || csrf !== hdr) return new Response('CSRF fail', { status:403 });

    const u = new URL(req.url);
    const id   = (u.searchParams.get('id') || '').trim();
    const name = (u.searchParams.get('name') || 'drawing').replace(/[^\w.\- ()\[\]]/g,'_');
    if(!id) return new Response('no id', { status:400 });

    const token = await getGoogleAccessToken();

    // メタ情報（Content-Type, size 取得）
    const metaR = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if(!metaR.ok) return new Response(`meta ${metaR.status} ${await metaR.text()}`, { status:502 });
    const meta = await metaR.json();
    const mime = meta.mimeType || 'application/octet-stream';

    // 本体
    const fileR = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if(!fileR.ok) return new Response(`media ${fileR.status} ${await fileR.text()}`, { status:502 });

    const headers = new Headers({
      'content-type': mime,
      'content-disposition': `inline; filename="${encodeURIComponent(name)}"`,
      'cache-control': 'private, max-age=60'
    });
    return new Response(fileR.body, { status:200, headers });
  }catch(e){
    return new Response(`proxy error: ${e?.message||e}`, { status:500, headers:{ 'content-type':'text/plain; charset=utf-8' } });
  }
}
