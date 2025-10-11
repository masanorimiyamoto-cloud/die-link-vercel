// api/loc-check.js  ← 新規
export default async function handler(req, res) {
  const { loc = "", label = "", json } = req.query || {};
  const locLabel = label || (loc ? `loc-${loc}` : "");

  // TODO: 必要ならここで Airtable からロケーション情報を取って返す
  const payload = { status: "ok", loc, locLabel };

  if (json === "1" || (req.headers.accept || "").includes("application/json")) {
    return res.status(200).json(payload);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(`
    <html><body style="font-family:sans-serif;padding:16px">
      <h1>${locLabel || "Location"}</h1>
      <p>Location: <b>${loc || "(なし)"}</b></p>
    </body></html>
  `);
}
