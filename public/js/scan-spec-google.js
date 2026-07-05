(() => {
  const D = {
    video: q('#video'), overlay: q('#overlay'), freeze: q('#freeze'), stack: q('#stack'),
    btnStart: q('#btnStart'), btnStop: q('#btnStop'),
    detectorInfo: q('#detectorInfo'), scanStatus: q('#scanStatus'),
    errCam: q('#errCam'), errApi: q('#errApi'), loading: q('#loading'),
    lockEmoji: q('#lockEmoji'), scanCanvas: q('#scanCanvas'),
    inpBook: q('#inpBook'), inpWc: q('#inpWc'), btnManual: q('#btnManual'),
    gsBox: q('#gsBox'), specStatus: q('#specStatus'),
    driveStatus: q('#driveStatus'), driveView: q('#driveView'), driveActions: q('#driveActions'),
    nowTarget: q('#nowTarget'),
    // 半製品照合
    modeSpec: q('#modeSpec'), modeBox: q('#modeBox'), modeMeasure: q('#modeMeasure'),
    // 採寸モード（図面・品番不要／CAL-QRで縦横mm）
    measBar: q('#measBar'), measStatus: q('#measStatus'), measReadout: q('#measReadout'),
    measCapture: q('#measCapture'), measRetake: q('#measRetake'),
    // boxOverlay は画面表示用ではなく「CV照合に渡す図面ソース」として隠して保持
    boxOverlay: q('#boxOverlay'), boxPanel: q('#boxPanel'), boxStatus: q('#boxStatus'),
    boxRecalib: q('#boxRecalib'), boxResult: q('#boxResult'),
    boxRefMm: q('#boxRefMm'), boxCalibrate: q('#boxCalibrate'), boxCalInfo: q('#boxCalInfo'), boxTol: q('#boxTol'),
    measRect: q('#measRect'), measLabel: q('#measLabel'), boxVerdict: q('#boxVerdict'),
    boxBar: q('#boxBar'), boxAiAll: q('#boxAiAll'),
    boxTgtDie: q('#boxTgtDie'), boxTgtFab: q('#boxTgtFab'), boxModel: q('#boxModel'),
    // 図面オーバーレイ（人の目で重ねる目視確認）
    boxOvToggle: q('#boxOvToggle'),
  };
  function q(s){ return document.querySelector(s); }

  const ctx = D.overlay.getContext('2d', { willReadFrequently:true });
  const freezeCtx = D.freeze.getContext('2d', { willReadFrequently:true });
  const scanCtx = D.scanCanvas.getContext('2d',{ willReadFrequently:true });

  const CFG = {
    SCAN_EVERY_MS: 80,
    JSQR_MULTI_MAX: 6,
    ROI_FRACTION: 0.62
  };
  // カメラ取得条件（startCam / ensureLiveCam 共通）
  const CAMERA_CONSTRAINTS = {
    video: { facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 }, aspectRatio:{ ideal:16/9 } },
    audio: false
  };

  const S = {
    stream: null, rafId: null,
    useBarcodeDetector: ('BarcodeDetector' in window), detector: null,
    csrf: '', locked: false,
    current: { book:'', wc:'' }, lastQueryKey:'',
    lastScanAt: 0,
    // 半製品照合
    boxMode:false, boxRaf:null, boxLastAt:0, boxAiBusy:false, pxPerMm:0,
    measureMode:false, measRaf:null, measFrozen:false, // 採寸モード

    cutW:null, cutH:null, drawingId:null, drawingName:null, drawingReady:false,
    _boxUrl:null,
    // 基準セット＆寸法測定
    calSet:false, pxPerMmVideo:0, calPts:null, calSeenAt:0, lastMeasure:null, _measCanvas:null,
    refMm:50,      // 基準マーカーの実測サイズ(mm)。印刷誤差はここで補正
    _calNominal:0, // 直近に検出したCALマーカーの宣言サイズ(mm)。別サイズに切替時のみrefMmを追従
    calFactor:1,   // 実地校正係数（正しい現物で校正して系統誤差を吸収）
    meas:null,     // 手動メジャー枠 {l,t,w,h}（stack内CSS px）
    measTouched:false, // 作業者が黄色枠を手で合わせたら true。AI枠検出より優先する
    tolMm:10,      // 合否の許容差(±mm)
    boxTarget:'die', // 照合対象 'die'=抜型半製品（形状＋寸法）/ 'fabric'=生地（色柄＋縦横比・CAL不要）
    aiModel:'claude-opus-4-8', // 照合に使うAIモデル（claude-opus-4-8 / gpt-5.5）
  };
  const AI_MODELS = { 'claude-opus-4-8':'Claude Opus 4.8', 'gpt-5.5':'GPT-5.5' };
  try{ const _cf = parseFloat(localStorage.getItem('boxCalFactor')); if(_cf>0.3 && _cf<3) S.calFactor = _cf; }catch{}
  try{ const _bt = localStorage.getItem('boxTarget'); if(_bt==='die'||_bt==='fabric') S.boxTarget = _bt; }catch{}
  try{ const _am = localStorage.getItem('aiModel'); if(_am && AI_MODELS[_am]) S.aiModel = _am; }catch{}

  // --- CSRF & Cookie ---
  function readCookie(name){
    const m = document.cookie.match(new RegExp('(?:^|; )'+name.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+'=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  async function ensureCsrf(){
    let t = readCookie('xcsrf');
    if(!t){
      const url = (location.protocol==='http:' && /localhost|127\.0\.0\.1/.test(location.host)) ? '/api/session?dev=1' : '/api/session';
      await fetch(url,{method:'GET',credentials:'same-origin',cache:'no-store'}).catch(()=>{});
      t = readCookie('xcsrf');
    }
    if(t) S.csrf = t;
  }
  document.addEventListener('DOMContentLoaded', ensureCsrf);

  // --- Helpers ---
  async function waitVideoSize(timeoutMs = 2500){
    const t0 = performance.now();
    while(performance.now() - t0 < timeoutMs){
      if(D.video.videoWidth > 0 && D.video.videoHeight > 0) return true;
      await new Promise(r => requestAnimationFrame(r));
    }
    return false;
  }
  function esc(s){ return String(s??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function dieKey(bn,wc){ return (bn||'').toLowerCase()+'@@'+(wc||'').toLowerCase(); }
  function normHyphen(s){
    return (s||'')
      .replace(/[‐-‒–—―ー−]/g,'-')
      .replace(/[：]/g, ':')
      .replace(/\s*-\s*/g,'-')
      .replace(/\s*:\s*/g,':')
      .replace(/\s+/g,' ')
      .trim();
  }

  function setStatus(text, active=false){
    D.scanStatus.textContent = text;
    if(active) D.scanStatus.classList.add('active');
    else D.scanStatus.classList.remove('active');
  }

  function fitAll(){
    if(!D.video.videoWidth) return;
    const vw = D.video.videoWidth, vh = D.video.videoHeight;
    D.overlay.width = vw; D.overlay.height = vh;
    D.freeze.width  = vw; D.freeze.height  = vh;
    D.scanCanvas.width = vw; D.scanCanvas.height = vh;
    // プレビューをカメラの縦横比に合わせる（クロップ無し＝最大表示・枠合わせが容易）
    D.stack.style.aspectRatio = vw + '/' + vh;
  }

  function drawPoly(pts, stroke='#228be6', w=4, dash=null, alpha=1){
    if(!pts || pts.length<4) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = w;
    if(dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  }

  function inScope(cornerPoints){
    if(!cornerPoints || cornerPoints.length<4) return true;
    const stackW = D.stack.clientWidth, stackH = D.stack.clientHeight;
    if(!stackW || !stackH) return true;

    const scopeCssSize = 200;
    const scopeCssX = (stackW/2) - (scopeCssSize/2);
    const scopeCssY = (stackH/2) - (scopeCssSize/2);

    const scaleX = D.overlay.width / stackW;
    const scaleY = D.overlay.height / stackH;

    const scopeX = scopeCssX * scaleX;
    const scopeY = scopeCssY * scaleY;
    const scopeW = scopeCssSize * scaleX;
    const scopeH = scopeCssSize * scaleY;

    const marginX = 14 * scaleX;
    const marginY = 14 * scaleY;

    for(const pt of cornerPoints){
      if(pt.x < scopeX - marginX) return false;
      if(pt.x > scopeX + scopeW + marginX) return false;
      if(pt.y < scopeY - marginY) return false;
      if(pt.y > scopeY + scopeH + marginY) return false;
    }
    return true;
  }

  function stopCam({keepFrame=false}={}){
    if(S.rafId) cancelAnimationFrame(S.rafId);
    S.rafId=null;

    try{ D.video.pause(); }catch(e){}
    try{ D.video.srcObject = null; }catch(e){}

    if(!keepFrame){
      ctx.clearRect(0,0,D.overlay.width,D.overlay.height);
      D.freeze.style.display='none';
      D.lockEmoji.style.display='none';
      D.video.style.visibility='visible';
    }
    if(S.stream){
      try{ S.stream.getTracks().forEach(t=>t.stop()); }catch(e){}
      S.stream=null;
    }
    D.btnStart.disabled=false;
    D.btnStop.disabled=true;
    setStatus('停止中');
  }

  async function setupDetector(){
    S.useBarcodeDetector = ('BarcodeDetector' in window);
    S.detector = null;
    if(!S.useBarcodeDetector) return;
    try{
      S.detector = new BarcodeDetector({ formats:['qr_code'] });
    }catch{
      S.useBarcodeDetector = false;
      S.detector = null;
    }
  }

  async function startCam(){
    S.locked=false;
    S.lastQueryKey = ''; 
    stopCam(); 
    
    D.errCam.textContent='';
    D.freeze.style.display='none';
    D.video.style.visibility='visible';
    D.lockEmoji.style.display='none';

    try{
      S.stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      D.video.srcObject = S.stream;

      await D.video.play();

      const ok = await waitVideoSize();
      if(!ok) throw new Error('カメラ解像度が確定しませんでした');

      fitAll();
      await setupDetector();
      D.detectorInfo.textContent = (S.useBarcodeDetector && S.detector) ? 'BD+jsQR' : 'jsQR';

      D.btnStart.disabled=true;
      D.btnStop.disabled=false;

      S.lastScanAt = 0;
      setStatus('スキャン中', true);
      tick();
    }catch(e){
      console.error(e);
      // ★ ここを追加: AbortError（中断エラー）の場合は画面にエラーを出さない
      if (e.name === 'AbortError' || (e.message && e.message.includes('aborted'))) {
        console.warn('カメラ起動が一度中断されましたが、動作に影響はありません。');
        D.btnStart.disabled = false; // ボタンだけ押せる状態に戻しておく
        return; 
      }
      D.errCam.textContent = `カメラ起動エラー: ${e.name||''} ${e.message||e}`;
      setStatus('エラー');
      stopCam();
    }
  }

  function freezeAndLock(){
    fitAll();
    freezeCtx.drawImage(D.video,0,0,D.freeze.width,D.freeze.height);
    D.freeze.style.display='block';
    D.video.style.visibility='hidden';
    D.lockEmoji.style.display='block';
    ctx.clearRect(0,0,D.overlay.width,D.overlay.height);
    stopCam({keepFrame:true});
    setStatus('ロック完了');
  }

  function extractBookWc(raw){
    const t = normHyphen((raw||'').trim());
    let bn='', wc='';

    const m0 = /^([A-Za-z]{1,3})[:\-](\d+)$/i.exec(t);
    if(m0){ bn=m0[1]; wc=m0[2]; return {bn, wc}; }

    const m1 = /^(die|order)\s*[:\-]?\s*([A-Za-z]{1,3})[:\-](\d+)$/i.exec(t);
    if(m1){ bn=m1[2]; wc=m1[3]; return {bn, wc}; }

    const m2 = /^(die|order)-([^-\n\/?#]+)-([^-\n\/?#]+)/i.exec(t);
    if(m2){ bn=m2[2]; wc=m2[3]; return {bn, wc}; }

    try{
      const u = new URL(t);
      bn = (u.searchParams.get('book') || u.searchParams.get('Book') || '').trim();
      wc = (u.searchParams.get('wc')   || u.searchParams.get('WorkCord') || u.searchParams.get('workcord') || '').trim();
      if(bn && wc) return {bn, wc};

      const path = u.pathname || '';
      const mPath = /(?:^|\/)(die|order)-([^-\n\/?#]+)-([^-\n\/?#]+)/i.exec(path);
      if(mPath){
        bn = mPath[2]; wc = mPath[3];
        if(bn && wc) return {bn, wc};
      }
    }catch{}

  return null;
}

  async function detectCombined(){
    if(!D.video.videoWidth) return [];
    const vw = D.video.videoWidth, vh = D.video.videoHeight;
    const w = D.scanCanvas.width, h = D.scanCanvas.height;

    const dets = new Map();

    if(S.useBarcodeDetector && S.detector){
      try{
        const codes = await S.detector.detect(D.video);
        for(const c of codes){
          const raw = (c.rawValue||'').trim();
          if(raw && !dets.has(raw)) dets.set(raw, { raw, pts: c.cornerPoints });
        }
      }catch{
        try{
          scanCtx.drawImage(D.video, 0, 0, w, h);
          const codes = await S.detector.detect(D.scanCanvas);
          for(const c of codes){
            const raw = (c.rawValue||'').trim();
            if(raw && !dets.has(raw)) dets.set(raw, { raw, pts: c.cornerPoints });
          }
        }catch{
          S.useBarcodeDetector=false; S.detector=null;
        }
      }
    }

    const jsqrMulti = (imgData) => {
      const hits = [];
      const W = imgData.width, H = imgData.height;
      const masked = new Uint8ClampedArray(imgData.data);
      for(let k=0; k<CFG.JSQR_MULTI_MAX; k++){
        const hit = jsQR(masked, W, H, { inversionAttempts:'attemptBoth' });
        if(!hit) break;
        hits.push({
          raw: (hit.data||'').trim(),
          pts: [hit.location.topLeftCorner, hit.location.topRightCorner, hit.location.bottomRightCorner, hit.location.bottomLeftCorner]
        });
        const tl = hit.location.topLeftCorner, br = hit.location.bottomRightCorner;
        for(let y=Math.floor(tl.y); y<Math.ceil(br.y); y++){
          for(let x=Math.floor(tl.x); x<Math.ceil(br.x); x++){
            const i = (y*W + x) * 4;
            masked[i]=masked[i+1]=masked[i+2]=255;
          }
        }
      }
      return hits;
    };

    scanCtx.drawImage(D.video, 0, 0, w, h);
    let img = scanCtx.getImageData(0,0,w,h);
    for(const h1 of jsqrMulti(img)){
      if(h1.raw && !dets.has(h1.raw)) dets.set(h1.raw, h1);
    }

    if(dets.size === 0){
      const frac = CFG.ROI_FRACTION;
      const sw = Math.floor(vw * frac);
      const sh = Math.floor(vh * frac);
      const sx = Math.floor((vw - sw) / 2);
      const sy = Math.floor((vh - sh) / 2);

      scanCtx.drawImage(D.video, sx, sy, sw, sh, 0, 0, w, h);
      img = scanCtx.getImageData(0,0,w,h);
      for(const h2 of jsqrMulti(img)){
        if(h2.raw && !dets.has(h2.raw)) dets.set(h2.raw, h2);
      }
    }

    return Array.from(dets.values());
  }

  async function tick(){
    if(!S.stream) return;
    if(S.boxMode) return;

    const now = performance.now();
    if(now - S.lastScanAt < CFG.SCAN_EVERY_MS){
      S.rafId = requestAnimationFrame(tick);
      return;
    }
    S.lastScanAt = now;

    if(D.video.readyState === D.video.HAVE_ENOUGH_DATA){
      fitAll();
      ctx.clearRect(0,0,D.overlay.width,D.overlay.height);

      const dets = await detectCombined();

      if(!dets.length){
        setStatus('スキャン中', true);
        S.rafId = requestAnimationFrame(tick);
        return;
      }

      let anyInScope = false;
      for(const d of dets){
        const raw = (d.raw||'').trim(); if(!raw) continue;
        const pts = d.pts || [];
        if(!pts.length) continue;

        const okScope = inScope(pts);
        anyInScope = anyInScope || okScope;
        drawPoly(pts, okScope ? '#228be6' : '#fa5252', okScope ? 4 : 3, okScope ? null : [8,6], okScope ? 0.85 : 0.35);

        if(okScope){
          const p = extractBookWc(raw);
          if(p && p.bn && p.wc){
            setTarget(p.bn, p.wc);
            S.locked=true;
            freezeAndLock();
            querySpec();
            return;
          }
        }
      }

      if(anyInScope) setStatus(`QR検知（形式/内容が一致しません）`, true);
      else setStatus(`QR検知（ガイド外）`, true);
    }

    S.rafId = requestAnimationFrame(tick);
  }

  function setTarget(bn, wc){
    S.current.book = (bn||'').trim();
    S.current.wc   = (wc||'').trim();
    D.nowTarget.textContent = `ターゲット: ${S.current.book} / ${S.current.wc}`;
    D.inpBook.value = S.current.book;
    D.inpWc.value = S.current.wc;
  }

  async function querySpec(){
    const {book, wc} = S.current;
    if(!book || !wc) return;
    const key = dieKey(book, wc);
    if(key === S.lastQueryKey) return; 
    S.lastQueryKey = key;

    D.errApi.textContent='';
    D.loading.style.display='inline';
    
    // UI即座クリア
    D.specStatus.className = 'spec-status loading';
    D.specStatus.textContent = '照会中…';
    D.gsBox.innerHTML = '<div class="msg-empty">読み込み中...</div>';
    D.driveActions.innerHTML = '';
    D.driveView.innerHTML = '<div class="msg-empty">図面データを検索中...</div>'; 
    D.driveStatus.textContent = '検索中...';

    // 検索ごとにアコーディオンを閉じてスッキリさせる設定（お好みで外してください）
    document.querySelector('.spec-details').removeAttribute('open');

    try{
      await ensureCsrf();

      // 並列実行（図面オーバーレイ用に drive 検索の完了も待つ）
      const pSheet = fetchSpecs(book, wc);
      const pDrive = findDriveFiles(book, wc);

      await Promise.allSettled([pSheet, pDrive]);
    }catch(e){
      D.errApi.textContent = e.message || e;
    }finally{
      D.loading.style.display='none';
    }
    // 品番が取れたら自動で「半製品を照合」モードへ（作業者の手動切替を不要に）
    setMode('box');
  }

  async function fetchSpecs(book, wc){
    try {
      const r = await fetch('/api/die-check', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', ...(S.csrf?{'X-CSRF':S.csrf}:{}) },
        credentials:'same-origin',
        body: JSON.stringify({ book, wc, json:true, limit:0, noAirtable:true, gsOnly:true })
      });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error||'API Error');
      renderSpecs(j.gs);
    } catch(e) {
      D.specStatus.className = 'spec-status ng';
      D.specStatus.textContent = '照会エラー';
      D.gsBox.innerHTML = `<div class="msg-empty" style="color:var(--ng)">${esc(e.message)}</div>`;
    }
  }

  function renderSpecs(gs){
    if(!gs){
      D.specStatus.className = 'spec-status ng';
      D.specStatus.textContent = '未登録';
      D.gsBox.innerHTML = '<div class="msg-empty">該当データなし</div>';
      S.cutW = null; S.cutH = null;
      return;
    }
    D.specStatus.className = 'spec-status ok';
    D.specStatus.textContent = '✓ 登録あり';
    // Cut_Size は「縦*横」順（例: 350*500 → 縦350・横500）
    const _dim = parseDims(gs.Cut_Size);
    S.cutH = _dim ? _dim.w : null;   // 1番目 = 縦(高さ, Y)
    S.cutW = _dim ? _dim.h : null;   // 2番目 = 横(幅, X)
    const fields = [
      {k:'ItemName', l:'品名'}, {k:'Kname', l:'型名'},
      {k:'Material', l:'材質'}, {k:'Paper_Size', l:'原紙'},
      {k:'Cut_Size', l:'断裁'}, {k:'Location', l:'棚番'},
      {k:'LastSeen', l:'確認日'},
      {k:'LastDelivery', l:'前回納品日'}
    ];
    let html = '<div class="spec-table">';
    fields.forEach(f => {
      const val = gs[f.k] || '-';
      html += `<div class="spec-row"><div class="spec-label">${esc(f.l)}</div><div class="spec-val">${esc(val)}</div></div>`;
    });
    html += '</div>';
    D.gsBox.innerHTML = html;
  }

  // ★変更箇所: サムネイル機能をiframeプレビューに書き換え
  async function findDriveFiles(book, wc) {
    try {
      S.drawingId = null; S.drawingName = null; S.drawingReady = false;
      const r = await fetch(
        `/api/drive-find?book=${encodeURIComponent(book)}&wc=${encodeURIComponent(wc)}&t=${Date.now()}`,
        {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
          }
        }
      );
      const j = await r.json();

      D.driveActions.innerHTML = '';
      D.driveView.innerHTML = '';

      if (!j.ok) {
        D.driveStatus.textContent = '検索エラー';
        D.driveView.innerHTML = '<div class="msg-empty">取得に失敗しました</div>';
        return;
      }

      const cands = j.candidates || (j.fileId ? [{ id: j.fileId, name: j.fileName }] : []);
      if (!cands.length) {
        D.driveStatus.textContent = '図面なし';
        D.driveView.innerHTML = '<div class="msg-empty">この型には図面ファイルが登録されていません<br><small>（登録状況は下の「詳細情報」のバッジを確認してください）</small></div>';
        return;
      }

      D.driveStatus.textContent = `${cands.length}件ヒット`;

      // 優先順位ソート（図面→シール→その他）
      const score = (n) => {
        n = (n || '').toLowerCase();
        if (/-zu\./.test(n)) return 1;
        if (/-si\./.test(n)) return 2;
        if (/\.pdf$/.test(n)) return 3;
        return 9;
      };
      cands.sort((a, b) => score(a.name) - score(b.name));

      // 半製品照合用：オーバーレイに使う画像（-zu/-si/画像）のIDを控える
      const _img = cands.find(c => /\.(jpe?g|png)$/i.test(c.name || ''));
      S.drawingId = _img ? _img.id : null;
      S.drawingName = _img ? _img.name : null;

      // 1) 関連ファイルのリンクボタン生成
      for (const f of cands) {
        const id = f.id;
        const name = f.name || '';
        const isPdf = /\.pdf$/i.test(name);

        const url = isPdf
          ? `https://drive.google.com/file/d/${id}/view`
          : `https://drive.google.com/uc?export=view&id=${id}`;

        let label = 'ファイル';
        let icon = '📄';
        let cls = 'drive-btn';
        if (/-zu\./i.test(name)) { label = '図面'; icon = '📐'; cls += ' primary-btn'; }
        else if (/-si\./i.test(name)) { label = 'シール'; icon = '🏷️'; }
        else if (isPdf) { label = 'PDF'; icon = '📑'; }
        else if (/\.(jpg|jpeg|png|gif)$/i.test(name)) { label = '画像'; icon = '🖼️'; }

        const btn = document.createElement('a');
        btn.href = url;
        btn.target = '_blank';
        btn.rel = 'noopener';
        btn.className = cls;
        btn.textContent = `${icon} ${label}`;
        D.driveActions.appendChild(btn);
      }

      // 2) 最も優先度の高いファイル（最上位）をiframeでプレビュー表示
      const topFile = cands[0];
      if (topFile) {
        const previewUrl = `https://drive.google.com/file/d/${topFile.id}/preview`;
        D.driveView.innerHTML = `
          <div class="preview-wrapper">
            <iframe src="${previewUrl}"></iframe>
          </div>
        `;
      } else {
        D.driveView.innerHTML = '<div class="msg-empty">プレビューできるファイルがありません</div>';
      }

    } catch (e) {
      console.error('Drive API Error:', e);
      D.driveStatus.textContent = '検索失敗';
      D.driveView.innerHTML = '<div class="msg-empty">検索に失敗しました</div>';
    }
  }

  D.btnStart.onclick = async () => {
    if (D.btnStart.disabled) return; 
    D.btnStart.disabled = true;
    await startCam();
  };
  D.btnStop.onclick = () => stopCam();
  window.onresize = fitAll;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.stream) {
      console.log('バックグラウンドに移行したためカメラを停止します');
      stopCam();
    }
  });

  D.btnManual.onclick = () => {
    const b = D.inpBook.value.trim();
    const w = normHyphen(D.inpWc.value.trim());
    if(!b || !w){ alert('BookとWCを入力してください'); return; }
    setTarget(b, w);
    S.locked=false; S.lastQueryKey='';
    querySpec();
  };

  /* ===========================================================
     半製品照合（図面との形状照合・実寸確認）
     - 基準QR「CAL-50」(1辺50mm) からスケール(px/mm)を算出
     - 現物輪郭の外寸をmm換算し、Cut_Size(縦横mm)との差を合否へ反映
     - 本番スキャンとは別の独立ライブループ（boxTick）で動かす
     =========================================================== */
  function parseDims(s){
    const nums = String(s || '').match(/\d+(?:\.\d+)?/g);
    if(!nums || nums.length < 2) return null;
    return { w: parseFloat(nums[0]), h: parseFloat(nums[1]) };
  }
  function avgSide(p){
    const d = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
    return (d(p[0],p[1]) + d(p[1],p[2]) + d(p[2],p[3]) + d(p[3],p[0])) / 4;
  }

  function setBoxStatus(t, ok){ D.boxStatus.textContent = t; D.boxStatus.classList.toggle('active', !!ok); }

  // カメラ上部の大きな判定バナー（即座に気づけるように）
  function showVerdict(cls, main, sub){
    D.boxVerdict.className = cls + ' show';
    D.boxVerdict.innerHTML = esc(main) + (sub ? `<span class="vsub">${esc(sub)}</span>` : '');
  }
  function hideVerdict(){ D.boxVerdict.className = ''; }

  async function loadBoxDrawing(){
    S.drawingReady = false;
    if(!S.drawingId){ return; }
    await ensureCsrf();
    try{
      const url = `/api/drive-proxy?id=${encodeURIComponent(S.drawingId)}&name=${encodeURIComponent(S.drawingName||'zu')}&_nc=${Date.now()}`;
      const r = await fetch(url, { credentials:'same-origin', cache:'no-store', headers: S.csrf ? {'X-CSRF':S.csrf} : {} });
      if(!r.ok) throw new Error('drive-proxy ' + r.status);
      const blob = await r.blob();
      if(S._boxUrl) URL.revokeObjectURL(S._boxUrl);
      S._boxUrl = URL.createObjectURL(blob);
      D.boxOverlay.src = S._boxUrl;
      // CVの入力に使うため、デコード完了を待ってから ready にする（display:none でも画素は読める）
      try{
        if(D.boxOverlay.decode) await D.boxOverlay.decode();
        else await new Promise((res, rej) => { D.boxOverlay.onload = res; D.boxOverlay.onerror = rej; });
      }catch{}
      S.drawingReady = !!D.boxOverlay.naturalWidth;
    }catch(e){ console.warn('drawing load failed', e); }
  }

  async function ensureLiveCam(){
    if(S.stream && D.video.srcObject && !D.video.paused){ fitAll(); return; }
    try{
      if(!S.stream){
        S.stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      }
      D.video.srcObject = S.stream;
      D.video.style.visibility = 'visible';
      D.freeze.style.display = 'none';
      D.lockEmoji.style.display = 'none';
      await D.video.play();
      await waitVideoSize();
      fitAll();
      if(!S.detector) await setupDetector();
      D.btnStart.disabled = true; D.btnStop.disabled = false;
    }catch(e){ D.errCam.textContent = 'カメラ起動エラー: ' + (e.message || e); }
  }

  // 軽量な日本語読み上げ（任意・対応端末のみ）
  function speakBox(text){
    if(!('speechSynthesis' in window)) return;
    try{
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP'; u.rate = 1.05; u.pitch = 1.1; u.volume = 1.0;
      speechSynthesis.speak(u);
    }catch{}
  }

  // 基準セット完了（px/mm を確定しロック）
  function setCalibrated(cal){
    // QRの宣言サイズ(cal.mm)を基準の既定にする。CAL-50↔CAL-100 のように別サイズへ
    // 切り替えたら実測サイズ入力も追従させる（追従しないとCAL-100を50mm基準で読み2倍ズレる）。
    // 同一サイズを見続ける間はユーザーの微調整（印刷誤差補正）を保持する。
    if(cal && cal.mm > 0 && S._calNominal !== cal.mm){
      S._calNominal = cal.mm;
      S.refMm = cal.mm;
      if(D.boxRefMm) D.boxRefMm.value = String(cal.mm);
    }
    const refMm = S.refMm || cal.mm;                     // 実測サイズ優先（印刷誤差補正）
    S.pxPerMmVideo = avgSide(cal.pts) / refMm;           // 映像px/mm（測定用）
    S.calPts = cal.pts.map(p => ({ x:p.x, y:p.y }));     // QR位置（測定時マスク用）
    S.calSeenAt = performance.now();                     // 直近にQRを見た時刻（測定時の取りこぼし防止）
    const coverScale = Math.max(
      D.stack.clientWidth / (D.video.videoWidth || 1),
      D.stack.clientHeight / (D.video.videoHeight || 1)
    );
    S.pxPerMm = (avgSide(cal.pts) * coverScale) / refMm; // 表示px/mm（オーバーレイ用）
    D.boxCalibrate.disabled = false;
    D.boxRecalib.style.display = '';
    if(!S.calSet){
      S.calSet = true;
      setBoxStatus(`✅ セットしました（${refMm}mm基準 / ${S.pxPerMmVideo.toFixed(2)} px/mm）`, true);
      if(navigator.vibrate) try{ navigator.vibrate(80); }catch{}
      speakBox('基準をセットしました。');
    }
    if(D.measRect.style.display === 'block') layoutMeasRect(); // ライブ実寸を更新
  }

  // 基準を取り直す
  function clearCalibration(){
    S.calSet = false; S.pxPerMmVideo = 0; S.calPts = null; S.lastMeasure = null;
    D.boxCalibrate.disabled = true;
    D.boxRecalib.style.display = 'none';
    D.boxResult.style.display = 'none';
    D.measRect.style.display = 'none';
    hideVerdict();
    setBoxStatus('そのまま🤖AI照合でOK（mmを出す時だけCAL-50）', false);
    if(D.overlay.width) ctx.clearRect(0,0,D.overlay.width,D.overlay.height);
  }

  async function boxTick(){
    if(!S.boxMode){ return; }
    if(S.boxAiBusy){
      S.boxRaf = requestAnimationFrame(boxTick);
      return;
    }
    const now = performance.now();
    if(now - (S.boxLastAt||0) >= 120 && D.video.readyState === D.video.HAVE_ENOUGH_DATA){
      S.boxLastAt = now;
      fitAll();
      if(D.overlay.width) ctx.clearRect(0,0,D.overlay.width,D.overlay.height);
      let cal = null;
      try{
        const dets = await detectCombined();
        for(const d of dets){
          const m = /^cal[-_]?(\d+(?:\.\d+)?)$/i.exec((d.raw||'').trim());
          if(m && d.pts && d.pts.length >= 4){ cal = { mm: parseFloat(m[1]), pts: d.pts }; break; }
        }
      }catch{}
      if(S.boxTarget === 'fabric'){
        // 生地は色柄のみ照合。CAL-50も枠も使わない
        setBoxStatus('🧵 生地モード：AI照合で生地柄を確認', false);
      }else if(cal){
        drawPoly(cal.pts, '#12b886', 4, null, 0.9);
        setCalibrated(cal);
        // 図面オーバーレイはライブ追従させない（落ち着いた表示のため、表示時に一度だけ設定）
      }else if(S.calSet){
        // 縮尺はQRが見えている間だけ最新。外れたら入れ直しを促す
        setBoxStatus('⚠ CAL-50を画面内に入れたまま枠を合わせてください', true);
      }else{
        setBoxStatus('そのまま🤖AI照合でOK（mmを出す時だけCAL-50）', false);
      }
    }
    S.boxRaf = requestAnimationFrame(boxTick);
  }

  /* --- 手動メジャー枠（再現性の高い実測）---
     オレンジ枠の四隅を現物の外形に合わせる。CSS px → mm は表示px/mm(S.pxPerMm)で換算。
     CAL-50の縮尺は boxTick が常時更新。距離/傾きの系統誤差は calFactor で吸収。 */
  function boxResultError(head, detail, voice){
    D.boxResult.style.display='flex';
    D.boxResult.className='row ng';
    D.boxResult.innerHTML=`<div class="res-head">${head}</div><div class="res-detail">${detail}</div>`;
    showVerdict('warn', head, '');
    if(voice) speakBox(voice);
  }

  function showMeasRect(){
    const sw = D.stack.clientWidth, sh = D.stack.clientHeight;
    if(!S.meas){ S.meas = { l: sw*0.22, t: sh*0.22, w: sw*0.56, h: sh*0.56 }; }
    D.measRect.style.display = 'block';
    layoutMeasRect();
  }
  function layoutMeasRect(){
    const m = S.meas; if(!m) return;
    D.measRect.style.left = m.l + 'px';
    D.measRect.style.top  = m.t + 'px';
    D.measRect.style.width  = m.w + 'px';
    D.measRect.style.height = m.h + 'px';
    // ライブ実寸表示
    if(S.pxPerMm > 0){
      const k = S.calFactor || 1;
      const wMm = m.w / S.pxPerMm * k, hMm = m.h / S.pxPerMm * k;
      const txt = `横 ${Math.round(wMm)} × 縦 ${Math.round(hMm)} mm`;
      D.measLabel.textContent = txt;
      if(S.measureMode && D.measReadout) D.measReadout.textContent = txt;
    }else if(S.boxTarget === 'fabric'){
      D.measLabel.textContent = '枠を生地の外形に合わせてください';
    }else{
      D.measLabel.textContent = '基準QR(CAL)を映してください';
      if(S.measureMode && D.measReadout) D.measReadout.textContent = '基準QRを映すと寸法が出ます';
    }
  }
  // 枠の現在寸法(mm)。校正係数込み。scaleOk=QRが最近見えていて縮尺が有効か
  function measRectMm(applyCal){
    const m = S.meas;
    const scaleOk = S.pxPerMm > 0 && S.calSeenAt && (performance.now() - S.calSeenAt) < 2500;
    const k = applyCal ? (S.calFactor || 1) : 1;
    return {
      wMm: m ? (m.w / S.pxPerMm * k) : 0,
      hMm: m ? (m.h / S.pxPerMm * k) : 0,
      scaleOk
    };
  }

  function captureAiFrame(){
    const vw = D.video.videoWidth, vh = D.video.videoHeight;
    if(!vw) return null;
    D.freeze.width = vw; D.freeze.height = vh;
    freezeCtx.drawImage(D.video, 0, 0, vw, vh);
    D.freeze.style.display = 'block';
    D.video.style.visibility = 'hidden';

    const MAXW = 1024; // 送信画像は長辺1024に縮小したJPEG
    const cs = Math.min(1, MAXW / Math.max(vw, vh));
    const cw = Math.round(vw*cs), ch = Math.round(vh*cs);
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(D.video, 0, 0, cw, ch);
    return { dataUrl: cv.toDataURL('image/jpeg', 0.85), vw, vh, cw, ch };
  }

  // fetch のタイムアウト用 AbortSignal（非対応ブラウザは undefined を返す）
  function abortAfter(ms){ try{ return AbortSignal.timeout(ms); }catch{ return undefined; } }

  // box-detect を1回呼び、現物の正規化bbox(0..1)を返す（見つからなければ null、エラーは throw）
  async function aiDetectBox(frame){
    if(!frame) return null;
    await ensureCsrf();
    const r = await fetch('/api/box-detect', {
      method:'POST', credentials:'same-origin', cache:'no-store', signal: abortAfter(45000),
      headers: Object.assign({ 'content-type':'application/json' }, S.csrf ? { 'X-CSRF':S.csrf } : {}),
      body: JSON.stringify({ image: frame.dataUrl, book: S.current.book, wc: S.current.wc, model: S.aiModel }),
    });
    const j = await r.json();
    if(!j.ok){ throw new Error(j.error || 'API error'); }
    return j.found ? j.box : null;
  }
  // 見た目の照合（現物写真1枚を送ってAI判定）。endpoint で 形状／生地（色柄）を切替
  // どちらも {ok, found, verdict, confidence, reason, refFileName} を返す
  async function aiImageMatch(endpoint, frame, extra){
    if(!frame) throw new Error('撮影画像を取得できませんでした');
    await ensureCsrf();
    const r = await fetch(endpoint, {
      method:'POST', credentials:'same-origin', cache:'no-store', signal: abortAfter(45000),
      headers: Object.assign({ 'content-type':'application/json' }, S.csrf ? { 'X-CSRF':S.csrf } : {}),
      body: JSON.stringify(Object.assign(
        { image: frame.dataUrl, book: S.current.book, wc: S.current.wc, model: S.aiModel },
        extra || {})),
    });
    const j = await r.json();
    if(!j.ok){ throw new Error(j.error || 'API error'); }
    return j;
  }
  const aiMaterialMatch = (frame) => aiImageMatch('/api/material-match', frame);  // 生地：色柄・織り

  /* ===========================================================
     抜型 新方式：撮影 → 純JSで自動位置合わせ → 一致率(%)/ズレ(mm)/重ね合わせ画像
     → AIで「同一品番か」の意味照合（補助）。半透明目視と旧AI形状判定を置換。
     ※ OpenCVは廃止（iOSでWASM初期化がメモリ超過でクラッシュするため）。
     =========================================================== */
  let _dieMatchMod = null;
  async function loadDieMatchMod(){
    // 照合エンジン（純JS・軽量）を照合時にだけ遅延ロード
    if(!_dieMatchMod) _dieMatchMod = await import('/js/die-overlay-match.js');
    return _dieMatchMod;
  }
  function frameToImage(frame){
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('静止画の生成に失敗しました'));
      im.src = frame.dataUrl;
    });
  }
  async function runDieOverlayMatch(frame){
    if(!S.drawingReady || !D.boxOverlay.naturalWidth){
      throw new Error('登録図面が読み込めていません（図面 -zu が未登録の可能性）');
    }
    const mod = await loadDieMatchMod();
    setBoxStatus('撮影済み。スマホを動かしてOKです（自動位置合わせ中…）', true);
    const { matchDieOverlay } = mod;
    const photo = await frameToImage(frame);

    // 撮影画像はvideo解像度から縮小されているので px/mm も同率で補正（calFactorも反映）
    const capScale = (frame.cw && frame.vw) ? (frame.cw / frame.vw) : 1;
    // 実寸判定時は、撮影直前まで同じ画面内で確認できたCAL-50だけを使う。
    // 一度読んだ後にカメラ距離を変えた古い縮尺を流用すると誤判定になるため。
    const calFresh = S.pxPerMmVideo > 0 && S.calSeenAt && (performance.now() - S.calSeenAt) < 2500;
    const pxPerMm = calFresh ? (S.pxPerMmVideo * capScale / (S.calFactor || 1)) : 0;
    // ※ ホモグラフィ補正(calQuad)は一旦無効化。小さいCAL-50単体では、現物へ外挿する際に
    //   隅ノイズが非線形増幅して等方スケール法より悪化する（実測で数倍の誤差）。
    //   大きい基準(CAL-100 等)を導入してから再有効化する。die-overlay-match側の
    //   ホモグラフィ実装はcalQuad未指定なら不使用（従来の等方pxPerMmにフォールバック）。

    // 任意：box-detect で現物bboxを取り背景を除外（失敗しても続行）
    let productBox = null;
    try { productBox = await aiDetectBox(frame); } catch {}

    const cv = await matchDieOverlay({
      photo,
      drawing: D.boxOverlay,
      pxPerMm,
      productBox: productBox || undefined,
      tolMm: S.tolMm || 10,
      expectedWmm: S.cutW,
      expectedHmm: S.cutH,
      onStatus: (s) => { if(s) setBoxStatus(s, true); },
    });

    // AI補助（同一品番かの意味照合）。CV計測値も渡して講評させる
    let ai = null;
    try {
      ai = await aiImageMatch('/api/die-align-verify', frame, {
        cv: { matchPct: cv.matchPct, maxDevMm: cv.maxDevMm, avgDevMm: cv.avgDevMm }
      });
    } catch(e) { ai = { _err: String(e.message||e) }; }

    renderDieOverlayResult(cv, ai, pxPerMm);
    S.lastMeasure = (cv.ok) ? { wMm:cv.actualWmm||0, hMm:cv.actualHmm||0, ok:(cv.verdict==='match') } : null;
    setBoxStatus(pxPerMm > 0 ? '✅ 照合完了' : '✅ 照合完了（CAL-50未設定：mmは表示なし）', true);
  }

  // 新方式の結果表示（重ね合わせ画像＋一致率＋mmズレ＋AI講評）
  function renderDieOverlayResult(cv, ai, pxPerMm){
    const cls = cv.verdict==='match' ? 'ok' : cv.verdict==='mismatch' ? 'ng' : '';
    const overall = cv.verdict==='match' ? '✅ 一致' : cv.verdict==='mismatch' ? '❌ 不一致' : '⚠ 要確認';
    // 輪郭ズレは位置合わせ残差に敏感なため参考値扱い（値はP95=上位5%の外れ値除外済み）
    const mmLine = (cv.maxDevMm != null)
      ? `参考：輪郭ズレ ${cv.maxDevMm}mm（外れ値除外）／平均 ${cv.avgDevMm ?? '—'}mm`
      : (cv.maxDevPct != null
          ? `参考：輪郭ズレ 約${cv.maxDevPct}％／平均 約${cv.avgDevPct ?? '—'}％（現物サイズ比・CAL-50なし）`
          : (pxPerMm > 0 ? 'ズレ算出不可（輪郭が取れませんでした）' : 'CAL-50なし：一致率のみ'));
    const dimLine = (cv.dimensionVerdict === 'match' || cv.dimensionVerdict === 'mismatch')
      ? `実寸 長辺${cv.actualWmm}×短辺${cv.actualHmm}mm／登録 長辺${cv.expectedWmm}×短辺${cv.expectedHmm}mm` +
        `（差 長辺${cv.dimDeltaWmm}・短辺${cv.dimDeltaHmm}mm／許容±${S.tolMm||10}mm）`
      : (!S.cutW || !S.cutH
          ? '実寸判定：登録寸法（Cut_Size）がありません'
          : '実寸判定：CAL-50を映すと登録寸法との差を判定します');

    const apprV = (ai && ai.found !== false && ai.ok !== false && !ai._err) ? ai.verdict : null;
    let aiLine;
    if(apprV){
      const sL = apprV==='match'?'✅一致':apprV==='mismatch'?'❌不一致':'❔保留';
      aiLine = `AI形状照合 ${sL}${ai.confidence!=null?`（確度${ai.confidence}）`:''}：${esc(ai.reason||'')}`;
    }else if(ai && ai._err){
      aiLine = `AI形状照合：エラー（${esc(ai._err)}）`;
    }else if(ai && ai.found === false){
      aiLine = 'AI形状照合：登録図面が見つかりません';
    }else{
      aiLine = 'AI形状照合：—';
    }

    D.boxResult.style.display = 'flex';
    D.boxResult.className = 'row ' + cls;
    // 自動CVの色付き重ね合わせ画像は廃止（混乱の元）。数値・AI判定のみ表示し、
    // 目視確認は「🖼 図面を重ねる」手動オーバーレイに一本化する。
    D.boxResult.innerHTML =
      `<div class="res-head">${overall}　一致率 ${cv.matchPct ?? '—'}％</div>`
      + `<div class="res-detail">${dimLine}</div>`
      + `<div class="res-detail">${mmLine}</div>`
      + (cv.ok ? '' : `<div class="res-detail">${esc(cv.reason||'')}</div>`)
      + `<div class="res-detail">${aiLine}</div>`
      + `<div class="res-detail" style="font-size:11px;color:#999">AI: ${esc(AI_MODELS[S.aiModel]||S.aiModel)}</div>`
      + `<div class="res-detail" style="font-size:11px;color:#888">🖼「図面を重ねる」で登録図面を現物に重ね、目視でも確認できます</div>`;

    const sub = `一致率 ${cv.matchPct ?? '—'}％` + (cv.maxDevMm!=null ? ` / 輪郭${cv.maxDevMm}mm` : '');
    showVerdict(cls==='ok'?'ok':cls==='ng'?'ng':'warn', overall, sub);
    speakBox(cls==='ok' ? '一致です。' : cls==='ng' ? '不一致です。' : '要確認です。');
    if(navigator.vibrate) try{ navigator.vibrate(cls==='ng' ? [80,60,80] : 70); }catch{}
  }

  // 🤖 AI照合：撮影 → 抜型は新方式(CV自動位置合わせ＋AI意味照合)／生地は色柄AI
  async function aiAllInOne(){
    if(!D.video.videoWidth){ return; }
    if(!S.current.book || !S.current.wc){ alert('先に品番をスキャン／照会してください'); return; }
    const fabric = (S.boxTarget === 'fabric');
    const btn = D.boxAiAll, prev = btn.textContent;
    btn.disabled = true;
    S.boxAiBusy = true;
    S._dbg = '';
    D.boxResult.style.display = 'none';
    hideVerdict();
    try{
      const frame = captureAiFrame();
      if(!frame) throw new Error('カメラ画像を取得できませんでした');
      showVerdict('warn', '撮影済み', 'スマホを離してOK・AI照合中');

      // 生地は「色柄のみ」照合（寸法・縦横比・枠は使わない）
      if(fabric){
        btn.textContent = '撮影済み・照合中…';
        setBoxStatus('撮影済み。スマホを動かしてOKです（AIが生地柄を照合中…）', true);
        const a = await aiMaterialMatch(frame).then(v => ({ v })).catch(e => ({ err: String(e.message||e) }));
        renderApprOnly(a.v||null, a.err||null, '生地');
        setBoxStatus('✅ 生地照合 完了', true);
        return;
      }

      // 抜型：新方式（CV自動位置合わせ＋AI意味照合）に一本化
      btn.textContent = '撮影済み・照合中…';
      await runDieOverlayMatch(frame);
    }catch(e){
      boxResultError('🤖 AI照合エラー', String(e.message||e) + '<br>通信状況を確認してもう一度お試しください。');
    }finally{
      btn.disabled = false; btn.textContent = prev;
      S.boxAiBusy = false;
      D.freeze.style.display = 'none';
      D.video.style.visibility = 'visible';
    }
  }

  // 見た目（生地色柄）のみの判定表示（寸法・比率なし）。生地モード用
  function renderApprOnly(appr, apprErr, apprLabel){
    apprLabel = apprLabel || '生地';
    const apprV = (appr && appr.found !== false && appr.ok !== false) ? appr.verdict : null;
    let overall, cls;
    if(apprV === 'mismatch'){ overall = '❌ 不一致'; cls = 'ng'; }
    else if(apprV === 'match'){ overall = '✅ 一致'; cls = 'ok'; }
    else { overall = '⚠ 要確認'; cls = ''; }

    let apprLine;
    if(apprV){
      const sL = apprV==='match'?'✅一致':apprV==='mismatch'?'❌不一致':'❔保留';
      apprLine = `${apprLabel} ${sL}${appr.confidence!=null?`（確度${appr.confidence}）`:''}：${esc(appr.reason||'')}`;
    }else if(apprErr){
      apprLine = `${apprLabel}：照合エラー（${esc(apprErr)}）`;
    }else{
      apprLine = `${apprLabel}：登録画像が見つかりません`;
    }

    S.lastMeasure = null;
    D.boxResult.style.display = 'flex';
    D.boxResult.className = 'row ' + cls;
    D.boxResult.innerHTML =
      `<div class="res-head">${overall}</div>`
      + `<div class="res-detail">${apprLine}</div>`
      + `<div class="res-detail" style="font-size:11px;color:#999">AI: ${esc(AI_MODELS[S.aiModel]||S.aiModel)}</div>`;

    const apprS = apprV ? (apprV==='match'?`${apprLabel}✅`:apprV==='mismatch'?`${apprLabel}❌`:`${apprLabel}❔`) : (apprErr?`${apprLabel}⚠`:`${apprLabel}—`);
    showVerdict(cls==='ok'?'ok':cls==='ng'?'ng':'warn', overall, apprS);
    speakBox(cls==='ok' ? '生地は一致です。' : cls==='ng' ? '生地が違います。' : '要確認です。');
    if(navigator.vibrate) try{ navigator.vibrate(cls==='ng' ? [80,60,80] : 70); }catch{}
  }

  // 登録寸法が分かっている正しい現物で系統誤差(一定倍率)を校正
  function calibrateWithBox(){
    if(!S.calSet || !S.meas){ alert('先に50mm基準をセットし、枠を現物に合わせてください'); return; }
    if(!S.cutW || !S.cutH){ alert('この品番は登録寸法(Cut_Size)が無いため校正できません'); return; }
    const r = measRectMm(false); // 補正なしの実測
    if(!r.scaleOk){
      return boxResultError('⚠ CAL-50を画面内に入れてください','CAL-50を画面内に入れたまま校正してください。','シーエーエル50を画面に入れてください。');
    }
    const meas = [r.wMm, r.hMm].sort((a,b)=>a-b);
    const tgt  = [S.cutW, S.cutH].sort((a,b)=>a-b);
    if(meas[0] < 1 || meas[1] < 1){ return boxResultError('⚠ 校正失敗','枠が小さすぎます。現物に合わせてください。'); }
    const k = ((tgt[0]/meas[0]) + (tgt[1]/meas[1])) / 2;
    if(!(k>0.3 && k<3)){ return boxResultError('⚠ 校正失敗',`補正比が異常です(${k.toFixed(2)})。枠とCAL-50を確認してください。`); }
    S.calFactor = k;
    try{ localStorage.setItem('boxCalFactor', String(k)); }catch{}
    layoutMeasRect();
    D.boxResult.style.display='flex';
    D.boxResult.className='row ok';
    D.boxResult.innerHTML =
      `<div class="res-head">🎯 校正しました</div>`
      + `<div class="res-detail">補正係数 <b>${k.toFixed(3)}</b>（今後の測定に適用）</div>`
      + `<div class="res-detail">校正前 横${Math.round(meas[1])}×縦${Math.round(meas[0])} 相当 → 登録 縦${Math.round(S.cutH)}×横${Math.round(S.cutW)}に合わせ込み</div>`;
    speakBox('校正しました。');
    if(navigator.vibrate) try{ navigator.vibrate(60); }catch{}
  }

  // 照合対象（抜型/生地）の切替。生地はCAL-50不要・縦横比のみ
  function setBoxTarget(t){
    S.boxTarget = (t === 'fabric') ? 'fabric' : 'die';
    try{ localStorage.setItem('boxTarget', S.boxTarget); }catch{}
    const fab = S.boxTarget === 'fabric';
    D.boxTgtFab.classList.toggle('active', fab);
    D.boxTgtDie.classList.toggle('active', !fab);
    if(fab){
      // 生地は色柄のみ照合（寸法・縦横比なし）→ 枠は不要なので隠す
      D.measRect.style.display = 'none';
      setBoxStatus('🧵 生地モード：AI照合で生地柄を確認', false);
    }else{
      if(!S.calSet) setBoxStatus('そのまま🤖AI照合でOK（mmを出す時だけCAL-50）', false);
    }
    if(D.measRect.style.display === 'block') layoutMeasRect();
  }

  async function enterBoxMode(){
    if(!S.current.book || !S.current.wc){
      alert('先に品番をスキャン／照会してください');
      D.modeBox.classList.remove('active'); D.modeSpec.classList.add('active');
      return;
    }
    S.boxMode = true;
    if(S.rafId){ cancelAnimationFrame(S.rafId); S.rafId = null; }
    const ts = D.stack.querySelector('.target-scope'); if(ts) ts.style.display = 'none';
    D.boxPanel.style.display = 'block';
    D.boxBar.classList.add('show'); // 操作バーをカメラに重ねる
    hideVerdict();
    D.stack.style.touchAction = 'none'; // カメラ内ドラッグでページが動かないように
    // 基準・測定状態をリセット
    S.calSet = false; S.pxPerMmVideo = 0; S.calPts = null; S.lastMeasure = null;
    S.meas = null; S.measTouched = false;
    D.boxCalibrate.disabled = true;
    D.boxRecalib.style.display = 'none';
    D.boxResult.style.display = 'none';
    if(S.calFactor && Math.abs(S.calFactor-1) > 0.001){
      D.boxCalInfo.textContent = `校正済（係数 ${S.calFactor.toFixed(3)}）。再校正は正しい現物で再度ボタン`;
    }
    await ensureLiveCam();
    await loadBoxDrawing(); // 図面はCV照合の入力に使うため読み込む（画面には重ねない）
    D.boxOverlay.style.display = 'none';
    D.measRect.style.display = 'none'; // 手動の寸法目安枠は現在使用しない
    D.boxAiAll.disabled = false; // AI照合はカメラが動いていれば可（寸法はCAL-50があれば加味）
    setBoxTarget(S.boxTarget);   // 対象トグル（抜型/生地）のUIを現在値に同期
    if(!S.boxRaf) boxTick();
  }

  function exitBoxMode(){
    S.boxMode = false;
    S.lastMeasure = null;
    if(S.boxRaf){ cancelAnimationFrame(S.boxRaf); S.boxRaf = null; }
    D.boxPanel.style.display = 'none';
    D.boxBar.classList.remove('show');
    hideVerdict();
    D.stack.style.touchAction = '';
    showOverlay(false);
    D.boxResult.style.display = 'none';
    D.measRect.style.display = 'none';
    const ts = D.stack.querySelector('.target-scope'); if(ts) ts.style.display = '';
    if(D.overlay.width) ctx.clearRect(0,0,D.overlay.width,D.overlay.height);
    // カメラが生きていれば本番スキャンを再開
    if(S.stream && D.video.srcObject && !S.rafId){ S.lastScanAt = 0; setStatus('スキャン中', true); tick(); }
  }

  /* ===========================================================
     採寸モード（図面・品番不要）：CAL-QRでスケール → 現物の縦横をmm表示
     自動検出（シルエットの外接矩形）で枠を吸着し、四隅ドラッグで微調整。
     =========================================================== */
  function setMeasStatus(t, ok){ if(D.measStatus){ D.measStatus.textContent = t; D.measStatus.classList.toggle('active', !!ok); } }

  async function enterMeasureMode(){
    S.measureMode = true;
    if(S.rafId){ cancelAnimationFrame(S.rafId); S.rafId = null; }
    const ts = D.stack.querySelector('.target-scope'); if(ts) ts.style.display = 'none';
    D.measBar.classList.add('show');
    D.stack.style.touchAction = 'none';
    hideVerdict();
    D.boxPanel.style.display = 'none';
    D.boxResult.style.display = 'none';
    // スケール状態をリセット（採寸はCAL-QRだけ使う）
    S.calSet = false; S.pxPerMmVideo = 0; S.calPts = null; S._calNominal = 0;
    S.meas = null; S.measTouched = false; S.measFrozen = false;
    D.boxRecalib.style.display = 'none';
    await ensureLiveCam();
    D.freeze.style.display = 'none'; D.video.style.visibility = 'visible';
    showMeasRect();                 // オレンジ枠を中央に初期表示
    D.measRetake.style.display = 'none';
    setMeasStatus('CAL-QR（脇に置く）と現物を画面に収め、枠を現物の周りに合わせてください');
    if(!S.measRaf) measureTick();
  }

  function exitMeasureMode(){
    S.measureMode = false;
    S.measFrozen = false;
    if(S.measRaf){ cancelAnimationFrame(S.measRaf); S.measRaf = null; }
    D.measBar.classList.remove('show');
    D.stack.style.touchAction = '';
    D.measRect.style.display = 'none';
    D.freeze.style.display = 'none'; D.video.style.visibility = 'visible';
    if(D.overlay.width) ctx.clearRect(0,0,D.overlay.width,D.overlay.height);
    const ts = D.stack.querySelector('.target-scope'); if(ts) ts.style.display = '';
    if(S.stream && D.video.srcObject && !S.rafId){ S.lastScanAt = 0; setStatus('スキャン中', true); tick(); }
  }

  async function measureTick(){
    if(!S.measureMode){ return; }
    if(!S.measFrozen){
      const now = performance.now();
      if(now - (S.boxLastAt||0) >= 120 && D.video.readyState === D.video.HAVE_ENOUGH_DATA){
        S.boxLastAt = now;
        fitAll();
        if(D.overlay.width) ctx.clearRect(0,0,D.overlay.width,D.overlay.height);
        let cal = null;
        try{
          const dets = await detectCombined();
          for(const d of dets){
            const m = /^cal[-_]?(\d+(?:\.\d+)?)$/i.exec((d.raw||'').trim());
            if(m && d.pts && d.pts.length >= 4){ cal = { mm: parseFloat(m[1]), pts: d.pts }; break; }
          }
        }catch{}
        if(cal){
          drawPoly(cal.pts, '#12b886', 4, null, 0.9);
          setCalibrated(cal);
          setMeasStatus(`✅ ${S.refMm}mm基準。枠を現物の周りに大まかに合わせて📸自動計測（枠内で検出）`, true);
        }else if(S.calSet){
          setMeasStatus('⚠ CAL-QRを画面内に入れたまま計測してください', true);
        }else{
          setMeasStatus('CAL-QR（脇に置く）と現物を画面に収めてください');
        }
        layoutMeasRect();
      }
    }
    S.measRaf = requestAnimationFrame(measureTick);
  }

  async function measureCapture(){
    if(!D.video.videoWidth){ return; }
    const calFresh = S.pxPerMm > 0 && S.calSeenAt && (performance.now() - S.calSeenAt) < 2500;
    if(!calFresh){ alert('CAL-QRを画面に入れたまま「自動計測」を押してください'); return; }
    const frame = captureAiFrame();      // 映像を静止（freeze表示）
    if(!frame){ return; }
    S.measFrozen = true;
    D.measRetake.style.display = '';
    setMeasStatus('現物を自動検出中…', true);
    try{
      const mod = await loadDieMatchMod();
      const photo = await frameToImage(frame);
      const sw = D.stack.clientWidth, sh = D.stack.clientHeight;
      // CAL-QRの4隅（映像px）を撮影画像(frame)座標へ換算して渡し、採寸から除外させる
      const capScale = (frame.cw && frame.vw) ? (frame.cw / frame.vw) : 1;
      const calQuad = (S.calPts && S.calPts.length >= 4)
        ? S.calPts.map(p => ({ x: p.x * capScale, y: p.y * capScale }))
        : undefined;
      // 現在のオレンジ枠を検索ROIにする（少し広げて背景マージン確保）。
      // 全画面だと背景の影・しわ・QRを拾うため、枠内に限定して対象の縁へ吸着させる。
      let productBox;
      if(S.meas && sw > 0 && sh > 0){
        const mgx = S.meas.w * 0.15, mgy = S.meas.h * 0.15;
        let l = (S.meas.l - mgx) / sw, t = (S.meas.t - mgy) / sh;
        let w = (S.meas.w + 2*mgx) / sw, h = (S.meas.h + 2*mgy) / sh;
        l = Math.max(0, Math.min(0.95, l)); t = Math.max(0, Math.min(0.95, t));
        w = Math.max(0.05, Math.min(1 - l, w)); h = Math.max(0.05, Math.min(1 - t, h));
        productBox = { x: l, y: t, w, h };
      }
      const aabb = mod.measureObjectAABB({ photo, calQuad, productBox, maxSide: 768 });
      if(aabb && aabb.w > 0 && aabb.h > 0){
        S.meas = { l: aabb.x*sw, t: aabb.y*sh, w: aabb.w*sw, h: aabb.h*sh };
        S.measTouched = false;
        layoutMeasRect();
        setMeasStatus('枠内で自動検出しました。四隅ドラッグで微調整できます', true);
      }else{
        setMeasStatus('自動検出できませんでした。枠を手で外形に合わせてください', true);
      }
    }catch(e){
      setMeasStatus('検出エラー。枠を手で外形に合わせてください', true);
    }
  }

  function measureRetake(){
    S.measFrozen = false;
    D.measRetake.style.display = 'none';
    D.freeze.style.display = 'none'; D.video.style.visibility = 'visible';
    setMeasStatus('ライブに戻りました。CAL-QRと現物を映してください', S.calSet);
  }

  async function setMode(mode){
    D.modeSpec.classList.toggle('active', mode==='spec');
    D.modeBox.classList.toggle('active', mode==='box');
    if(D.modeMeasure) D.modeMeasure.classList.toggle('active', mode==='measure');
    // 現在のモードを抜ける
    if(mode!=='box' && S.boxMode) exitBoxMode();
    if(mode!=='measure' && S.measureMode) exitMeasureMode();
    // 目的のモードへ入る（spec は入る処理なし＝各exitがスキャンを再開）
    if(mode==='box') await enterBoxMode();
    else if(mode==='measure') await enterMeasureMode();
  }

  /* ===========================================================
     図面オーバーレイ（人の目で重ねる目視確認）
     AIが合否、最終確認は作業者が半透明の登録図面を現物にかざして照合。
     ドラッグで移動／ピンチで拡縮。表示時は中央に初期配置する。
     =========================================================== */
  function applyOvTransform(){
    D.boxOverlay.style.transform = `scale(${S.ovScale||1})`;
  }
  function centerOverlay(){
    const sw = D.stack.clientWidth || 320, sh = D.stack.clientHeight || 240;
    const nw = D.boxOverlay.naturalWidth || 4, nh = D.boxOverlay.naturalHeight || 3;
    const fit = Math.min(sw * 0.72 / nw, sh * 0.72 / nh) || 1;
    const w = nw * fit, h = nh * fit;
    D.boxOverlay.style.width = w + 'px';
    D.boxOverlay.style.height = h + 'px';
    S.ovScale = 1;
    D.boxOverlay.style.left = ((sw - w) / 2) + 'px';
    D.boxOverlay.style.top  = ((sh - h) / 2) + 'px';
    applyOvTransform();
  }
  function showOverlay(on){
    S.ovOn = on;
    D.boxOvToggle.classList.toggle('bbprimary', on);
    D.boxOvToggle.textContent = on ? '🖼 重ね中（指で移動・ピンチ）' : '🖼 図面を重ねる';
    if(!on){ D.boxOverlay.style.display = 'none'; return; }
    if(!D.boxOverlay.naturalWidth){ setBoxStatus('図面が読み込めていません（-zu 未登録の可能性）', false); S.ovOn = false; D.boxOvToggle.classList.remove('bbprimary'); D.boxOvToggle.textContent='🖼 図面を重ねる'; return; }
    D.boxOverlay.style.opacity = '0.85';
    centerOverlay();
    D.boxOverlay.style.display = 'block';
  }
  // ジェスチャ（1本指=移動 / 2本指=拡縮+パン。回転はしない）
  const _ovPtrs = new Map();
  let _ovStart = null;
  const _ovPts = () => [..._ovPtrs.values()];
  function _ovBaseline(){
    const p = _ovPts();
    const left = parseFloat(D.boxOverlay.style.left) || 0;
    const top  = parseFloat(D.boxOverlay.style.top)  || 0;
    if(p.length === 1){
      _ovStart = { mode:1, x:p[0].x, y:p[0].y, left, top };
    }else if(p.length >= 2){
      const [a,b] = p;
      _ovStart = { mode:2, left, top,
        mx:(a.x+b.x)/2, my:(a.y+b.y)/2,
        dist:Math.hypot(a.x-b.x, a.y-b.y) || 1,
        scale:S.ovScale||1 };
    }else{ _ovStart = null; }
  }
  D.boxOverlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try{ D.boxOverlay.setPointerCapture(e.pointerId); }catch{}
    _ovPtrs.set(e.pointerId, { x:e.clientX, y:e.clientY });
    _ovBaseline();
  });
  D.boxOverlay.addEventListener('pointermove', (e) => {
    if(!_ovPtrs.has(e.pointerId) || !_ovStart) return;
    _ovPtrs.set(e.pointerId, { x:e.clientX, y:e.clientY });
    const p = _ovPts();
    if(_ovStart.mode === 1 && p.length === 1){
      D.boxOverlay.style.left = (_ovStart.left + (p[0].x - _ovStart.x)) + 'px';
      D.boxOverlay.style.top  = (_ovStart.top  + (p[0].y - _ovStart.y)) + 'px';
    }else if(_ovStart.mode === 2 && p.length >= 2){
      // ピンチ＝拡縮＋平行移動のみ。
      const [a,b] = p;
      const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
      const dist=Math.hypot(a.x-b.x, a.y-b.y);
      S.ovScale = Math.max(0.1, Math.min(8, _ovStart.scale * (dist / _ovStart.dist)));
      D.boxOverlay.style.left = (_ovStart.left + (mx - _ovStart.mx)) + 'px';
      D.boxOverlay.style.top  = (_ovStart.top  + (my - _ovStart.my)) + 'px';
      applyOvTransform();
    }
  });
  const _ovEnd = (e) => { _ovPtrs.delete(e.pointerId); _ovBaseline(); };
  D.boxOverlay.addEventListener('pointerup', _ovEnd);
  D.boxOverlay.addEventListener('pointercancel', _ovEnd);

  // --- 配線 ---
  D.modeSpec.onclick = () => setMode('spec');
  D.modeBox.onclick  = () => setMode('box');
  if(D.modeMeasure) D.modeMeasure.onclick = () => setMode('measure');
  if(D.measCapture) D.measCapture.onclick = () => measureCapture();
  if(D.measRetake)  D.measRetake.onclick  = () => measureRetake();
  D.boxOvToggle.onclick = () => showOverlay(!S.ovOn);
  D.boxTgtDie.onclick = () => setBoxTarget('die');
  D.boxTgtFab.onclick = () => setBoxTarget('fabric');
  if(D.boxModel){
    D.boxModel.value = S.aiModel;
    D.boxModel.onchange = () => { if(AI_MODELS[D.boxModel.value]) S.aiModel = D.boxModel.value; try{ localStorage.setItem('aiModel', S.aiModel); }catch{} };
  }
  D.boxAiAll.onclick     = () => aiAllInOne();
  D.boxTol.onchange = () => { const v = parseFloat(D.boxTol.value); if(v>0) S.tolMm = v; };
  D.boxCalibrate.onclick = () => calibrateWithBox();
  D.boxRecalib.onclick   = () => clearCalibration();
  // 基準の実測サイズ（印刷誤差の補正）
  D.boxRefMm.onchange = () => {
    const v = parseFloat(D.boxRefMm.value);
    if(v > 0){
      S.refMm = v;
      // 既にセット済なら px/mm を即再計算（QRが外れていてもロック値を補正）
      if(S.calSet && S.calPts){
        const side = avgSide(S.calPts);
        S.pxPerMmVideo = side / v;
        setBoxStatus(`✅ 基準セット済（${v}mm基準 / ${S.pxPerMmVideo.toFixed(2)} px/mm）`, true);
      }
    }
  };
  // 枠の操作：カメラ内をドラッグで枠移動／四隅ハンドルでリサイズ
  // （細い枠線を狙わなくても、カメラのどこを掴んでも枠が動く。ページはスクロールしない）
  let _md = null; // {mode:'move'|'nw'|'ne'|'sw'|'se', x,y, l,t,w,h}
  const MIN = 24;
  function stackDown(e){
    if((!S.boxMode && !S.measureMode) || !S.meas) return;
    const t = e.target;
    if(t && t.closest && t.closest('.box-ctrlbar')) return; // 操作バー（上下）のタップは除外
    if(t === D.boxOverlay) return;                      // 図面オーバーレイは別ハンドラ
    const handle = (t && t.getAttribute && t.getAttribute('data-h')) || null;
    const m = S.meas;
    _md = { mode: handle || 'move', x:e.clientX, y:e.clientY, l:m.l, t:m.t, w:m.w, h:m.h };
    try{ D.stack.setPointerCapture(e.pointerId); }catch{}
    e.preventDefault();
  }
  function stackMove(e){
    if(!_md || !S.meas) return;
    S.measTouched = true;
    const dx = e.clientX - _md.x, dy = e.clientY - _md.y;
    const m = S.meas;
    if(_md.mode === 'move'){
      m.l = _md.l + dx; m.t = _md.t + dy;
      // 画面外に出し過ぎない（最低40pxは見えるように）
      const sw = D.stack.clientWidth, sh = D.stack.clientHeight;
      m.l = Math.min(Math.max(m.l, -m.w + 40), sw - 40);
      m.t = Math.min(Math.max(m.t, -m.h + 40), sh - 40);
    }
    else if(_md.mode === 'nw'){ m.l = _md.l + dx; m.w = Math.max(MIN, _md.w - dx); m.t = _md.t + dy; m.h = Math.max(MIN, _md.h - dy); }
    else if(_md.mode === 'ne'){ m.w = Math.max(MIN, _md.w + dx); m.t = _md.t + dy; m.h = Math.max(MIN, _md.h - dy); }
    else if(_md.mode === 'sw'){ m.l = _md.l + dx; m.w = Math.max(MIN, _md.w - dx); m.h = Math.max(MIN, _md.h + dy); }
    else if(_md.mode === 'se'){ m.w = Math.max(MIN, _md.w + dx); m.h = Math.max(MIN, _md.h + dy); }
    e.preventDefault();
    layoutMeasRect();
  }
  function stackUp(){ _md = null; }
  D.stack.addEventListener('pointerdown', stackDown);
  D.stack.addEventListener('pointermove', stackMove);
  D.stack.addEventListener('pointerup', stackUp);
  D.stack.addEventListener('pointercancel', stackUp);

})();
