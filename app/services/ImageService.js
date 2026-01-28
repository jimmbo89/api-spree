/*const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger'); // Asegúrate de que este sea tu logger configurado

const ImageService = {
  // Mover archivo a un nuevo destino
  async moveFile(file, destination) {
    const newPath = path.join(__dirname, '..', '..', 'public', destination);

    try {
      await fs.promises.rename(file.path, newPath);
      logger.info(`Imagen movida exitosamente a: ${newPath}`);
      return destination;
    } catch (err) {
      logger.error(`Error al mover la imagen: ${err.message}`);
      throw new Error('Error al mover la imagen');
    }
  },

  // Eliminar archivo si existe
  async deleteFile(filepath) {
    const fullPath = path.join(__dirname, '..', '..', 'public', filepath);

    if (fs.existsSync(fullPath)) {
      try {
        await fs.promises.unlink(fullPath);
        logger.info(`Archivo eliminado exitosamente: ${fullPath}`);
      } catch (err) {
        logger.error(`Error al eliminar el archivo: ${err.message}`);
        throw new Error('Error al eliminar el archivo');
      }
    }
  },

  // Generar nombre de archivo único
  generateFilename(folder, id, originalName) {
    const extension = path.extname(originalName);
    return `${folder}/${id}${extension}`;
  },
};

module.exports = ImageService;*/
const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger');
const { UPLOAD_BASE_PATH } = require('../../config/upload');

const ImageService = {
  _getFullPath(filepath) {
    return path.join(UPLOAD_BASE_PATH, filepath);
  },

  // ✅ Ahora compatible con memoryStorage (usa file.buffer)
  async moveFile(file, destination) {
    if (!file || !file.buffer) {
      throw new Error('Archivo inválido: se requiere un buffer');
    }

    const fullPath = this._getFullPath(destination);
    const dir = path.dirname(fullPath);

    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(fullPath, file.buffer);
      logger.info(`Archivo guardado exitosamente en: ${fullPath}`);
      return destination; // ruta relativa
    } catch (err) {
      logger.error(`Error al guardar el archivo: ${err.message}`);
      throw new Error('Error al guardar el archivo');
    }
  },

  // ✅ copyFile también debe escribir desde buffer (aunque "copiar" desde memoria es igual que guardar)
  async copyFile(file, destination) {
    // En contexto de memoryStorage, "copiar" = escribir el buffer en otra ubicación
    return this.moveFile(file, destination);
  },

  // ✅ deleteFile: sigue funcionando (opera sobre rutas ya guardadas)
  async deleteFile(filepath) {
    const fullPath = this._getFullPath(filepath);
    if (fs.existsSync(fullPath)) {
      try {
        await fs.promises.unlink(fullPath);
        logger.info(`Archivo eliminado: ${fullPath}`);
      } catch (err) {
        logger.error(`Error al eliminar archivo: ${err.message}`);
        throw new Error('Error al eliminar el archivo');
      }
    }
  },

  // ✅ deleteFileArray: también OK, porque espera objetos con .path (de registros DB)
  async deleteFileArray(files) {
    for (const file of files) {
      if (!file.path || typeof file.path !== 'string') {
        logger.warn(`Archivo omitido: path inválido: ${JSON.stringify(file)}`);
        continue;
      }
      await this.deleteFile(file.path);
    }
  },

  generateFilename(folder, id, originalName) {
    const extension = path.extname(originalName).toLowerCase();
    return `${folder}/${id}${extension}`;
  },
};

module.exports = ImageService;
