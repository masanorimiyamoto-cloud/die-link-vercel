export const config = { api: { bodyParser: false } }; // そのままでも可
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  // 本来は FormData を受けて保存/転送。ここではダミー成功
  return res.status(200).json({ ok: true });
}
