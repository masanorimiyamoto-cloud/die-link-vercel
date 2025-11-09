// api/simple-test.js
const { google } = require('googleapis');

export default async function handler(req, res) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    res.json({ success: true, message: '環境変数読み込み成功' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
}