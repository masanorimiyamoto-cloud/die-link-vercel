// lib/google-drive.js
const { google } = require('googleapis');

class GoogleDriveService {
  constructor() {
    this.drive = null;
    this.initialize();
  }

  initialize() {
    try {
      const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      
      const auth = new google.auth.JWT({
        email: serviceAccount.client_email,
        key: serviceAccount.private_key,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });

      this.drive = google.drive({ version: 'v3', auth });
      console.log('Google Drive 初期化成功');
    } catch (error) {
      console.error('Google Drive 初期化エラー:', error);
      throw error;
    }
  }

  async listFiles(folderId = '1KHoZRxD0vuiwNBJpU5jF0Up9kXxpsLz0') {
    try {
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType, webViewLink, createdTime, modifiedTime, size, fileExtension)',
        orderBy: 'name',
      });

      const files = response.data.files.map(file => {
        const isImage = file.mimeType.startsWith('image/');
        const isPDF = file.mimeType === 'application/pdf';
        
        return {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          extension: file.fileExtension,
          createdTime: file.createdTime,
          modifiedTime: file.modifiedTime,
          size: file.size,
          webViewLink: file.webViewLink,
          previewUrl: isImage 
            ? `https://drive.google.com/thumbnail?id=${file.id}&sz=w800`
            : isPDF
            ? `https://drive.google.com/file/d/${file.id}/preview`
            : null,
          thumbnailUrl: isImage 
            ? `https://drive.google.com/thumbnail?id=${file.id}&sz=w200`
            : null,
          downloadUrl: `https://drive.google.com/uc?export=download&id=${file.id}`,
          type: isImage ? 'image' : isPDF ? 'pdf' : 'other'
        };
      });

      return files;
    } catch (error) {
      console.error('ファイル一覧取得エラー:', error);
      throw error;
    }
  }

  async getFile(fileId) {
    try {
      const response = await this.drive.files.get({
        fileId: fileId,
        fields: 'id, name, mimeType, webViewLink, createdTime, modifiedTime, size, fileExtension, webContentLink'
      });

      const file = response.data;
      const isImage = file.mimeType.startsWith('image/');
      const isPDF = file.mimeType === 'application/pdf';

      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        extension: file.fileExtension,
        createdTime: file.createdTime,
        modifiedTime: file.modifiedTime,
        size: file.size,
        webViewLink: file.webViewLink,
        webContentLink: file.webContentLink,
        previewUrl: isImage 
          ? `https://drive.google.com/thumbnail?id=${file.id}&sz=w1200`
          : isPDF
          ? `https://drive.google.com/file/d/${file.id}/preview`
          : null,
        thumbnailUrl: isImage 
          ? `https://drive.google.com/thumbnail?id=${file.id}&sz=w400`
          : null,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${file.id}`,
        type: isImage ? 'image' : isPDF ? 'pdf' : 'other'
      };
    } catch (error) {
      console.error('ファイル詳細取得エラー:', error);
      throw error;
    }
  }
}

const driveService = new GoogleDriveService();
module.exports = driveService;