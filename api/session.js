// pages/api/session.js
export const config = { runtime: 'edge' };

// ランダムトークン
function genToken(len = 32) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(arr, b => abc[b % abc.length]).join('');
}

export default async function handler(req) {
  const url = new URL(req.url);
  // dev=1 のときは Secure を外す（http://localhost でテストできるように）
  const dev = url.searchParams.get('dev') === '1';

  const xcsrf = genToken(32);
  const parts = [
    `xcsrf=${encodeURIComponent(xcsrf)}`,
    'Path=/',
    'Max-Age=86400',
    'SameSite=Lax'
  ];
  if (!dev) parts.push('Secure');

  return new Response(JSON.stringify({ ok: true, xcsrf }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': parts.join('; ')
    }
  });
}
