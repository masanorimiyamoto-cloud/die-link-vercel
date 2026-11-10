/* public/js/auth-client.js
 * 個人ログインのフロント側の小さな部品。window.DLAuth に生やす。
 * ログイン状態そのものは HttpOnly Cookie（dl_sess）にあり、JSからは読めない。
 * 既存の照合画面は同一オリジンの fetch で Cookie が自動送信されるため、
 * この部品を読み込まなくても API 側で操作者が記録される。
 */
(function () {
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.host);

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function csrf() {
    let t = readCookie('xcsrf');
    if (t) return t;
    await fetch(isLocal ? '/api/session?dev=1' : '/api/session', { credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
    return readCookie('xcsrf');
  }

  async function post(action, body) {
    const r = await fetch('/api/session?action=' + encodeURIComponent(action), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf': await csrf() },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({ ok: false, error: '通信に失敗しました' }));
    if (!r.ok && j.ok !== false) j.ok = false;
    return j;
  }

  let mePromise = null;
  let meFailed = false; // 最後の確認が通信の失敗だった（＝未ログインと決まったわけではない）
  function me(force) {
    if (!mePromise || force) {
      mePromise = fetch('/api/session?action=me', { credentials: 'same-origin', cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(j => { meFailed = false; return (j && j.user) || null; })
        .catch(() => { meFailed = true; return null; });
    }
    return mePromise;
  }

  // API が「ログインしてください」（401）を返したら、知らせてログイン画面へ送る（2026-11-10 照合・棚登録・図面の API をログイン必須にした）。
  // 画面ごとに 401 の扱いを書かなくて済むよう、ここで fetch を包む。/api/session（PIN 違いの 401）とログイン画面は対象外
  const rawFetch = window.fetch.bind(window);
  let kicked = false;
  window.fetch = async function (input, init) {
    const r = await rawFetch(input, init);
    try {
      if (r.status === 401 && !kicked && location.pathname !== '/login.html') {
        const u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), location.href);
        if (u.origin === location.origin && u.pathname.startsWith('/api/') && u.pathname !== '/api/session') {
          kicked = true;
          alert('ログインが切れています。ログインし直してください。');
          location.href = loginUrl();
        }
      }
    } catch (e) { /* 判定に失敗しても元の応答はそのまま返す */ }
    return r;
  };

  // ログイン後に戻る先は同じサイト内のパスだけにする（外部への誘導を防ぐ）
  function safeNext(next) {
    const n = String(next || '');
    return /^\/(?!\/)[^\s]*$/.test(n) ? n : '/';
  }

  function loginUrl() {
    return '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
  }

  async function requireLogin() {
    const u = await me();
    if (!u) location.replace(loginUrl());
    return u;
  }

  // 本人の実績（今日・昨日・今月の件数）。fresh は記録した直後
  function myStats(fresh) {
    return fetch('/api/session?action=mystats' + (fresh ? '&fresh=1' : ''), { credentials: 'same-origin', cache: 'no-store' })
      .then(r => r.json()).catch(() => null);
  }

  // 「今日 ○件・今月 ○件」の札（2026-11-08）。押すと工程ごとの内訳を出す。
  // 戻り値の refresh(fresh) で数え直す。画面に戻ったとき・5分ごとにも数え直す。読めないときは札を隠す
  function statsChip() {
    const d = document.createElement('details');
    d.className = 'dl-stats';
    d.style.cssText = 'position:relative;display:inline-block';
    d.hidden = true;
    const s = document.createElement('summary');
    s.style.cssText = 'cursor:pointer;list-style:none;font-weight:800;white-space:nowrap;padding:2px 8px;border-radius:999px;'
      + 'border:1px solid currentColor;font-variant-numeric:tabular-nums';
    s.setAttribute('aria-label', '自分の実績');
    const panel = document.createElement('div');
    panel.style.cssText = 'position:absolute;right:0;top:calc(100% + 6px);z-index:60;width:max-content;min-width:200px;max-width:min(320px,86vw);'
      + 'padding:10px 12px;border-radius:10px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;'
      + 'box-shadow:0 8px 24px rgba(0,0,0,.35);font:500 13px/1.6 system-ui,-apple-system,"Noto Sans JP",sans-serif;text-align:left;white-space:normal';
    d.append(s, panel);
    const md = (iso) => { const m = /^\d{4}-(\d\d)-(\d\d)/.exec(iso || ''); return m ? `${+m[1]}/${+m[2]}` : ''; };
    function block(title, part) {
      const h = document.createElement('div'); h.style.cssText = 'font-weight:800;color:#fff;margin-top:6px';
      h.textContent = `${title} ${part.total}件`;
      panel.append(h);
      if (!part.steps || !part.steps.length) return;
      const ul = document.createElement('ul'); ul.style.cssText = 'margin:2px 0 0;padding-left:18px';
      for (const x of part.steps) {
        const li = document.createElement('li'); li.textContent = `${x.step} ${x.count}`; ul.append(li);
      }
      panel.append(ul);
    }
    let busy = false, at = 0;
    async function refresh(fresh) {
      if (busy) return; busy = true;
      try {
        const j = await myStats(fresh);
        if (!j || !j.ok || j.none || !j.today) { d.hidden = true; return; }
        at = Date.now();
        d.hidden = false;
        s.textContent = `今日 ${j.today.total}件・今月 ${j.month.total}件`;
        panel.textContent = '';
        block(`今日（${md(j.today.date)}）`, j.today);
        const y = document.createElement('div'); y.style.cssText = 'margin-top:6px;color:#cbd5e1';
        y.textContent = `昨日（${md(j.yesterday.date)}） ${j.yesterday.total}件`;
        panel.append(y);
        block(`今月（${md(j.month.from)}〜）`, j.month);
        const n = document.createElement('div'); n.style.cssText = 'margin-top:8px;font-size:12px;color:#94a3b8';
        n.textContent = '工程完了・材料入荷の報告・型の照合／仕舞い・生地照合を1件と数えます。取り消した分は数えません。'
          + '給料の締め（社員20日・パート月末）は給料計算で合わせます。数は数分おくれることがあります。';
        panel.append(n);
      } finally { busy = false; }
    }
    document.addEventListener('click', (e) => { if (d.open && !d.contains(e.target)) d.open = false; });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - at > 60000) refresh(); });
    setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60 * 1000);
    d.refresh = refresh;
    refresh();
    return d;
  }

  // ページの一番上に細いログイン帯を出す。未ログインだと照合・仕舞いの実績が残らないことを知らせる
  async function statusBar(opts = {}) {
    const u = await me();
    // 照合・棚登録・図面はログイン必須（2026-11-10）。未ログインと分かったらログイン画面へ。
    // 通信の失敗で確かめられなかっただけのときは送らず、帯で知らせる（電波の弱い場所で画面を追い出さない）
    if (!u && !meFailed && !opts.optional) { location.replace(loginUrl()); return null; }
    const bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;'
      + 'font:600 13px/1.4 system-ui,-apple-system,"Noto Sans JP",sans-serif;'
      + (u ? 'background:#0f172a;color:#cbd5e1' : 'background:#f59e0b;color:#1f1300');
    const left = document.createElement('span');
    const link = document.createElement('a');
    link.href = loginUrl();
    link.style.cssText = 'font-weight:800;padding:4px 10px;border-radius:8px;text-decoration:none;white-space:nowrap;'
      + (u ? 'color:#93c5fd' : 'background:#1f1300;color:#fff');
    if (u) {
      const b = document.createElement('b'); b.textContent = u.name; b.style.color = '#fff';
      left.append(b, ' さんの実績として記録');
      link.textContent = '切替';
      // 今日・今月の件数（照合・仕舞いをしたら数え直せるよう、帯から refresh できるようにする）
      bar.statsChip = statsChip();
      left.append(' ', bar.statsChip);
    } else {
      left.textContent = opts.warn || (meFailed ? 'ログインを確かめられません（通信を確認してください）' : 'ログインしていません。照合・棚登録・図面は使えません');
      link.textContent = 'ログイン';
    }
    bar.append(left, link);
    document.body.prepend(bar);
    return u;
  }

  window.DLAuth = {
    me, csrf, safeNext, loginUrl, requireLogin, statusBar, myStats, statsChip,
    login: (no, pin) => post('login', { no, pin }).then(j => { mePromise = null; return j; }),
    logout: () => post('logout').then(j => { mePromise = null; return j; }),
    setPin: (id, pin) => post('set-pin', { id, pin }),
    staff: () => fetch('/api/session?action=staff', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json()),
  };
})();
