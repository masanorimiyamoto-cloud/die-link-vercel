// api/debug-env.js を作成
export default async function handler(req, res) {
  res.json({
    hasServiceAccount: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    serviceAccountKeys: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 
      Object.keys(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)) : []
  });
}