// api/simple-list-test.js
const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    const drive = google.drive({ version: 'v3', auth });
    
    // 最もシンプルなリストリクエスト
    const response = await drive.files.list({
      q: "'1KHoZRxD0vuiwNBJpU5jF0Up9kXxpsLz0' in parents",
      pageSize: 5,
      fields: 'files(id, name)'
    });

    res.json({
      success: true,
      files: response.data.files,
      message: `找到 ${response.data.files.length} 個文件`
    });

  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      message: 'サービスアカウントの権限を確認してください'
    });
  }
}