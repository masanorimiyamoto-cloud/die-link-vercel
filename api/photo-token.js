export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  const { dieId = "", purpose = "" } = req.body || {};
  // 本来は署名トークンを返す。暫定ダミー
  return res.status(200).json({ token: `dummy-${encodeURIComponent(dieId)}-${purpose}` });
}
