// api/drive-find.js  ← ルート直下の api/ 配下（Edge/NodeどちらでもOKな純JS）
export const config = { runtime: 'edge' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

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
    const book = (u.searchParams.get('book')||'').trim();
    const wc   = (u.searchParams.get('wc')||'').trim();
    const folderId = (process.env.GDRIVE_DIE_MASTER_ID || '').trim(); // 例: 1KHoZRxD0vuiwNBJpU5jF0Up9kXxpsLz0
    if(!book || !wc) return json({ ok:false, error:'missing book/wc' }, 400);
    if(!folderId) return json({ ok:false, error:'GDRIVE_DIE_MASTER_ID is missing' }, 500);

    const base = `${book}-${wc}`;
    const nameRegex = new RegExp(`^${base}\\.(png|jpg|jpeg|pdf)$`, 'i');

    const token = await getGoogleAccessToken();

    // Drive v3: list in folder
    const q = [
      `'${folderId}' in parents`,
      'trashed = false'
    ].join(' and ');

    const listUrl = `https://www.googleapis.com/drive/v3/files?` + new URLSearchParams({
      q, pageSize: '1000', fields: 'files(id,name,mimeType,modifiedTime,size)'
    });

    const r = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    if(!r.ok) return json({ ok:false, error:`drive list ${r.status}`, detail: (await r.text()).slice(0,300) }, r.status);
    const j = await r.json();
    const all = Array.isArray(j.files) ? j.files : [];

    // 候補抽出
    const candidates = all
      .filter(f => nameRegex.test(f.name||''))
      .map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType || '', modifiedTime: f.modifiedTime || '', size: f.size || '' }));

    if(candidates.length === 0){
      return json({ ok:true, found:0, candidates:[] });
    }

    // 優先順位: jpeg > jpg > png > pdf
    const pri = (name) => {
      const n = name.toLowerCase();
      if(n.endsWith('.jpeg')) return 1;
      if(n.endsWith('.jpg'))  return 2;
      if(n.endsWith('.png'))  return 3;
      if(n.endsWith('.pdf'))  return 9;
      return 99;
    };
    candidates.sort((a,b)=> pri(a.name)-pri(b.name));

    const primary = candidates[0];

    // 後方互換のため fileId/fileName も返す
    return json({
      ok: true,
      found: candidates.length,
      fileId: primary.id,
      fileName: primary.name,
      candidates
    });
  }catch(e){
    return json({ ok:false, error: String(e?.message||e) }, 500);
  }
}
