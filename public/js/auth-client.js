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
  function me(force) {
    if (!mePromise || force) {
      mePromise = fetch('/api/session?action=me', { credentials: 'same-origin', cache: 'no-store' })
        .then(r => r.json())
        .then(j => (j && j.user) || null)
        .catch(() => null);
    }
    return mePromise;
  }

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

  window.DLAuth = {
    me, csrf, safeNext, loginUrl, requireLogin,
    login: (no, pin) => post('login', { no, pin }).then(j => { mePromise = null; return j; }),
    logout: () => post('logout').then(j => { mePromise = null; return j; }),
    setPin: (id, pin) => post('set-pin', { id, pin }),
    staff: () => fetch('/api/session?action=staff', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json()),
  };
})();
