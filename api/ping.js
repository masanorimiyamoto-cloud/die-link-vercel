export const config = { runtime: "edge" };

export default async function handler(req) {
  return new Response(JSON.stringify({ ok: true, pong: Date.now() }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
