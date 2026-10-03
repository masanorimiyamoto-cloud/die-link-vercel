// api/auth.js  Edge Runtime
// 個人ログインAPI。Vercel Hobby の関数数上限（12）に収めるため1ファイルにまとめ、?action= で分ける。
//
//   GET  ?action=me        … ログイン中の本人 { ok, user|null }。1日以上たったログインは延長して再発行
//   POST ?action=login     … { no, pin } 社員番号とPIN。5回失敗で15分ロック
//   POST ?action=logout
//   GET  ?action=staff     … 管理者のみ。社員一覧（PIN暗号値は返さない）
//   POST ?action=set-pin   … 管理者のみ。{ id, pin } PINを設定し、ロックと失敗回数も解除
//
// POST は既存APIと同じ CSRF（xcsrf Cookie と x-csrf ヘッダの一致）を要求する。
import {
  F, ROLE_ADMIN, LIMITS, isValidPinFormat, hashPin, verifyPin, dummyVerify,
  signSession, makeSessionPayload, needsRenew, sessionCookie, clearSessionCookie,
  isLocalReq, checkCsrf, findStaffByNo, listStaff, updateStaff, getStaffById,
  getSessionUser, forgetStaffCache, writeWorkLog,
} from './_auth.js';

export const config = { runtime: 'edge' };

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export default async function handler(req) {
  const action = new URL(req.url).searchParams.get('action') || '';
  const dev = isLocalReq(req);
  try {
    if (req.method === 'GET' && action === 'me') return await me(req, dev);
    if (req.method === 'GET' && action === 'staff') return await staffList(req);
    if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);
    if (!checkCsrf(req)) return json({ ok: false, error: 'CSRF invalid' }, 403);
    if (action === 'login') return await login(req, dev);
    if (action === 'logout') return await logout(req, dev);
    if (action === 'set-pin') return await setPin(req);
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e) {
    console.error('auth error', e?.message || e);
    return json({ ok: false, error: 'サーバーでエラーが起きました。少し待ってからもう一度試してください。' }, 500);
  }
}

async function me(req, dev) {
  const s = await getSessionUser(req);
  if (!s) return json({ ok: true, user: null });
  const headers = {};
  if (needsRenew(s.payload)) {
    const token = await signSession(makeSessionPayload({ ...s.user, gen: s.payload.gen }));
    headers['set-cookie'] = sessionCookie(token, { dev });
  }
  return json({ ok: true, user: s.user }, 200, headers);
}

const LOGIN_FAIL_MSG = '社員番号またはPINが違います。';

async function login(req, dev) {
  const body = await req.json().catch(() => ({}));
  const no = String(body.no ?? '').trim();
  const pin = String(body.pin ?? '').trim();
  if (!/^\d{1,6}$/.test(no) || !isValidPinFormat(pin)) {
    return json({ ok: false, error: LOGIN_FAIL_MSG }, 401);
  }

  const staff = await findStaffByNo(no);
  if (!staff || !staff.active || !staff.pinHash) {
    await dummyVerify(pin);
    return json({ ok: false, error: LOGIN_FAIL_MSG }, 401);
  }

  if (staff.lockUntil && staff.lockUntil > Date.now()) {
    const min = Math.ceil((staff.lockUntil - Date.now()) / 60000);
    return json({ ok: false, error: `PINを続けて間違えたため、あと${min}分ログインできません。急ぎのときは管理者に解除を頼んでください。` }, 423);
  }

  const ok = await verifyPin(pin, staff.pinHash);
  if (!ok) {
    const fails = staff.fails + 1;
    const fields = { [F.fails]: fails >= LIMITS.MAX_FAILS ? 0 : fails };
    if (fails >= LIMITS.MAX_FAILS) fields[F.lockUntil] = new Date(Date.now() + LIMITS.LOCK_MINUTES * 60000).toISOString();
    await updateStaff(staff.id, fields).catch(() => {});
    if (fails >= LIMITS.MAX_FAILS) {
      return json({ ok: false, error: `PINを${LIMITS.MAX_FAILS}回間違えたため、${LIMITS.LOCK_MINUTES}分ログインできません。` }, 423);
    }
    return json({ ok: false, error: `${LOGIN_FAIL_MSG}（あと${LIMITS.MAX_FAILS - fails}回でロック）` }, 401);
  }

  await updateStaff(staff.id, { [F.fails]: 0, [F.lockUntil]: null, [F.lastLogin]: new Date().toISOString() }).catch(() => {});
  forgetStaffCache(staff.id);
  const token = await signSession(makeSessionPayload(staff));
  const user = { id: staff.id, no: staff.no, name: staff.name, role: staff.role };
  await writeWorkLog(user, { action: 'login', detail: req.headers.get('user-agent') || '' });
  return json({ ok: true, user }, 200, { 'set-cookie': sessionCookie(token, { dev }) });
}

async function logout(req, dev) {
  const s = await getSessionUser(req).catch(() => null);
  if (s) await writeWorkLog(s.user, { action: 'logout' });
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie({ dev }) });
}

async function requireAdmin(req) {
  const s = await getSessionUser(req);
  if (!s) return { err: json({ ok: false, error: 'ログインしてください' }, 401) };
  if (s.user.role !== ROLE_ADMIN) return { err: json({ ok: false, error: '管理者だけが使えます' }, 403) };
  return { user: s.user };
}

async function staffList(req) {
  const a = await requireAdmin(req);
  if (a.err) return a.err;
  const list = (await listStaff())
    .map(s => ({
      id: s.id, no: s.no, name: s.name, active: s.active, role: s.role,
      hasPin: !!s.pinHash, locked: !!(s.lockUntil && s.lockUntil > Date.now()),
    }))
    .sort((x, y) => (x.no ?? 1e9) - (y.no ?? 1e9));
  return json({ ok: true, staff: list });
}

async function setPin(req) {
  const a = await requireAdmin(req);
  if (a.err) return a.err;
  const body = await req.json().catch(() => ({}));
  const pin = String(body.pin ?? '').trim();
  if (!isValidPinFormat(pin)) return json({ ok: false, error: 'PINは4〜8桁の数字にしてください' }, 400);
  const target = await getStaffById(body.id);
  if (!target) return json({ ok: false, error: '社員が見つかりません' }, 404);

  await updateStaff(target.id, { [F.pin]: await hashPin(pin), [F.fails]: 0, [F.lockUntil]: null });
  forgetStaffCache(target.id);
  await writeWorkLog(a.user, { action: 'set-pin', detail: `${target.no} ${target.name} のPINを設定` });
  return json({ ok: true });
}
