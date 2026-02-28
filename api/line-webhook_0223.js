export default async function handler(req, res) {
  const data = req.body || {};
  try {
    const uid = data?.events?.[0]?.source?.userId;
    console.log("YOUR_USER_ID =", uid);
    console.log("RAW =", JSON.stringify(data));
  } catch (e) {
    console.log("ERR parsing:", e);
    console.log("RAW =", JSON.stringify(data));
  }
  res.status(200).send("OK");
}