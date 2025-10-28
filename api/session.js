// pages/api/session.js
export const config = { runtime: 'edge' };

function b64urlRand(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Buffer.from(a).toString('base64url');
}

export default async function handler(req) {
  // GETのみ
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = b64urlRand(32);
  const maxAge = 10 * 60; // 10分

  // CookieはJSから読める（HttpOnly なし）／SameSite=Laxで外部遷移の自動送信を抑える
  const cookie = [
    `xcsrf=${token}`,
    'Path=/',
    'Max-Age=' + maxAge,
    'SameSite=Lax',
    'Secure'
  ].join('; ');

  return new Response(JSON.stringify({ ok: true, token }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': cookie,
      // CORS不要（同一オリジン利用前提）
    }
  });
}
