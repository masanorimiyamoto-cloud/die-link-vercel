// api/drive-find.js
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

function normalizeWc(s){
  const t = String(s||'').trim();
  if(!t) return '';
  const num = Number(t);
  if(Number.isFinite(num) && Math.floor(num) === num) return String(num); // "6521"
  if(/\.0$/.test(t)){ return t.replace(/\.0$/,''); } // "6521.0" → "6521"
  return t;
}

export default async function handler(req){
  try{
    const u = new URL(req.url);
    const book = (u.searchParams.get('book')||'').trim();
    const wcRaw= (u.searchParams.get('wc')  ||'').trim();
    const wc   = normalizeWc(wcRaw);
    const folderId = (process.env.GDRIVE_DIE_MASTER_ID || '').trim();
    if(!book || !wc)   return json({ ok:false, error:'missing book/wc' }, 400);
    if(!folderId)      return json({ ok:false, error:'GDRIVE_DIE_MASTER_ID is missing' }, 500);

    // 新・旧 兼用のベース
    const base = `${book}-${wc}`.trim();

    // 命名規則に対応する判定関数
    const isNewZu = (name)=> new RegExp(`^${escapeRegex(base)}-zu\\.(?:jpeg|jpg|png)$`, 'i').test(name||'');
    const isNewSi = (name)=> new RegExp(`^${escapeRegex(base)}-si\\.(?:jpeg|jpg|png)$`, 'i').test(name||'');
    const isOldImg= (name)=> new RegExp(`^${escapeRegex(base)}\\.(?:jpeg|jpg|png)$`,      'i').test(name||'');
    const isPdf   = (name)=> new RegExp(`^${escapeRegex(base)}\\.pdf$`,                   'i').test(name||'');

    function escapeRegex(s){ return String(s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

    const token = await getGoogleAccessToken();

    const q = [`'${folderId}' in parents`, 'trashed = false'].join(' and ');
    const listUrl = `https://www.googleapis.com/drive/v3/files?` + new URLSearchParams({
      q, pageSize: '1000', fields: 'files(id,name,mimeType,modifiedTime,size)'
    });
    const r = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    if(!r.ok) return json({ ok:false, error:`drive list ${r.status}`, detail: (await r.text()).slice(0,300) }, r.status);
    const j = await r.json();
    const all = Array.isArray(j.files) ? j.files : [];

    // ヒット抽出（新・旧・PDF）
    const candidates = all
      .filter(f => {
        const name = f.name || '';
        return isNewZu(name) || isNewSi(name) || isOldImg(name) || isPdf(name);
      })
      .map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType || '', modifiedTime: f.modifiedTime || '', size: f.size || '' }));

    if(candidates.length === 0){
      return json({ ok:true, found:0, candidates:[] });
    }

    // 優先順：-zu画像 → -si画像 → 旧画像 → PDF
    const pri = (name) => {
      const n = (name||'').toLowerCase();
      if(isNewZu(n)) return 1;
      if(isNewSi(n)) return 2;
      if(isOldImg(n))return 3;
      if(isPdf(n))   return 9;
      return 99;
    };
    candidates.sort((a,b)=> pri(a.name) - pri(b.name));

    const primary = candidates[0];

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
