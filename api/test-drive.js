const driveService = require('../lib/google-drive');

export default async function handler(req, res) {
  try {
    console.log('Google Drive接続テスト開始...');
    const files = await driveService.listFiles();
    
    // Ta-9892.png を検索
    const targetFile = files.find(f => f.name === 'Ta-9892.png');
    
    res.json({
      success: true,
      folderId: '1KHoZRxD0vuiwNBJpU5jF0Up9kXxpsLz0',
      totalFiles: files.length,
      foundTargetFile: !!targetFile,
      targetFile: targetFile || null,
      allFiles: files.map(f => ({
        name: f.name,
        type: f.type,
        id: f.id
      }))
    });
  } catch (error) {
    console.error('テストエラー:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}