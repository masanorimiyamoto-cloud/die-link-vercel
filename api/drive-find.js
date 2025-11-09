// /api/drive-find.js
export const config = { runtime: 'edge' };

/**
 * GET /api/drive-find?book=Ta&wc=9892[&folderId=overrideId][&dev=1][&debug=1]
 *
 * 新ルール：
 *   ROOT(= GDRIVE_DIE_MASTER_ID or ?folderId=) 直下の「フォルダ名=book」を特定
 *   → その中で「wc.(jpeg|jpg|png|pdf)」を検索（直下→未ヒットならサブツリーBFS）
 *
 * 後方互換：
 *   ROOT 配下サブツリーで「book-wc.(jpeg|jpg|png|pdf)」も探す
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

// ========= Drive helpers =========
async function driveGet({ token, id, fields='id,name,mimeType,parents' }) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if(!r.ok) throw new Error(`files.get ${r.status} ${await r.text()}`);
  return r.json();
}
async function driveList({ token, q, fields='files(id,name,mimeType,parents)', pageSize=1000, corpora='allDrives', driveId='' }) {
  const params = new URLSearchParams({
    q,
    pageSize: String(pageSize),
    fields,
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    corpora
  });
  if(driveId) params.set('driveId', driveId);

  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if(!r.ok) throw new Error(`files.list ${r.status} ${await r.text()}`);
  return r.json();
}

// ROOT直下の「フォルダ名=book」を検索（重複があれば最初を採用）
async function findBookFolderId({ token, rootId, book, debug }) {
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    `'${rootId}' in parents`,
    "trashed=false",
    `name='${book.replace(/'/g,"\\'")}'`,
  ].join(' and ');
  if (debug) console.log('findBookFolderId.q', q);
  const j = await driveList({ token, q, fields: 'files(id,name)' });
  return (j.files && j.files[0]) ? j.files[0].id : null;
}

// 指定フォルダ直下のみで wc.* を検索
async function findFilesDirectInFolder({ token, folderId, wc, exts, debug }) {
  const nameOr = exts.map(e => `name='${wc.replace(/'/g,"\\'")}.${e}'`).join(' or ');
  const q = `(${nameOr}) and '${folderId}' in parents and trashed=false`;
  if (debug) console.log('findFilesDirectInFolder.q', q);
  const j = await driveList({ token, q, fields: 'files(id,name,mimeType)' });
  return j.files || [];
}

// 指定フォルダ配下を BFS で wc.* を探索（最初に見つかった階層で確定）
async function findFilesInFolderTreeBFS({ token, rootFolderId, wc, exts, maxFolders=300, debug }) {
  const queue = [rootFolderId];
  const hits = [];
  const nameOr = exts.map(e => `name='${wc.replace(/'/g,"\\'")}.${e}'`).join(' or ');

  while(queue.length && hits.length === 0 && --maxFolders >= 0){
    const fid = queue.shift();

    // (1) 直下ファイル
    {
      const qFiles = `(${nameOr}) and '${fid}' in parents and trashed=false`;
      if (debug) console.log('BFS.files.q', qFiles);
      const jf = await driveList({ token, q: qFiles, fields: 'files(id,name,mimeType)' });
      if (Array.isArray(jf.files) && jf.files.length) {
        hits.push(...jf.files);
        break;
      }
    }
    // (2) サブフォルダを列挙→キューへ
    {
      const qDirs = `mimeType='application/vnd.google-apps.folder' and '${fid}' in parents and trashed=false`;
      if (debug) console.log('BFS.dirs.q', qDirs);
      const jd = await driveList({ token, q: qDirs, fields: 'files(id,name)' });
      (jd.files || []).forEach(d => queue.push(d.id));
    }
  }
  return hits;
}

// 後方互換：ROOT配下サブツリーで "book-wc.ext" を探索
async function legacyFindBaseNameInTree({ token, rootId, baseName, exts, maxFolders=400, debug }) {
  const queue = [rootId];
  const hits = [];
  const extQ = exts.map(e => `name='${baseName.replace(/'/g,"\\'")}.${e}'`).join(' or ');

  while(queue.length && hits.length === 0 && --maxFolders >= 0){
    const fid = queue.shift();

    // 直下ファイル
    {
      const qFiles = `(${extQ}) and '${fid}' in parents and trashed=false`;
      if (debug) console.log('legacy.files.q', qFiles);
      const jf = await driveList({ token, q: qFiles, fields: 'files(id,name,mimeType)' });
      if (Array.isArray(jf.files) && jf.files.length) {
        hits.push(...jf.files);
        break;
      }
    }
    // サブフォルダ列挙
    {
      const qDirs = `mimeType='application/vnd.google-apps.folder' and '${fid}' in parents and trashed=false`;
      if (debug) console.log('legacy.dirs.q', qDirs);
      const jd = await driveList({ token, q: qDirs, fields: 'files(id,name)' });
      (jd.files || []).forEach(d => queue.push(d.id));
    }
  }
  return hits;
}

export default async function handler(req){
  try{
    if(req.method !== 'GET') return json({ ok:false, error:'Method Not Allowed' }, 405);

    const u = new URL(req.url);
    const book  = (u.searchParams.get('book') || '').trim();
    const wc    = (u.searchParams.get('wc')   || '').trim();
    const debug = u.searchParams.get('debug') === '1';
    const overrideFolder = (u.searchParams.get('folderId') || '').trim();

    if(!book || !wc) return json({ ok:false, error:'missing book/wc' }, 400);

    const ROOT = overrideFolder || (process.env.GDRIVE_DIE_MASTER_ID || '');
    if(!ROOT) return json({ ok:false, error:'GDRIVE_DIE_MASTER_ID is missing' }, 500);

    const token = await getGoogleAccessToken();

    // 0) ROOTが実在・参照可能か確認
    let rootMeta = null;
    try {
      rootMeta = await driveGet({ token, id: ROOT, fields: 'id,name,mimeType' });
    } catch(e) {
      // 権限やID不正の切り分けのため、500ではなく詳細を返す
      return json({ ok:false, error:`root not accessible: ${String(e?.message||e)}`, rootId: ROOT }, 500);
    }

    // 1) 新ルール：ROOT/ book(=folder) / wc.(jpeg|jpg|png|pdf)
    const exts = ['jpeg','jpg','png','pdf'];
    const bookFolderId = await findBookFolderId({ token, rootId: ROOT, book, debug });
    if (bookFolderId) {
      // 直下 → 未ヒットでBFS
      let files = await findFilesDirectInFolder({ token, folderId: bookFolderId, wc, exts, debug });
      if (!files.length) {
        files = await findFilesInFolderTreeBFS({ token, rootFolderId: bookFolderId, wc, exts, maxFolders: 300, debug });
      }
      if (files.length) {
        // 画像優先・PDF後回し
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
          tried: { book, wc, bookFolderId, rootOk:true, rootName: rootMeta?.name || '' },
          debug
        });
      }
    }

    // 2) 後方互換：ROOTサブツリーで "book-wc.ext"
    const baseName = `${book}-${wc}`;
    const legacy = await legacyFindBaseNameInTree({ token, rootId: ROOT, baseName, exts, maxFolders: 400, debug });
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
        tried: { book, wc, baseName, rootOk:true, rootName: rootMeta?.name || '' },
        debug
      });
    }

    return json({
      ok: false,
      error: 'not found',
      found: 0,
      ruleTried: ['new','legacy'],
      usedRoot: overrideFolder ? 'override' : 'env',
      tried: { book, wc, baseName, rootOk:true, rootName: rootMeta?.name || '' },
      debug
    }, 404);

  }catch(e){
    return json({ ok:false, error: String(e?.message || e) }, 500);
  }
}
