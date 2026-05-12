// config/upload.js
const path = require('path');
const fs = require('fs').promises;

const ENV_UPLOAD_BASE_PATH = process.env.UPLOAD_BASE_PATH;
const DEFAULT_UPLOAD_BASE_PATH = path.resolve(__dirname, '..', 'public');
const UPLOAD_BASE_PATH = ENV_UPLOAD_BASE_PATH || DEFAULT_UPLOAD_BASE_PATH;

async function getUploadPathDiagnostics(extraFolders = []) {
  const folders = [UPLOAD_BASE_PATH, ...extraFolders.map(folder => path.join(UPLOAD_BASE_PATH, folder))];
  const uniqueFolders = [...new Set(folders)];
  const folderDiagnostics = [];

  for (const folder of uniqueFolders) {
    const result = {
      path: folder,
      exists: false,
      readable: false,
      writable: false
    };

    try {
      await fs.access(folder);
      result.exists = true;
      result.readable = true;
    } catch (error) {
      result.accessError = error.message;
    }

    try {
      await fs.mkdir(folder, { recursive: true });
      result.writable = true;
      result.exists = true;
    } catch (error) {
      result.mkdirError = error.message;
    }

    folderDiagnostics.push(result);
  }

  return {
    envValue: ENV_UPLOAD_BASE_PATH || null,
    usingEnvValue: Boolean(ENV_UPLOAD_BASE_PATH),
    resolvedBasePath: UPLOAD_BASE_PATH,
    defaultBasePath: DEFAULT_UPLOAD_BASE_PATH,
    cwd: process.cwd(),
    folders: folderDiagnostics
  };
}

module.exports = {
  UPLOAD_BASE_PATH,
  DEFAULT_UPLOAD_BASE_PATH,
  getUploadPathDiagnostics
};
