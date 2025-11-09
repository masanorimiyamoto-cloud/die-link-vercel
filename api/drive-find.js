// api/drive-find.js
// Google Drive の指定フォルダ内でファイル名一致検索 → fileId を返す
// 必須: GOOGLE_SA_JSON（Vercel環境変数に設定済み）
// 使用例: /api/drive-find?book=Ta&wc=9892&dev=1
export const config = { runtime: 'edge' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function bytesToBase64Url(b){let s='';for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'')}
function utf8ToBase64Url(s){return bytesToBase64Url(new TextEncoder().encode(s))}
function pemToArrayBuffer(pem){const b64=pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'');const raw=atob(b64);const buf=new ArrayBuffer(raw.length);const v=new Uint8Array(buf);for(let i=0;i<raw.length;i++)v[i]=raw.charCodeAt(i);return buf}

async function getGoogleAccessToken(){
  const SA_JSON = process.env.GOOGLE_SA_JSON || '';
  if(!SA_JSON) throw new Error('GOOGLE_SA_JSON missing');
  const svc = JSON.parse(SA_JSON);
  const header = utf8ToBase64Url('{"alg":"RS256","typ":"JWT"}');
  const now = Math.floor(Date.now()/1000);
  const payload = utf8ToBase64Url(JSON.stringify({
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now+3600
  }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(svc.private_key), {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:jwt})
  });
  if(!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

export default async function handler(req){
  if(req.method!=='GET') return json({ok:false,error:'Method Not Allowed'},405);
  try{
    const u = new URL(req.url);
    const book = (u.searchParams.get('book')||'').trim();
    const wc   = (u.searchParams.get('wc')||'').trim();
    if(!book || !wc) return json({ok:false,error:'need book & wc'},400);

    const folderId = '1KHoZRxD0vuiwNBJpU5jF0Up9kXxpsLz0';
    const fileName = `${book}-${wc}.png`;
    const token = await getGoogleAccessToken();

    const query = encodeURIComponent(`name='${fileName}' and '${folderId}' in parents and trashed=false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType)`;
    const r = await fetch(url, { headers:{ Authorization:`Bearer ${token}` }});
    if(!r.ok) throw new Error(`drive ${r.status} ${await r.text()}`);
    const j = await r.json();
    const file = (j.files && j.files[0]) || null;
    if(!file) return json({ok:false,found:0,fileId:null,fileName});
    return json({ok:true,found:j.files.length,fileId:file.id,fileName:file.name});
  }catch(e){
    return json({ok:false,error:String(e?.message||e)});
  }
}
