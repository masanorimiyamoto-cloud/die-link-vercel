// api/drive-files/[id].js
const driveService = require('../../lib/google-drive');

module.exports = async function handler(req, res) {
  const { id } = req.query;

  if (req.method !== 'GET') {
    return res.status(405).json({ 
      success: false, 
      message: 'GETメソッドのみ許可されています' 
    });
  }

  try {
    const file = await driveService.getFile(id);
    
    res.status(200).json({
      success: true,
      data: file
    });
  } catch (error) {
    console.error('ファイル詳細APIエラー:', error);
    
    if (error.code === 404) {
      return res.status(404).json({
        success: false,
        error: 'ファイルが見つかりません'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'ファイルの取得に失敗しました'
    });
  }
}