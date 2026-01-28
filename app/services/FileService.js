// services/FileService.js
const path = require('path');
const fs = require('fs').promises;
const logger = require('../../config/logger');
const { UPLOAD_BASE_PATH } = require('../../config/upload');

const FileService = {
  _getFullPath(filepath) {
    return path.join(UPLOAD_BASE_PATH, filepath);
  },

  // ✅ Ahora usa file.path (porque usamos diskStorage)
  async moveFile(file, destination) {
    if (!file || !file.path) {
      throw new Error('Archivo inválido: falta ruta temporal');
    }

    const currentPath = file.path;
    const newPath = this._getFullPath(destination);
    const dir = path.dirname(newPath);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.rename(currentPath, newPath);
      logger.info(`Archivo movido exitosamente a: ${newPath}`);
      return destination;
    } catch (err) {
      logger.error(`Error al mover el archivo: ${err.message}`);
      // Intentar borrar el archivo temporal si falla
      try {
        await fs.unlink(currentPath);
      } catch {}
      throw new Error('Error al mover el archivo');
    }
  },

  // copyFile: opcional, pero útil si necesitas duplicar
  async copyFile(file, destination) {
    if (!file || !file.path) {
      throw new Error('Archivo inválido: falta ruta temporal');
    }

    const currentPath = file.path;
    const newPath = this._getFullPath(destination);
    const dir = path.dirname(newPath);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(currentPath, newPath);
      logger.info(`Archivo copiado exitosamente a: ${newPath}`);
      return destination;
    } catch (err) {
      logger.error(`Error al copiar el archivo: ${err.message}`);
      throw new Error('Error al copiar el archivo');
    }
  },

  // deleteFile y deleteFileArray: sin cambios
  async deleteFile(filepath) {
    const fullPath = this._getFullPath(filepath);
    try {
      await fs.unlink(fullPath);
      logger.info(`Archivo eliminado: ${fullPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error(`Error al eliminar archivo: ${err.message}`);
        throw new Error('Error al eliminar el archivo');
      }
    }
  },

  async deleteFileArray(files) {
    for (const file of files) {
      if (!file.path || typeof file.path !== 'string') continue;
      await this.deleteFile(file.path);
    }
  },

  generateFilename(folder, id, originalName) {
    const extension = path.extname(originalName).toLowerCase();
    return `${folder}/${id}${extension}`;
  },
};

module.exports = FileService;