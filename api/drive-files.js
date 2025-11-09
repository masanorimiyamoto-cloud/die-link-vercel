const driveService = require('../lib/google-drive');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ 
      success: false, 
      message: 'GETメソッドのみ許可されています' 
    });
  }

  try {
    const files = await driveService.listFiles();
    
    const categorized = {
      images: files.filter(f => f.type === 'image'),
      pdfs: files.filter(f => f.type === 'pdf'),
      others: files.filter(f => f.type === 'other'),
      all: files
    };

    res.status(200).json({
      success: true,
      data: categorized,
      counts: {
        total: files.length,
        images: categorized.images.length,
        pdfs: categorized.pdfs.length,
        others: categorized.others.length
      }
    });
  } catch (error) {
    console.error('APIエラー:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'ファイルの取得に失敗しました'
    });
  }
}