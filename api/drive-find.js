// /api/drive-find.js
export const config = { runtime: 'edge' };

/**
 * GET /api/drive-find?book=Ta&wc=9892[&folderId=overrideId][&dev=1]
 *
 * 新ルール：
 *   - ルート(ROOT)= GDRIVE_DIE_MASTER_ID（または ?folderId= 指定）
 *   - ROOT 直下の「フォルダ名=book」を特定
 *   - その中の「wc.(jpeg|jpg|png|pdf)」を探す（まず直下→未ヒットならサブツリーBFS）
 *
 * 後方互換（見つからない時）：
 *   - ROOT配下（サブツリー）で「book-wc.(jpeg|jpg|png|pdf)」を検索
 *
 * レスポンス：
 *   { ok:true, found, candidates:[{id,name,mimeType}], rule:"new|legacy", usedRoot:"env|override", tried:{book,wc,baseName}}
 */

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function bytesToBase64Url(bytes){
  let b=''; for(let i=0;i<bytes.length;i++) b+=String.fromCharCode(bytes[i]);
  return btoa(b).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
function utf8ToBase64Url(s){ return bytesToBase64Url(new TextEncoder().encode(s)); }
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
  const now = Math.floor(Date.now()/1000);

  const header = utf8ToBase64Url('{"alg":"RS256","typ":"JWT"}');
  const payload = utf8ToBase64Url(JSON.stringify({
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now+3600
  }));
  const unsigned = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToArrayBuffer(svc.private_key),
    { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
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

// ========== Drive検索ヘルパ ==========
async function gdriveList({ token, q, fields = 'files(id,name,mimeType,parents)', pageSize = 1000 }) {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=${pageSize}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if(!r.ok) throw new Error(`drive list ${r.status} ${await r.text()}`);
  return r.json();
}

// book名のサブフォルダを ROOT 直下から名前一致で特定（重複あれば最初を採用）
async function findBookFolderId({ token, rootId, book }) {
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    `'${rootId}' in parents`,
    "trashed=false",
    `name='${book.replace(/'/g,"\\'")}'`,
  ].join(' and ');
  const j = await gdriveList({ token, q, fields: 'files(id,name)' });
  const f = (j.files || [])[0];
  return f ? f.id : null;
}

// 指定フォルダ直下で wc.* を検索
async function findFilesDirectInFolder({ token, folderId, wc, exts }) {
  const nameOr = exts.map(e => `name='${wc.replace(/'/g,"\\'")}.${e}'`).join(' or ');
  const q = `(${nameOr}) and '${folderId}' in parents and trashed=false`;
  const j = await gdriveList({ token, q, fields: 'files(id,name,mimeType)' });
  return j.files || [];
}

// フォルダ配下を幅優先で wc.* をBFS検索
async function findFilesInFolderTreeBFS({ token, rootFolderId, wc, exts, maxFolders = 300 }) {
  const queue = [rootFolderId];
  const hits = [];
  const nameOr = exts.map(e => `name='${wc.replace(/'/g,"\\'")}.${e}'`).join(' or ');

  while(queue.length && hits.length === 0 && --maxFolders >= 0){
    const fid = queue.shift();

    // 1) 直下ファイル
    {
      const qFiles = `(${nameOr}) and '${fid}' in parents and trashed=false`;
      const jf = await gdriveList({ token, q: qFiles, fields: 'files(id,name,mimeType)' });
      if (Array.isArray(jf.files) && jf.files.length) {
        hits.push(...jf.files);
        break; // 最初の階層で見つかったら確定
      }
    }

    // 2) サブフォルダを列挙→キューへ
    {
      const qDirs = `mimeType='application/vnd.google-apps.folder' and '${fid}' in parents and trashed=false`;
      const jd = await gdriveList({ token, q: qDirs, fields: 'files(id,name)' });
      (jd.files || []).forEach(d => queue.push(d.id));
    }
  }
  return hits;
}

// 旧ルール（book-wc.*）を ROOT配下のサブツリーで検索
async function legacyFindBaseNameInTree({ token, rootId, baseName, exts, maxFolders = 400 }) {
  const queue = [rootId];
  const hits = [];
  const extQ = exts.map(e => `name='${baseName.replace(/'/g,"\\'")}.${e}'`).join(' or ');

  while(queue.length && hits.length === 0 && --maxFolders >= 0){
    const fid = queue.shift();

    // 直下ファイル
    {
      const qFiles = `(${extQ}) and '${fid}' in parents and trashed=false`;
      const jf = await gdriveList({ token, q: qFiles, fields: 'files(id,name,mimeType)' });
      if (Array.isArray(jf.files) && jf.files.length) {
        hits.push(...jf.files);
        break;
      }
    }
    // サブフォルダ列挙
    {
      const qDirs = `mimeType='application/vnd.google-apps.folder' and '${fid}' in parents and trashed=false`;
      const jd = await gdriveList({ token, q: qDirs, fields: 'files(id,name)' });
      (jd.files || []).forEach(d => queue.push(d.id));
    }
  }
  return hits;
}

export default async function handler(req){
  try{
    if(req.method !== 'GET') return json({ ok:false, error:'Method Not Allowed' }, 405);

    const u = new URL(req.url);
    const book = (u.searchParams.get('book') || '').trim();
    const wc   = (u.searchParams.get('wc')   || '').trim();
    const overrideFolder = (u.searchParams.get('folderId') || '').trim();
    if(!book || !wc) return json({ ok:false, error:'missing book/wc' }, 400);

    const ROOT = overrideFolder || (process.env.GDRIVE_DIE_MASTER_ID || '');
    if(!ROOT) return json({ ok:false, error:'GDRIVE_DIE_MASTER_ID is missing' }, 500);

    const token = await getGoogleAccessToken();

    // 1) 新ルール：ROOT直下の book フォルダ → wc.(jpeg|jpg|png|pdf)
    const exts = ['jpeg','jpg','png','pdf'];
    const bookFolderId = await findBookFolderId({ token, rootId: ROOT, book });
    if (bookFolderId) {
      // 1-a) まず直下
      let files = await findFilesDirectInFolder({ token, folderId: bookFolderId, wc, exts });

      // 1-b) 未ヒットならサブツリーBFS
      if (!files.length) {
        files = await findFilesInFolderTreeBFS({ token, rootFolderId: bookFolderId, wc, exts, maxFolders: 300 });
      }

      if (files.length) {
        // 画像優先 → PDF後回し
        files.sort((a,b)=>{
          const aPdf = a.mimeType === 'application/pdf';
          const bPdf = b.mimeType === 'application/pdf';
          if(aPdf !== bPdf) return aPdf ? 1 : -1;
          return 0;
        });
        return json({
          ok: true,
          found: files.length,
          candidates: files.map(f => ({ id:f.id, name:f.name, mimeType:f.mimeType })),
          rule: 'new',
          usedRoot: overrideFolder ? 'override' : 'env',
          tried: { book, wc }
        });
      }
    }

    // 2) 後方互換：ROOTサブツリーで "book-wc.ext" を探索
    const baseName = `${book}-${wc}`;
    const legacy = await legacyFindBaseNameInTree({ token, rootId: ROOT, baseName, exts, maxFolders: 400 });
    if (legacy.length) {
      legacy.sort((a,b)=>{
        const aPdf = a.mimeType === 'application/pdf';
        const bPdf = b.mimeType === 'application/pdf';
        if(aPdf !== bPdf) return aPdf ? 1 : -1;
        return 0;
      });
      return json({
        ok: true,
        found: legacy.length,
        candidates: legacy.map(f => ({ id:f.id, name:f.name, mimeType:f.mimeType })),
        rule: 'legacy',
        usedRoot: overrideFolder ? 'override' : 'env',
        tried: { book, wc, baseName }
      });
    }

    // 見つからない
    return json({
      ok: false,
      error: 'not found',
      found: 0,
      ruleTried: ['new','legacy'],
      usedRoot: overrideFolder ? 'override' : 'env',
      tried: { book, wc, baseName }
    }, 404);

  }catch(e){
    return json({ ok:false, error: String(e?.message || e) }, 500);
  }
}
