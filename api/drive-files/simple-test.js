// api/simple-google-test.js
const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  try {
    // 1. 環境変数チェック
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return res.json({ error: '環境変数がありません' });
    }
    
    // 2. JSONパースチェック
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      return res.json({ error: 'JSONパースエラー', message: e.message });
    }
    
    // 3. 最小限の認証テスト
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    
    res.json({ 
      success: true, 
      message: 'Google認証成功',
      clientEmail: serviceAccount.client_email 
    });
    
  } catch (error) {
    res.json({ 
      success: false, 
      error: 'エラー発生',
      message: error.message 
    });
  }
}