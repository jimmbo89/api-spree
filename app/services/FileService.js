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

  async renameFile(file, newRelativePath) {
    if (!file || !file.path) {
      throw new Error('Archivo inválido: falta ruta');
    }

    const currentFullPath = file.path; // Ruta actual: companies/1749050487659-123456789.jpg
    const newFullPath = this._getFullPath(newRelativePath); // Ruta nueva: companies/1.jpg
    const dir = path.dirname(newFullPath);

    try {
      // 1. Crear directorio si no existe
      await fs.mkdir(dir, { recursive: true });
      
      // 2. Si ya existe un archivo con el nuevo nombre, borrarlo
      try {
        await fs.access(newFullPath);
        await fs.unlink(newFullPath);
        logger.info(`Archivo existente eliminado: ${newRelativePath}`);
      } catch {
        // No existe, continuar
      }
      
      // 3. Renombrar (mover) el archivo
      await fs.rename(currentFullPath, newFullPath);
      
      // 4. Actualizar la ruta en el objeto file
      file.path = newRelativePath;
      file.filename = path.basename(newRelativePath);
      
      logger.info(`Archivo renombrado: ${currentFullPath} → ${newFullPath}`);
      return newRelativePath;
    } catch (err) {
      logger.error(`Error al renombrar archivo: ${err.message}`);
      throw new Error('Error al renombrar el archivo');
    }
  },

  async deleteFileArray(files) {
    for (const file of files) {
      if (!file.path || typeof file.path !== 'string') continue;
      await this.deleteFile(file.path);
    }
  },

  async generateFilename(folder, id, originalName) {
    const extension = path.extname(originalName).toLowerCase();
    return `${folder}/${id}${extension}`;
  },

  async generateCertificateFilename(companyId, entityId, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substr(2, 5); // 5 chars aleatorios
  
  return `${companyId}_${entityId}_${timestamp}_${randomStr}${ext}`;
}
};

module.exports = FileService;