// pages/api/session.js
export const config = { runtime: 'edge' };

// ランダムな 32 文字のCSRFトークンを発行
function genToken(len = 32) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(arr, b => abc[b % abc.length]).join('');
}

export default async function handler(req) {
  const xcsrf = genToken(32);

  // 24h / Secure / SameSite=Lax / Path=/
  const cookie = [
    `xcsrf=${encodeURIComponent(xcsrf)}`,
    'Path=/',
    'Max-Age=86400',
    'SameSite=Lax',
    'Secure'                  // ← 本番 https 前提
  ].join('; ');

  return new Response(JSON.stringify({ ok: true, xcsrf }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': cookie
    }
  });
}
