// pages/api/line-webhook.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = req.body;

    const events = body?.events || [];
    for (const ev of events) {
      const src = ev?.source || {};
      const type = src.type; // "user" | "group" | "room"

      const userId = src.userId;
      const groupId = src.groupId;
      const roomId = src.roomId;

      console.log("=== LINE EVENT ===");
      console.log("type  :", type);
      if (userId) console.log("userId :", userId);
      if (groupId) console.log("groupId:", groupId);
      if (roomId) console.log("roomId :", roomId);
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error("WEBHOOK ERR:", e);
    return res.status(500).send("ERR");
  }
}