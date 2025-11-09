// api/debug-drive.js
const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  try {
    console.log('=== GOOGLE DRIVE DEBUG START ===');
    
    // 環境変数の存在確認
    const hasEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    console.log('環境変数存在:', hasEnv);
    
    if (!hasEnv) {
      return res.json({ success: false, error: '環境変数が設定されていません' });
    }
    
    // JSONのパーステスト
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      console.log('JSONパース成功');
    } catch (parseError) {
      console.log('JSONパースエラー:', parseError.message);
      return res.json({ 
        success: false, 
        error: 'JSONパースエラー',
        message: parseError.message
      });
    }
    
    // 必須フィールドの確認
    const requiredFields = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email'];
    const missingFields = requiredFields.filter(field => !serviceAccount[field]);
    
    if (missingFields.length > 0) {
      console.log('必須フィールド不足:', missingFields);
      return res.json({
        success: false,
        error: '必須フィールドが不足しています',
        missingFields: missingFields
      });
    }
    
    console.log('必須フィールド確認成功');
    
    // Google Authの初期化テスト
    try {
      const auth = new google.auth.JWT({
        email: serviceAccount.client_email,
        key: serviceAccount.private_key,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
      
      console.log('Google Auth初期化成功');
      
      res.json({
        success: true,
        message: '全てのチェックが成功しました',
        serviceAccount: {
          type: serviceAccount.type,
          project_id: serviceAccount.project_id,
          client_email: serviceAccount.client_email,
          private_key_id: serviceAccount.private_key_id,
          private_key_length: serviceAccount.private_key ? serviceAccount.private_key.length : 0
        }
      });
      
    } catch (authError) {
      console.log('Google Authエラー:', authError.message);
      res.json({
        success: false,
        error: 'Google認証エラー',
        message: authError.message
      });
    }
    
  } catch (error) {
    console.log('予期せぬエラー:', error);
    res.json({
      success: false,
      error: '予期せぬエラー',
      message: error.message
    });
  }
}