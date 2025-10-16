export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  // ここで Airtable 更新する想定。今はダミーで 200
  return res.status(200).json({ ok: true });
}
